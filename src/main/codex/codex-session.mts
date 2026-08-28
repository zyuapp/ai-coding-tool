import { contextWindowLimit } from "../../domain/agent-engine.js";
import type { BackgroundProcess, ExecutionPolicy, ToolIntent } from "../../domain/run.js";
import { continuationOf, type ProviderResult, type ProviderRunInput } from "../agent/agent-provider.mjs";
import { appendCompleteMarkdown, openMarkdownBuffer, type MarkdownBuffer } from "../agent/markdown-buffer.mjs";
import { runTools } from "../agent/run-tools.mjs";
import type { ServedTools, ToolHost } from "../tools/mcp-http-host.mjs";
import { skillRoots, skillTools } from "../tools/skills.mjs";
import { AppServerError, AppServerExited, CLIENT_INFO, codexAppServer, type AppServerClient, type AppServerCommand, type BackgroundTerminal, type ExitStatus, type IncomingRequest, type NotificationParams } from "./app-server-client.mjs";
import { codexConfig, TOOL_TOKEN_ENV } from "./codex-config.mjs";
import { CodexSubagents } from "./codex-subagents.mjs";
import type { ApprovalsReviewer } from "./protocol/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "./protocol/v2/AskForApproval.js";
import type { GrantedPermissionProfile } from "./protocol/v2/GrantedPermissionProfile.js";
import type { RequestPermissionProfile } from "./protocol/v2/RequestPermissionProfile.js";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.js";
import type { ThreadItem } from "./protocol/v2/ThreadItem.js";
import type { ThreadGoal } from "./protocol/v2/ThreadGoal.js";
import type { UserInput } from "./protocol/v2/UserInput.js";

/** What the session asks of its connection. The real client fits; a scripted one can stand in for it. */
export type CodexClient = Pick<AppServerClient, "initialize" | "request" | "on" | "onRequest" | "close" | "exited">;

export type CodexConnect = (command: AppServerCommand) => CodexClient;

/** How long an interrupted turn has to come back with a result before the session is given up on. */
const INTERRUPT_GRACE_MS = 10_000;

const SIGN_IN = "Sign in to Codex to run this thread.";

/** What the thread is told beyond its prompt. Codex has no skill tool of its own, so the app's stand in. */
export const DEVELOPER_INSTRUCTIONS = "The user keeps skills: reusable instructions for particular kinds of task. Call skills_list to see them by name and description. Before a task one covers, call skill_read with its name and follow what it says. A message that starts with /name asks for that skill. This app's own surfaces are reached only through the aicodingtool tools: its browser panel with browser_open, browser_read and browser_screenshot, its terminal with terminal_read, its other threads with list_threads and read_thread, and repeating or scheduled work with schedule.";

type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export type CodexPolicy = { approvalPolicy: AskForApproval; sandbox: CodexSandbox; approvalsReviewer: ApprovalsReviewer };

/** Codex has no plan mode, so a plan run is held to what a confirm run may do. */
export function codexPolicy(policy: ExecutionPolicy): CodexPolicy {
  switch (policy) {
    case "confirm":
    case "plan":
      return { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };
    case "allow-edits":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" };
    case "autonomous":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "auto_review" };
    case "bypass":
      return { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" };
  }
}

const sandboxPolicies: Record<CodexSandbox, SandboxPolicy> = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  "danger-full-access": { type: "dangerFullAccess" },
};

/** What a run says, as the app server takes it. */
function text(prompt: string): UserInput {
  return { type: "text", text: prompt, text_elements: [] };
}

