import { contextWindowLimit } from "../../domain/agent-engine.js";
import type { ExecutionPolicy, ToolIntent } from "../../domain/run.js";
import type { ProviderResult, ProviderRunInput } from "../agent/agent-provider.mjs";
import { appendCompleteMarkdown, openMarkdownBuffer, type MarkdownBuffer } from "../agent/markdown-buffer.mjs";
import { runTools } from "../agent/run-tools.mjs";
import type { ServedTools, ToolHost } from "../tools/mcp-http-host.mjs";
import { AppServerError, AppServerExited, codexAppServer, type AppServerClient, type AppServerCommand, type ExitStatus, type IncomingRequest, type NotificationParams } from "./app-server-client.mjs";
import { codexConfig, TOOL_TOKEN_ENV } from "./codex-config.mjs";
import type { ClientInfo } from "./protocol/ClientInfo.js";
import type { ApprovalsReviewer } from "./protocol/v2/ApprovalsReviewer.js";
import type { AskForApproval } from "./protocol/v2/AskForApproval.js";
import type { GrantedPermissionProfile } from "./protocol/v2/GrantedPermissionProfile.js";
import type { RequestPermissionProfile } from "./protocol/v2/RequestPermissionProfile.js";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.js";
import type { ThreadItem } from "./protocol/v2/ThreadItem.js";
import type { UserInput } from "./protocol/v2/UserInput.js";

/** What the session asks of its connection. The real client fits; a scripted one can stand in for it. */
export type CodexClient = Pick<AppServerClient, "initialize" | "request" | "on" | "onRequest" | "close" | "exited">;

export type CodexConnect = (command: AppServerCommand) => CodexClient;

const CLIENT_INFO: ClientInfo = { name: "aicodingtool", title: "AICodingTool", version: "1" };

/** How long an interrupted turn has to come back with a result before the session is given up on. */
const INTERRUPT_GRACE_MS = 10_000;

const SIGN_IN = "Sign in to Codex to run this thread.";

type CodexSandbox = "read-only" | "workspace-write";

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
  }
}

const sandboxPolicies: Record<CodexSandbox, SandboxPolicy> = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
};

/** What a run says, as the app server takes it. */
function text(prompt: string): UserInput {
  return { type: "text", text: prompt, text_elements: [] };
}

function continuationOf(input: ProviderRunInput) {
  return input.continuation?.provider === "codex" ? input.continuation.value : undefined;
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
};

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
  private ended = false;
  /** How the session ended, kept for a run that arrives after it is already over. */
  private outcome: ProviderResult | null = null;
  /** Whether the thread's id has been reported to a run yet. Once is enough: the id never changes. */
  private announced = false;
  /** The context the last request carried, which is what a compaction is measured from. */
  private lastTokens = 0;
  /** What Codex calls this thread. A later run resumes it by this id. */
  threadId?: string;

  constructor(readonly key: string, private readonly connect: CodexConnect, private readonly host: ToolHost, private readonly onEnded: () => void) {}

  /** A turn is in flight, so the session owes an answer before it can take another. */
  get answering() {
    return this.turn !== null;
  }

  /** Codex leaves nothing running behind a turn, so a session with no turn going is idle. */
  get busy() {
    return this.answering;
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
    this.settle({ status: "cancelled" });
    void this.client?.close();
    this.client = null;
    this.served?.release();
    this.served = null;
    this.onEnded();
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
    const policy = codexPolicy(turn.input.policy);
    let started: { turn: { id: string } };
    try {
      started = await client.request("turn/start", {
        threadId,
        input: [text(turn.input.prompt)],
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
    /** A run that went away while the server was starting its turn leaves nothing running behind it. */
    if (this.turn !== turn || turn.interruptWanted) {
      this.interrupt(turn);
      return;
    }
    await this.drainSteering(turn);
  }

  /**
   * Spawns the server and puts the thread on it: a new one, the one the run continues, or a fork of
   * it. The app's tools are served first, since the process connects to them as the thread starts.
   */
  private async open(seed: ProviderRunInput) {
    const tools = runTools(seed).flatMap((set) => set.tools);
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
    client.on("item/started", (params) => this.receiveStarted(params.item));
    client.on("item/agentMessage/delta", (params) => this.receiveDelta(params.itemId, params.delta));
    client.on("item/completed", (params) => this.receiveCompleted(params.item));
    client.on("thread/tokenUsage/updated", (params) => this.receiveUsage(params.tokenUsage.last.totalTokens));
    client.on("error", (params) => {
      if (this.turn && !params.willRetry) this.turn.failure = params.error.message;
    });
    client.on("turn/completed", (params) => this.receiveTurnCompleted(params.turn));
    client.onRequest((request) => this.answer(request));
    void client.exited.then((exit) => this.exited(exit));
    await client.initialize(CLIENT_INFO);
    const account = await client.request("account/read", { refreshToken: false });
    if (!account.account) throw new OpenFailure(SIGN_IN);
    const policy = codexPolicy(seed.policy);
    const settings = { cwd: seed.workspaceRoot, model: seed.model, approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, approvalsReviewer: policy.approvalsReviewer };
    const continuation = continuationOf(seed);
    const started = continuation === undefined
      ? await client.request("thread/start", settings)
      : seed.forkContinuation
        ? await client.request("thread/fork", { threadId: continuation, ...settings })
        : await client.request("thread/resume", { threadId: continuation, ...settings }).catch((error: unknown) => {
          throw new OpenFailure(`Codex could not continue this thread (${reasonOf(error)}). Start a new thread to keep going.`, true);
        });
    this.threadId = started.thread.id;
  }

  private interrupt(turn: Turn) {
    if (!turn.turnId) {
      turn.interruptWanted = true;
      return;
    }
    if (!this.client || !this.threadId) return;
    void this.client.request("turn/interrupt", { threadId: this.threadId, turnId: turn.turnId }).catch(() => {});
  }

  /**
   * Feeds one run's steered messages into the turn already going. One the server refuses stays
   * queued on the thread, which sends it as the next turn once this run settles.
   */
  private async drainSteering(turn: Turn) {
    for (let steer = await turn.input.steering.next(); steer; steer = await turn.input.steering.next()) {
      const client = this.client;
      if (this.turn !== turn || !client || !this.threadId || !turn.turnId) return;
      try {
        await client.request("turn/steer", { threadId: this.threadId, input: [text(steer.prompt)], expectedTurnId: turn.turnId });
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
      turn.input.emit({ type: "compaction-status", compacting: true });
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
      turn.input.emit({ type: "compaction", trigger: "auto", preTokens: this.lastTokens });
      turn.input.emit({ type: "compaction-status", compacting: false });
    } else {
      turn.items.delete(item.id);
    }
  }

  private receiveUsage(tokens: number) {
    const turn = this.turn;
    if (!turn) return;
    this.lastTokens = tokens;
    turn.input.emit({ type: "usage", tokens, limit: contextWindowLimit("codex", turn.input.model), model: turn.input.model });
  }

  private receiveTurnCompleted(completed: NotificationParams<"turn/completed">["turn"]) {
    const turn = this.turn;
    if (!turn || (turn.turnId !== undefined && turn.turnId !== completed.id)) return;
    if (completed.status === "completed") this.settle({ status: "succeeded" });
    else if (completed.status === "interrupted") this.settle({ status: "cancelled" });
    else if (completed.status === "failed") this.settle({ status: "failed", message: completed.error?.message ?? turn.failure ?? "Codex could not finish the turn." });
  }

  /** Whether the run allows what the server is asking. Nothing is allowed on a session with no run to ask. */
  private async allowed(intent: ToolIntent) {
    const turn = this.turn;
    if (!turn) return false;
    return await turn.input.authorize(intent) === "allow";
  }

  /** The newest call the agent has going against one MCP server, which is what its approval prompt is about. */
  private pendingMcpCall(server: string) {
    let found: Extract<ThreadItem, { type: "mcpToolCall" }> | undefined;
    for (const item of this.turn?.items.values() ?? []) {
      if (item.type === "mcpToolCall" && item.server === server) found = item;
    }
    return found;
  }

  /** Every question the server asks goes to the run's user; a denial declines rather than cancels, so the turn goes on. */
  private answer(request: IncomingRequest) {
    switch (request.method) {
      case "item/commandExecution/requestApproval": {
        const { itemId, command, cwd, reason } = request.params;
        const started = this.turn?.items.get(itemId);
        const input = {
          command: command ?? (started?.type === "commandExecution" ? started.command : ""),
          ...(cwd ? { cwd } : {}),
          ...(reason ? { reason } : {}),
        };
        void this.allowed({ toolId: itemId, name: "command_execution", input }).then((allow) => request.respond({ decision: allow ? "accept" : "decline" }));
        return;
      }
      case "item/fileChange/requestApproval": {
        const { itemId, reason } = request.params;
        const started = this.turn?.items.get(itemId);
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
        const started = this.pendingMcpCall(params.serverName);
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