function goalCommand(prompt: string) {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (!match) return null;
  const argument = match[1]?.trim() ?? "";
  return argument.toLowerCase() === "clear" ? { type: "clear" as const } : argument ? { type: "set" as const, objective: argument } : { type: "get" as const };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstLine(message: string) {
  return message.split("\n", 1)[0] ?? message;
}

/** What went wrong, without the method the server was answering when it did. */
function reasonOf(error: unknown) {
  if (error instanceof AppServerError) return firstLine(error.message.slice(error.method.length + 2));
  return firstLine(error instanceof Error ? error.message : String(error));
}

function describeExit(exit: ExitStatus) {
  return firstLine(exit.stderr) || (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`);
}

function startFailure(exit: ExitStatus) {
  return `Codex could not start: ${describeExit(exit)}`;
}

/** Why the session could not open, worded for the run that asked. `lost` says the continuation itself is gone. */
class OpenFailure extends Error {
  readonly lost: boolean;
  constructor(message: string, lost = false) {
    super(message);
    this.lost = lost;
  }
}

function openFailure(error: unknown) {
  if (error instanceof OpenFailure) return error.message;
  if (error instanceof AppServerExited) return startFailure(error.exit);
  return `Codex could not start: ${reasonOf(error)}`;
}

/** What an item the agent started is about, in the shape the thread records tools in. Nothing for the kinds it drops. */
export function intentOf(item: ThreadItem): ToolIntent | undefined {
  switch (item.type) {
    case "commandExecution":
      return { toolId: item.id, name: "command_execution", input: { command: item.command, cwd: item.cwd } };
    case "fileChange": {
      const path = item.changes[0]?.path;
      const changes = item.changes.map((change) => ({ path: change.path, kind: change.kind.type, diff: change.diff }));
      return { toolId: item.id, name: "file_change", input: { path: path ?? "", changes }, ...(path === undefined ? {} : { writePath: path }) };
    }
    case "mcpToolCall":
      return { toolId: item.id, name: item.tool, input: isRecord(item.arguments) ? item.arguments : { arguments: item.arguments } };
    case "webSearch":
      return { toolId: item.id, name: "web_search", input: { query: item.query } };
    default:
      return undefined;
  }
}

/** Grants what was asked for, whole: the question is yes or no, not which part. */
function granted(requested: RequestPermissionProfile): GrantedPermissionProfile {
  return { ...(requested.network ? { network: requested.network } : {}), ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}) };
}

/** The tool an MCP approval prompt names, which the prompt carries only in its wording. */
function toolNamed(message: string) {
  return /run tool "([^"]+)"/.exec(message)?.[1];
}

/** One turn a run asked for, and everything it builds up as it streams. */
type Turn = {
  input: ProviderRunInput;
  settle: (result: ProviderResult) => void;
  release: () => void;
  /** Named by the server once turn/start returns; an interrupt asked for before then waits on it. */
  turnId?: string;
  interruptWanted?: boolean;
  /** Assistant text still buffered per item, so a half-written block never ships. */
  streamed: Map<string, MarkdownBuffer>;
  /** Tool items started and not yet completed, by id: what an approval for one of them is about. */
  items: Map<string, ThreadItem>;
  /** The last error the server said it would not retry, kept for the turn's failure. */
  failure?: string;
  /** The context measured before this compaction began, before usage notifications can replace it. */
  compactionPreTokens?: number;
  compacting?: boolean;
  /** A native review runs on this detached thread while the app run remains on its parent. */
  reviewThreadId?: string;
  reviewOutput?: string;
  reviewFinalizing?: boolean;
};

type ReviewOperation = Extract<NonNullable<ProviderRunInput["operation"]>, { type: "review" }>;

function reviewDescription(target: ReviewOperation["target"]) {
  switch (target.type) {
    case "uncommittedChanges": return "Review uncommitted changes";
    case "baseBranch": return `Review against ${target.branch}`;
    case "commit": return `Review commit ${target.sha}`;
    case "custom": return firstLine(target.instructions);
  }
}

/**
 * One live Codex thread, kept across turns. The app server process belongs to the session, so a
 * second turn neither pays for a new process nor resumes the thread from disk. Each turn takes the
 * session in turn, and ends on the server's own turn/completed.
 */
export class CodexSession {
  private client: CodexClient | null = null;
  /** The app's tools as this session's process reaches them; released with the session. */
  private served: ServedTools | null = null;
  private opening: Promise<void> | null = null;
  private turn: Turn | null = null;
  private subagents: CodexSubagents | null = null;
  private ended = false;
  /** How the session ended, kept for a run that arrives after it is already over. */
  private outcome: ProviderResult | null = null;
  /** Whether the thread's id has been reported to a run yet. Once is enough: the id never changes. */
  private announced = false;
  /** The context the last request carried, which is what a compaction is measured from. */
  private lastTokens = 0;
  private goalActive = false;
  private reportGoal: ProviderRunInput["reportGoal"] = () => {};
  private reportBackground: ProviderRunInput["reportBackground"] = () => {};
  /** The whole process set last read from this thread's app-server session. */
  private backgroundProcesses: BackgroundProcess[] = [];
  /** A newer read supersedes an older one that is still paging through the server. */
  private backgroundRead = 0;
  /** What Codex calls this thread. A later run resumes it by this id. */
  threadId?: string;

  constructor(
    readonly key: string,
    private readonly connect: CodexConnect,
    private readonly host: ToolHost,
    private readonly onEnded: () => void,
    private readonly onRested: () => void,
  ) {}

  /** A turn is in flight, so the session owes an answer before it can take another. */
  get answering() {
    return this.turn !== null;
  }

  /** Closing the app server would stop child turns and background terminals, so either keeps it warm. */
  get busy() {
    return this.answering || Boolean(this.subagents?.busy) || this.backgroundProcesses.length > 0;
  }

  get live() {
    return !this.ended;
  }

  /** Whether this session is the one a run means to continue. */
  continues(continuation: string | undefined) {
    return continuation === undefined || continuation === this.threadId;
  }

  run(input: ProviderRunInput): Promise<ProviderResult> {
    if (this.ended) return Promise.resolve(this.outcome ?? { status: "failed", message: "The Codex session ended before the run could start." });
    return new Promise<ProviderResult>((resolve) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const interrupt = () => {
        this.interrupt(turn);
        grace = setTimeout(() => {
          this.settle({ status: "cancelled" });
          this.close();
        }, INTERRUPT_GRACE_MS);
        grace.unref?.();
      };
      const turn: Turn = {
        input,
        settle: resolve,
        streamed: new Map(),
        items: new Map(),
        release: () => {
          clearTimeout(grace);
          input.abortController.signal.removeEventListener("abort", interrupt);
        },
      };
      /** The turn is the session's before anything is awaited, so a process that dies still answers it. */
      this.turn = turn;
      if (input.abortController.signal.aborted) {
        this.settle({ status: "cancelled" });
        return;
      }
      input.abortController.signal.addEventListener("abort", interrupt, { once: true });
      void this.begin(turn);
    });
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    this.backgroundRead += 1;
    this.backgroundProcesses = [];
    this.reportBackground({ type: "background.changed", processes: [] });
    this.reportGoal({ type: "goal.changed", goal: null });
    this.settle({ status: "cancelled" });
    this.subagents?.close();
    this.subagents = null;
    void this.client?.close();
    this.client = null;
    this.served?.release();
    this.served = null;
    this.onEnded();
  }

  /** Stops one terminal owned by this thread, then republishes what the server still has. */
  stopProcess(processId: string) {
    const client = this.client;
    const threadId = this.threadId;
    if (!client || !threadId) return;
    void client.request("thread/backgroundTerminals/terminate", { threadId, processId })
      .then(() => this.refreshBackgroundProcesses())
      .catch(() => this.refreshBackgroundProcesses());
  }

  private async begin(turn: Turn) {
    try {
      await (this.opening ??= this.open(turn.input));
    } catch (error) {
      if (this.turn === turn) {
        if (error instanceof OpenFailure && error.lost) turn.input.emit({ type: "continuation-lost" });
        this.settle({ status: "failed", message: openFailure(error) });
      }
      this.close();
      return;
    }
    const client = this.client;
    const threadId = this.threadId;
    if (this.turn !== turn || !client || !threadId) return;
    if (!this.announced) {
      this.announced = true;
      turn.input.emit({ type: "continuation", continuation: { provider: "codex", value: threadId } });
    }
    if (turn.input.operation?.type === "compact") {
      await this.beginCompaction(turn, client, threadId);
      return;
    }
    if (turn.input.operation?.type === "review") {
      await this.beginReview(turn, client, threadId);
      return;
    }
    const goal = goalCommand(turn.input.prompt);
    if (goal) {
      const keepGoing = await this.beginGoal(turn, client, threadId, goal);
      if (!keepGoing) return;
    }
    const policy = codexPolicy(turn.input.policy);
    let started: { turn: { id: string } };
    try {
      started = await client.request("turn/start", {
        threadId,
        input: [text(goal?.type === "set" ? goal.objective : turn.input.prompt)],
        model: turn.input.model,
        effort: turn.input.effort,
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandboxPolicy: sandboxPolicies[policy.sandbox],
      });
    } catch (error) {
      if (this.turn === turn) this.settle({ status: "failed", message: `Codex could not start the turn: ${reasonOf(error)}` });
      return;
    }
    turn.turnId = started.turn.id;
    if (this.turn !== turn) return;
    /** A run that went away while the server was starting its turn leaves nothing running behind it. */
    if (turn.interruptWanted) {
      this.interrupt(turn);
      return;
    }
    await this.drainSteering(turn);
  }

  private async beginGoal(turn: Turn, client: CodexClient, threadId: string, command: NonNullable<ReturnType<typeof goalCommand>>) {
    try {
      if (command.type === "clear") {
        await client.request("thread/goal/clear", { threadId });
        this.goalActive = false;
        turn.input.reportGoal({ type: "goal.changed", goal: null });
        this.settle({ status: "succeeded" });
        return false;
      }
      if (command.type === "get") {
        const result = await client.request("thread/goal/get", { threadId });
        this.reportCodexGoal(result.goal);
        this.settle({ status: "succeeded" });
        return false;
      }
      const result = await client.request("thread/goal/set", { threadId, objective: command.objective });
      this.reportCodexGoal(result.goal);
      return true;
    } catch (error) {
      if (this.turn === turn) this.settle({ status: "failed", message: `Codex could not update the goal: ${reasonOf(error)}` });
      return false;
    }
  }

  private reportCodexGoal(goal: ThreadGoal | null) {
    this.goalActive = goal?.status === "active";
    this.reportGoal({
      type: "goal.changed",
      goal: !goal || goal.status === "complete" ? null : {
        objective: goal.objective,
        status: goal.status === "active" ? "active" : "blocked",
      },
    });
  }

  /** Manual compaction is a thread operation, not an empty model turn. */
  private async beginCompaction(turn: Turn, client: CodexClient, threadId: string) {
    this.setCompacting(turn, true);
    try {
      await client.request("thread/compact/start", { threadId });
    } catch (error) {
      if (this.turn !== turn) return;
      this.setCompacting(turn, false, `Could not compact context: ${reasonOf(error)}`);
      this.settle({ status: "failed" });
    }
  }

  /** A review forks a native Codex thread and reports it through the same session roster as subagents. */
  private async beginReview(turn: Turn, client: CodexClient, threadId: string) {
    const operation = turn.input.operation;
    if (operation?.type !== "review") return;
    let started: { turn: { id: string }; reviewThreadId: string };
    try {
      started = await client.request("review/start", { threadId, target: operation.target, delivery: "detached" });
    } catch (error) {
      if (this.turn === turn) this.settle({ status: "failed", message: `Codex could not start the review: ${reasonOf(error)}` });
      return;
    }
    turn.turnId = started.turn.id;
    turn.reviewThreadId = started.reviewThreadId;
    if (this.turn !== turn) return;
    this.subagents?.registerReview(started.reviewThreadId, reviewDescription(operation.target));
    this.reconcileReview(turn);
    if (turn.interruptWanted) {
      this.interrupt(turn);
      return;
    }
    await this.drainSteering(turn, started.reviewThreadId);
  }

  /**
   * Spawns the server and puts the thread on it: a new one, the one the run continues, or a fork of
   * it. The app's tools are served first, since the process connects to them as the thread starts.
   */
  private async open(seed: ProviderRunInput) {
    this.reportBackground = seed.reportBackground;
    this.reportBackground({ type: "background.changed", processes: [] });
    this.reportGoal = seed.reportGoal;
    this.reportGoal({ type: "goal.changed", goal: null });
    const tools = [...runTools(seed).flatMap((set) => set.tools), ...skillTools(skillRoots(seed))];
    if (tools.length) {
      const served = await this.host.serve(tools);
      if (this.ended) {
        served.release();
        throw new OpenFailure("The Codex session ended before the run could start.");
      }
      this.served = served;
    }
    const env = this.served ? { ...process.env, [TOOL_TOKEN_ENV]: this.served.token } : undefined;
    const client = this.connect(codexAppServer(codexConfig(seed, this.served ?? undefined), { cwd: seed.workspaceRoot, ...(env ? { env } : {}) }));
    this.client = client;
    const subagents = this.subagents = new CodexSubagents(seed.reportSubagent, (busy) => {
      if (!busy && !this.answering) this.onRested();
    });
    client.on("thread/started", (params) => { subagents.threadStarted(params); });
    client.on("thread/status/changed", (params) => { subagents.threadStatusChanged(params); });
    client.on("thread/closed", (params) => { subagents.threadClosed(params); });
    client.on("turn/started", (params) => {
      if (!subagents.turnStarted(params) && params.threadId === this.threadId && this.turn && this.goalActive) this.turn.turnId = params.turn.id;
    });
    client.on("thread/goal/updated", (params) => {
      if (params.threadId === this.threadId) this.reportCodexGoal(params.goal);
    });
    client.on("thread/goal/cleared", (params) => {
      if (params.threadId !== this.threadId) return;
      this.goalActive = false;
      this.reportGoal({ type: "goal.changed", goal: null });
    });
    client.on("item/started", (params) => {
      if (!subagents.itemStarted(params)) this.receiveStarted(params.item);
    });
    client.on("item/agentMessage/delta", (params) => {
      if (!subagents.shouldSuppress(params.threadId)) this.receiveDelta(params.itemId, params.delta);
    });
    client.on("item/completed", (params) => {
      const child = subagents.itemCompleted(params);
      this.receiveReviewItem(params.threadId, params.item);
      if (!child) this.receiveCompleted(params.item);
      if (params.threadId === this.threadId && params.item.type === "commandExecution" && this.backgroundProcesses.length) {
        void this.refreshBackgroundProcesses();
      }
    });
    client.on("thread/tokenUsage/updated", (params) => {
      if (!subagents.tokenUsageUpdated(params)) this.receiveUsage(params.tokenUsage.last.totalTokens, params.tokenUsage.modelContextWindow);
    });
    client.on("error", (params) => {
      if (!subagents.error(params) && this.turn && !params.willRetry) this.turn.failure = params.error.message;
    });
    client.on("turn/completed", (params) => {
      const child = subagents.turnCompleted(params);
      if (!this.receiveReviewTurnCompleted(params.threadId, params.turn) && !child) this.receiveTurnCompleted(params.turn);
    });
    client.onRequest((request) => this.answer(request));
    void client.exited.then((exit) => this.exited(exit));
    await client.initialize(CLIENT_INFO);
    const account = await client.request("account/read", { refreshToken: false });
    if (!account.account) throw new OpenFailure(SIGN_IN);
    const policy = codexPolicy(seed.policy);
    const settings = { cwd: seed.workspaceRoot, model: seed.model, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, approvalsReviewer: policy.approvalsReviewer, config: { model_reasoning_effort: seed.effort }, developerInstructions: DEVELOPER_INSTRUCTIONS };
    const continuation = continuationOf(seed);
    const started = continuation === undefined
      ? await client.request("thread/start", settings)
      : seed.forkContinuation
        ? await client.request("thread/fork", { threadId: continuation, ...settings })
        : await client.request("thread/resume", { threadId: continuation, ...settings }).catch((error: unknown) => {
          /** Only the server's own refusal says the thread is gone; a server that died may still have it. */
          if (error instanceof AppServerError) throw new OpenFailure(`Codex could not continue this thread (${reasonOf(error)}). Start a new thread to keep going.`, true);
          throw error;
        });
    this.threadId = started.thread.id;
    subagents.setRootThreadId(this.threadId);
  }

  private interrupt(turn: Turn) {
    if (!turn.turnId) {
      turn.interruptWanted = true;
      return;
    }
    if (!this.client || !this.threadId) return;
    const children = this.subagents?.liveTurns ?? [];
    for (const child of children) {
      void this.client.request("turn/interrupt", child).catch(() => {});
    }
    if (turn.reviewThreadId) {
      if (!children.some((child) => child.threadId === turn.reviewThreadId && child.turnId === turn.turnId)) {
        void this.client.request("turn/interrupt", { threadId: turn.reviewThreadId, turnId: turn.turnId }).catch(() => {});
      }
      return;
    }
    void this.client.request("turn/interrupt", { threadId: this.threadId, turnId: turn.turnId }).catch(() => {});
  }

  /**
   * Feeds one run's steered messages into the turn already going. One the server refuses stays
   * queued on the thread, which sends it as the next turn once this run settles.
   */
  private async drainSteering(turn: Turn, threadId = this.threadId) {
    for (let steer = await turn.input.steering.next(); steer; steer = await turn.input.steering.next()) {
      const client = this.client;
      if (this.turn !== turn || !client || !threadId || !turn.turnId) return;
      try {
        if (goalCommand(steer.prompt)?.type === "clear") {
          await client.request("thread/goal/clear", { threadId });
          this.goalActive = false;
          turn.input.reportGoal({ type: "goal.changed", goal: null });
          turn.input.emit({ type: "steered", messageId: steer.messageId });
          continue;
        }
        await client.request("turn/steer", { threadId, input: [text(steer.prompt)], expectedTurnId: turn.turnId });
        turn.input.emit({ type: "steered", messageId: steer.messageId });
      } catch {
        continue;
      }
    }
  }

  private settle(result: ProviderResult) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    turn.release();
    turn.settle(turn.input.abortController.signal.aborted ? { status: "cancelled" } : result);
  }

  private exited(exit: ExitStatus) {
    if (this.ended) return;
    this.outcome = { status: "failed", message: this.threadId ? `Codex stopped: ${describeExit(exit)}` : startFailure(exit) };
    this.settle(this.outcome);
    this.close();
  }

  private receiveStarted(item: ThreadItem) {
    const turn = this.turn;
    if (!turn) return;
    if (item.type === "contextCompaction") {
      this.setCompacting(turn, true);
      return;
    }
    const intent = intentOf(item);
    if (!intent) return;
    turn.items.set(item.id, item);
    turn.input.emit({ type: "tool", intent });
  }

  private receiveDelta(itemId: string, delta: string) {
    const turn = this.turn;
    if (!turn) return;
    let buffer = turn.streamed.get(itemId);
    if (!buffer) turn.streamed.set(itemId, buffer = openMarkdownBuffer());
    const complete = appendCompleteMarkdown(buffer, delta);
    if (complete) turn.input.emit({ type: "assistant", messageId: itemId, text: complete, append: true });
    turn.input.emit({ type: "assistant-tail", messageId: itemId, text: buffer.text });
  }

  private receiveCompleted(item: ThreadItem) {
    const turn = this.turn;
    if (!turn) return;
    if (item.type === "agentMessage") {
      const buffer = turn.streamed.get(item.id);
      /** A message that streamed is already on screen but for its tail; one that did not arrives whole. */
      if (buffer) {
        turn.streamed.delete(item.id);
        if (buffer.text) turn.input.emit({ type: "assistant", messageId: item.id, text: buffer.text, append: true });
      } else if (item.text.trim()) {
        turn.input.emit({ type: "assistant", messageId: item.id, text: item.text });
      }
    } else if (item.type === "contextCompaction") {
      const manual = turn.input.operation?.type === "compact";
      turn.input.emit({ type: "compaction", trigger: manual ? "manual" : "auto", preTokens: turn.compactionPreTokens ?? this.lastTokens });
      this.setCompacting(turn, false);
      if (manual) this.settle({ status: "succeeded" });
    } else {
      turn.items.delete(item.id);
    }
  }

  /** Copies the detached review's final report into the visible parent transcript once. */
  private receiveReviewItem(threadId: string, item: ThreadItem) {
    const turn = this.turn;
    if (!turn || turn.reviewThreadId !== threadId || item.type !== "exitedReviewMode") return;
    const output = item.review.trim();
    if (!output || turn.reviewOutput !== undefined) return;
    turn.reviewOutput = output;
    turn.input.emit({ type: "assistant", messageId: `review:${threadId}`, text: output });
  }

  /** Replays review traffic that raced ahead of the `review/start` response. */
  private reconcileReview(turn: Turn) {
    const threadId = turn.reviewThreadId;
    if (!threadId) return;
    const state = this.subagents?.reviewState(threadId);
    if (state?.output) this.receiveReviewItem(threadId, { type: "exitedReviewMode", id: turn.turnId ?? threadId, review: state.output });
    if (state?.completed) this.finishReview(turn, state.completed);
  }

  private receiveReviewTurnCompleted(threadId: string, completed: NotificationParams<"turn/completed">["turn"]) {
    const turn = this.turn;
    if (!turn || turn.reviewThreadId !== threadId || (turn.turnId !== undefined && turn.turnId !== completed.id)) return false;
    this.finishReview(turn, completed);
    return true;
  }

  /** Keeps the parent Codex history aligned with the review result shown in the app. */
  private finishReview(turn: Turn, completed: { id: string; status: string; error?: { message: string } | null; message?: string }) {
    if (this.turn !== turn || turn.reviewFinalizing) return;
    turn.reviewFinalizing = true;
    void (async () => {
      if (completed.status === "completed" && turn.reviewOutput && this.client && this.threadId) {
        await this.client.request("thread/inject_items", {
          threadId: this.threadId,
          items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: turn.reviewOutput }] }],
        }).catch(() => {});
      }
      if (this.turn !== turn) return;
      if (completed.status === "completed") this.settle({ status: "succeeded" });
      else if (completed.status === "interrupted") this.settle({ status: "cancelled" });
      else this.settle({ status: "failed", message: completed.error?.message ?? completed.message ?? turn.failure ?? "Codex could not finish the review." });
    })();
  }

  private setCompacting(turn: Turn, compacting: boolean, error?: string) {
    if (this.turn !== turn) return;
    if (compacting && turn.compactionPreTokens === undefined) {
      turn.compactionPreTokens = turn.input.operation?.type === "compact" ? turn.input.operation.preTokens : this.lastTokens;
    }
    if (turn.compacting === compacting && error === undefined) return;
    turn.compacting = compacting;
    turn.input.emit({ type: "compaction-status", compacting, ...(error ? { error } : {}) });
  }

  /** The window the server reports is the model's own; the catalogue's stands in while it reports none. */
  private receiveUsage(tokens: number, contextWindow: number | null) {
    const turn = this.turn;
    if (!turn) return;
    this.lastTokens = tokens;
    turn.input.emit({ type: "usage", tokens, limit: contextWindow ?? contextWindowLimit("codex", turn.input.model), model: turn.input.model });
  }

  private receiveTurnCompleted(completed: NotificationParams<"turn/completed">["turn"]) {
    const turn = this.turn;
    if (!turn || (turn.turnId !== undefined && turn.turnId !== completed.id)) return;
    void this.finishTurn(turn, completed);
  }

  /** Reads terminals before settling, so the session cannot be reclaimed while new work is running. */
  private async finishTurn(turn: Turn, completed: NotificationParams<"turn/completed">["turn"]) {
    await this.refreshBackgroundProcesses();
    if (this.turn !== turn) return;
    if (completed.status === "completed" && this.goalActive) return;
    if (completed.status === "completed") this.settle({ status: "succeeded" });
    else if (completed.status === "interrupted") this.settle({ status: "cancelled" });
    else if (completed.status === "failed") this.settle({ status: "failed", message: completed.error?.message ?? turn.failure ?? "Codex could not finish the turn." });
  }

  /** Reads every page because the Session Panel treats each provider report as the complete set. */
  private async refreshBackgroundProcesses() {
    const client = this.client;
    const threadId = this.threadId;
    if (!client || !threadId || this.ended) return;
    const read = ++this.backgroundRead;
    const found: BackgroundProcess[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    try {
      do {
        const page: { data: BackgroundTerminal[]; nextCursor: string | null } = await client.request("thread/backgroundTerminals/list", { threadId, cursor, limit: 100 });
        if (read !== this.backgroundRead || this.client !== client || this.threadId !== threadId || this.ended) return;
        found.push(...page.data.map((terminal) => ({
          id: terminal.processId,
          kind: "shell" as const,
          description: terminal.command || "Background shell",
        })));
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) return;
        if (cursor) cursors.add(cursor);
      } while (cursor);
    } catch {
      return;
    }
    this.replaceBackgroundProcesses(found);
  }

  private replaceBackgroundProcesses(processes: BackgroundProcess[]) {
    const hadProcesses = this.backgroundProcesses.length > 0;
    this.backgroundProcesses = processes;
    this.reportBackground({ type: "background.changed", processes });
    if (hadProcesses && !processes.length && !this.answering && !this.subagents?.busy) this.onRested();
  }

  /** Whether the run allows what the server is asking. Nothing is allowed on a session with no run to ask. */
  private async allowed(intent: ToolIntent) {
    const turn = this.turn;
    if (!turn) return false;
    if (turn.input.policy === "bypass") return true;
    return await turn.input.authorize(intent) === "allow";
  }

  /** The pending item addressed by a server request, kept separate across concurrent threads. */
  private pendingItem(threadId: string, itemId: string) {
    if (threadId === this.threadId) return this.turn?.items.get(itemId);
    return this.subagents?.pendingItem(threadId, itemId);
  }

  /** The newest call one thread has going against one MCP server, which is what its prompt is about. */
  private pendingMcpCall(threadId: string, server: string) {
    let found: Extract<ThreadItem, { type: "mcpToolCall" }> | undefined;
    if (threadId === this.threadId) {
      for (const item of this.turn?.items.values() ?? []) {
        if (item.type === "mcpToolCall" && item.server === server) found = item;
      }
      return found;
    }
    return this.subagents?.pendingMcpCall(threadId, server);
  }

  /** Every question the server asks goes to the run's user; a denial declines rather than cancels, so the turn goes on. */
  private answer(request: IncomingRequest) {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const { threadId, itemId, command, cwd, reason } = request.params;
        const started = this.pendingItem(threadId, itemId);
        const input = {
          command: command ?? (started?.type === "commandExecution" ? started.command : ""),
          ...(cwd ? { cwd } : {}),
          ...(reason ? { reason } : {}),
        };
        void this.allowed({ toolId: itemId, name: "command_execution", input }).then((allow) => request.respond({ decision: allow ? "accept" : "decline" }));
        return;
      }
      case "item/fileChange/requestApproval": {
        const { threadId, itemId, reason } = request.params;
        const started = this.pendingItem(threadId, itemId);
        const intent = (started && intentOf(started)) ?? { toolId: itemId, name: "file_change", input: {} };
        const input = { ...(isRecord(intent.input) ? intent.input : {}), ...(reason ? { reason } : {}) };
        void this.allowed({ ...intent, input }).then((allow) => request.respond({ decision: allow ? "accept" : "decline" }));
        return;
      }
      case "item/permissions/requestApproval": {
        const { itemId, cwd, reason, permissions } = request.params;
        const input = { cwd, ...(reason ? { reason } : {}), permissions };
        void this.allowed({ toolId: itemId, name: "permissions", input }).then((allow) => request.respond({ permissions: allow ? granted(permissions) : {}, scope: "turn" }));
        return;
      }
      case "item/tool/requestUserInput": {
        const { itemId, questions } = request.params;
        void this.allowed({ toolId: itemId, name: "request_user_input", input: { questions } }).then((allow) => {
          if (allow) request.respond({ answers: {} });
          else request.fail({ code: -32000, message: "The user declined to answer." });
        });
        return;
      }
      case "mcpServer/elicitation/request": {
        const params = request.params;
        const meta = isRecord(params._meta) ? params._meta : undefined;
        /** Only a tool-call approval is a yes-or-no question; a form or a link needs an answer nobody here can give. */
        if (meta?.codex_approval_kind !== "mcp_tool_call") {
          request.respond({ action: "decline", content: null, _meta: null });
          return;
        }
        const started = this.pendingMcpCall(params.threadId, params.serverName);
        const intent = (started && intentOf(started)) ?? {
          toolId: `${params.serverName}:${String(request.id)}`,
          name: toolNamed(params.message) ?? "mcp_tool_call",
          input: isRecord(meta.tool_params) ? meta.tool_params : {},
        };
        void this.allowed(intent).then((allow) => request.respond(allow ? { action: "accept", content: {}, _meta: null } : { action: "decline", content: null, _meta: null }));
        return;
      }
      default:
        request.fail({ code: -32601, message: `${request.method} is not supported.` });
    }
  }
}
