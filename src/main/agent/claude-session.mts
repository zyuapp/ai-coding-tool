import type { CanUseTool, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeEffort, contextWindowLimit, type AgentModel } from "../../domain/agent-engine.js";
import type { BackgroundProcess, BackgroundProcessKind, ExecutionPolicy, ToolIntent } from "../../domain/run.js";
import type { BackgroundReport, WorkflowReport } from "../../contracts/ipc.js";
import type { AgentTurn, ProviderEvent, ProviderResult, ProviderRunInput, SteerQueue, ToolDecision } from "./agent-provider.mjs";
import { parseWorkflowProgress, workflowProgressOf } from "./workflow-progress.mjs";
import { appendCompleteMarkdown, openMarkdownBuffer, type MarkdownBuffer } from "./markdown-buffer.mjs";
import { AUTOMATION_SERVER_NAME } from "../tools/automation.mjs";
import { BROWSER_SERVER_NAME, BROWSER_TOOLS } from "../tools/browser.mjs";
import { THREAD_SERVER_NAME, THREAD_TOOLS } from "../tools/threads.mjs";
import { readOnlyToolNames } from "./claude-mcp-host.mjs";

const setupToolName = "mcp__aicodingtool-computer-use__request_setup";
/** Scheduled runs have nobody to approve anything, and these tools only reach the run's own automation. */
const automationToolPrefix = `mcp__${AUTOMATION_SERVER_NAME}__`;
/** Reading the workspace changes nothing, so it needs no approval; starting or stopping a run does. */
const readOnlyThreadTools = readOnlyToolNames(THREAD_SERVER_NAME, THREAD_TOOLS);
/** Reading a page the panel already holds changes nothing; opening one and acting in it does. */
const readOnlyBrowserTools = readOnlyToolNames(BROWSER_SERVER_NAME, BROWSER_TOOLS);

/** The model the agent process stamps on replies it produced itself: slash commands, interrupts, error notices. */
const SYNTHETIC_MODEL = "<synthetic>";

/** How long an interrupted turn has to come back with a result before the session is given up on. */
const INTERRUPT_GRACE_MS = 10_000;

/** The task types that are processes of their own. Subagents and workflows have a panel already. */
const backgroundProcessKinds: Record<string, BackgroundProcessKind> = {
  local_bash: "shell",
  monitor_mcp: "monitor",
  monitor_ws: "monitor",
};

function backgroundProcesses(tasks: { task_id: string; task_type: string; description: string }[]): BackgroundProcess[] {
  return tasks.flatMap((task) => {
    const kind = backgroundProcessKinds[task.task_type];
    return kind ? [{ id: task.task_id, kind, description: task.description }] : [];
  });
}

export function claudePermissionMode(policy: ExecutionPolicy) {
  return {
    confirm: "default",
    plan: "plan",
    "allow-edits": "acceptEdits",
    autonomous: "auto",
  }[policy] as "default" | "plan" | "acceptEdits" | "auto";
}

/**
 * What the run says, as the agent process takes it. A message that arrives while the agent is
 * already working is held for the next turn unless it says otherwise, so a steered one asks to be
 * folded into the turn already going — which is the whole of what steering means.
 */
function userMessage(prompt: string, priority?: SDKUserMessage["priority"]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    session_id: "",
    ...(priority === undefined ? {} : { priority }),
  };
}

function writePathFor(toolName: string, input: unknown) {
  if (!(toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit")) return undefined;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.notebook_path;
  return typeof value === "string" ? value : undefined;
}

/** Every skill runs through one tool, so the name carries the skill that was asked for. */
export function toolDisplayName(toolName: string, input: unknown) {
  if (toolName !== "Skill" || !input || typeof input !== "object") return toolName;
  const skill = (input as Record<string, unknown>).skill;
  return typeof skill === "string" && skill ? `Skill: ${skill}` : toolName;
}

function normalizeToolIntent(toolName: string, input: unknown, toolUseID: string): ToolIntent {
  const writePath = writePathFor(toolName, input);
  return { toolId: toolUseID, name: toolDisplayName(toolName, input), input, ...(writePath === undefined ? {} : { writePath }) };
}

type Pending = { message: SDKUserMessage; delivered?: () => void };

/** Everything one turn builds up as it streams, and where what it produces goes. */
type Stream = {
  emit: (event: ProviderEvent) => void;
  /** What the turn is answering with, which is what its context meter is measured against. */
  model?: AgentModel;
  streamedText: Map<string, MarkdownBuffer>;
  activeMainStreamId?: string;
  subagentIds: Set<string>;
  subagentByToolUse: Map<string, string>;
};

function openStream(emit: (event: ProviderEvent) => void, model?: AgentModel): Stream {
  return { emit, ...(model === undefined ? {} : { model }), streamedText: new Map(), subagentIds: new Set(), subagentByToolUse: new Map() };
}

/**
 * How many turn results a run is still owed. Folding a steered message in ends the turn it
 * interrupted and starts another for the message, so each one steered adds a turn to wait for.
 */
type Owing = { owed: number };

/** One turn a run asked for: the stream that answers it, and the promise the answer settles. */
type Turn = Owing & {
  input: ProviderRunInput;
  settle: (result: ProviderResult) => void;
  stream: Stream;
  release: () => void;
};

export type SessionOpener = (prompt: AsyncIterable<SDKUserMessage>, canUseTool: CanUseTool) => Query;

/**
 * One live Claude session, kept across turns. The agent process, its MCP servers, and everything it
 * left running in the background belong to the session, so a second turn neither pays for a new
 * process nor replays the transcript to resume it. Each turn takes the session in turn: the input
 * stream stays open between them, and the turn ends on its own result.
 */
export class ClaudeSession {
  private query: Query | null = null;
  private turn: Turn | null = null;
  private readonly queue: Pending[] = [];
  private waiting: ((next: Pending | null) => void) | null = null;
  private ended = false;
  /** How the stream ended, kept for a run that arrives after the session is already over. */
  private outcome: ProviderResult | null = null;
  /** The turn the agent started itself, once it has a run to report into. Only ever one at a time. */
  private agentTurn: (Owing & { turn: AgentTurn; stream: Stream }) | null = null;
  /** Opens that run. Taken when the session opens: what the agent says between runs is the thread's. */
  private beginAgentTurn: () => AgentTurn | null = () => null;
  /** The workflows running here. One outlives the turn that started it, so the set outlives the turn too. */
  private readonly workflowIds = new Set<string>();
  /** Where those workflows report. Taken when the session opens: they belong to the thread, not to a run. */
  private reportWorkflow: (report: WorkflowReport) => void = () => {};
  /** Where those tasks report. Taken when the session opens: a shell or a monitor belongs to the thread, not to a run. */
  private reportBackground: (report: BackgroundReport) => void = () => {};
  /** Every background task the agent process last reported live, by id. Replaced whole, so it holds nothing that has stopped. */
  private readonly backgroundTaskIds = new Set<string>();
  /** What the agent process called this session. A later run resumes it by this id. */
  sessionId?: string;
  private model?: AgentModel;
  private effort?: string;

  constructor(readonly key: string, private readonly onEnded: () => void, private readonly onIdle: () => void = () => {}) {}

  /** A turn is in flight, so the session owes an answer before it can take another. */
  get answering() {
    return this.turn !== null;
  }

  /** Anything closing the session would cut short: a turn in flight, or work the agent left running behind it. */
  get busy() {
    return this.answering || this.agentTurn !== null || this.backgroundTaskIds.size > 0;
  }

  get live() {
    return !this.ended;
  }

  open(opener: SessionOpener, seed: ProviderRunInput) {
    this.model = seed.model;
    this.effort = seed.effort;
    this.reportWorkflow = seed.reportWorkflow;
    this.reportBackground = seed.reportBackground;
    this.beginAgentTurn = seed.beginAgentTurn;
    /** The agent process reports nothing at startup, so a fresh one starts the thread's set empty. */
    this.reportBackground({ type: "background.changed", processes: [] });
    this.query = opener(this.stream(), this.canUseTool);
    void this.pump();
  }

  /** Whether this session is the one a run means to continue. */
  continues(continuation: string | undefined) {
    return continuation === undefined || continuation === this.sessionId;
  }

  run(input: ProviderRunInput): Promise<ProviderResult> {
    const query = this.query;
    if (this.ended || !query) return Promise.resolve(this.outcome ?? { status: "failed", message: "The agent session ended before the run could start." });
    /** The run supersedes whatever the agent had going on its own, so that turn lets go of its own run. */
    this.endAgentTurn({ status: "cancelled" });
    return new Promise<ProviderResult>((resolve) => {
      let grace: ReturnType<typeof setTimeout> | undefined;
      const interrupt = () => {
        void query.interrupt?.()?.catch?.(() => {});
        grace = setTimeout(() => {
          this.settle({ status: "cancelled" });
          this.close();
        }, INTERRUPT_GRACE_MS);
        grace.unref?.();
      };
      const turn: Turn = {
        input,
        owed: 1,
        settle: resolve,
        stream: openStream((event) => input.emit(event), input.model),
        release: () => {
          clearTimeout(grace);
          input.abortController.signal.removeEventListener("abort", interrupt);
        },
      };
      /** The turn is the session's before anything is awaited, so a stream that ends still answers it. */
      this.turn = turn;
      if (input.abortController.signal.aborted) {
        this.settle({ status: "cancelled" });
        return;
      }
      input.abortController.signal.addEventListener("abort", interrupt, { once: true });
      void this.begin(turn);
    });
  }

  private async begin(turn: Turn) {
    await this.retune(turn.input);
    if (this.turn !== turn) return;
    this.push({ message: userMessage(turn.input.prompt) });
    await this.drainSteering(turn.input.steering, (event) => turn.input.emit(event), () => this.turn === turn ? turn : null);
  }

  /** Kills one background process of this session: a shell, a monitor, or a workflow. */
  stopProcess(processId: string) {
    void this.query?.stopTask(processId)?.catch?.(() => {});
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    /** The session ending is the end of the tasks it holds: nothing is left to report them stopping. */
    this.backgroundTaskIds.clear();
    this.reportBackground({ type: "background.changed", processes: [] });
    this.endAgentTurn({ status: "cancelled" });
    /** The session ending is the end of the workflows it holds: their own notification can no longer come. */
    for (const id of this.workflowIds) this.reportWorkflow({ type: "workflow.finished", id, status: "stopped", summary: "" });
    this.workflowIds.clear();
    this.settle({ status: "cancelled" });
    this.wake(null);
    this.query?.close();
    this.query = null;
    this.onEnded();
  }

  /** A live session takes its settings as changes rather than as a reason to start over. */
  private async retune(input: ProviderRunInput) {
    const query = this.query;
    if (!query) return;
    if (this.model !== input.model) {
      this.model = input.model;
      await query.setModel?.(input.model)?.catch?.(() => {});
    }
    /** A run can leave plan mode itself, so the policy is re-stated every turn rather than only when it changes. */
    await query.setPermissionMode?.(claudePermissionMode(input.policy))?.catch?.(() => {});
    if (this.effort !== input.effort) {
      this.effort = input.effort;
      await query.applyFlagSettings?.({ effortLevel: claudeEffort(input.effort) })?.catch?.(() => {});
    }
  }

  /** Feeds one run's steered messages into the session for as long as that run is the one going. */
  private async drainSteering(steering: SteerQueue, emit: (event: ProviderEvent) => void, owing: () => Owing | null) {
    for (let steer = await steering.next(); steer; steer = await steering.next()) {
      const owed = owing();
      if (!owed) return;
      owed.owed += 1;
      this.push({ message: userMessage(steer.prompt, "now"), delivered: () => emit({ type: "steered", messageId: steer.messageId }) });
    }
  }

  /**
   * Whether this result ends a turn a steered message cut short rather than the run. The run's
   * verdict is the last turn's: what it says about work the steering called off is not an answer.
   */
  private absorbedSteering() {
    const owing: Owing | null = this.turn ?? this.agentTurn;
    if (!owing || owing.owed <= 1) return false;
    owing.owed -= 1;
    return true;
  }

  /**
   * The session's input, open for as long as the session is. A steered message joins the turn that
   * is going instead of waiting for the next one, and only counts as delivered once the SDK has
   * taken it.
   */
  private async *stream(): AsyncGenerator<SDKUserMessage> {
    while (!this.ended) {
      const pending = this.queue.shift() ?? await new Promise<Pending | null>((resolve) => { this.waiting = resolve; });
      if (!pending) return;
      yield pending.message;
      pending.delivered?.();
    }
  }

  private push(pending: Pending) {
    if (this.waiting) this.wake(pending);
    else this.queue.push(pending);
  }

  private wake(pending: Pending | null) {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.(pending);
  }

  private settle(result: ProviderResult) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    turn.release();
    turn.settle(turn.input.abortController.signal.aborted ? { status: "cancelled" } : result);
  }

  private finish(result: ProviderResult) {
    this.outcome = result;
    this.settle(result);
    this.endAgentTurn(result);
  }

  /** Ends whichever turn is in flight: the one a run asked for, or the one the agent started itself. */
  private conclude(result: ProviderResult) {
    if (this.turn) this.settle(result);
    else this.endAgentTurn(result);
  }

  /**
   * Where the message goes. Between runs the agent still speaks — a workflow reports what it
   * produced, and work that outlived its run still asks before it acts — so a turn nobody asked
   * for is given a run of its own rather than dropped.
   */
  private streamFor(message: SDKMessage): Stream | null {
    if (this.turn) return this.turn.stream;
    if (this.agentTurn) return this.agentTurn.stream;
    if (message.type !== "assistant" && message.type !== "stream_event") return null;
    return this.openAgentTurn()?.stream ?? null;
  }

  private openAgentTurn() {
    if (this.agentTurn) return this.agentTurn;
    const turn = this.beginAgentTurn();
    if (!turn) return null;
    const open = { turn, owed: 1, stream: openStream((event) => turn.emit(event), this.model) };
    this.agentTurn = open;
    void this.drainSteering(turn.steering, (event) => turn.emit(event), () => this.agentTurn === open ? open : null);
    return this.agentTurn;
  }

  private endAgentTurn(result: ProviderResult) {
    const open = this.agentTurn;
    if (!open) return;
    this.agentTurn = null;
    open.turn.end(result);
  }

  private async pump() {
    try {
      for await (const message of this.query as Query) this.receive(message);
      this.finish({ status: "succeeded" });
    } catch (error) {
      this.finish({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      this.close();
    }
  }

  private receive(message: SDKMessage) {
    if (message.type === "system" && message.subtype === "init") this.sessionId = message.session_id;
    /** Taken before the stream guard: what the agent leaves running outlives the turn that started it. */
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      this.trackBackground(message.tasks);
      this.reportBackground({ type: "background.changed", processes: backgroundProcesses(message.tasks) });
    }
    if (this.receiveWorkflow(message)) return;
    const stream = this.streamFor(message);
    if (!stream) return;
    if (message.type === "system" && message.subtype === "init") {
      stream.emit({ type: "continuation", continuation: { provider: "claude", value: message.session_id } });
    } else if (message.type === "system" && message.subtype === "compact_boundary") {
      stream.emit({
        type: "compaction",
        trigger: message.compact_metadata.trigger,
        preTokens: message.compact_metadata.pre_tokens,
        ...(message.compact_metadata.post_tokens === undefined ? {} : { postTokens: message.compact_metadata.post_tokens }),
      });
    } else if (message.type === "system" && message.subtype === "status" && (message.status === "compacting" || message.compact_result)) {
      stream.emit({
        type: "compaction-status",
        compacting: message.status === "compacting",
        ...(message.compact_result === "failed" ? { error: message.compact_error ?? "Context compaction failed." } : {}),
      });
    } else if (message.type === "system" && message.subtype === "task_started" && message.subagent_type) {
      stream.subagentIds.add(message.task_id);
      if (message.tool_use_id) stream.subagentByToolUse.set(message.tool_use_id, message.task_id);
      stream.emit({
        type: "subagent.started",
        id: message.task_id,
        description: message.description,
        agentType: message.subagent_type,
      });
    } else if (message.type === "system" && message.subtype === "task_progress" && (message.subagent_type || stream.subagentIds.has(message.task_id))) {
      stream.emit({
        type: "subagent.progress",
        id: message.task_id,
        description: message.description,
        ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
        ...(message.summary ? { summary: message.summary } : {}),
        totalTokens: message.usage.total_tokens,
      });
    } else if (message.type === "system" && message.subtype === "task_notification" && stream.subagentIds.has(message.task_id)) {
      stream.emit({
        type: "subagent.finished",
        id: message.task_id,
        status: message.status === "completed" ? "completed" : message.status,
        summary: message.summary,
      });
      stream.subagentIds.delete(message.task_id);
      for (const [toolUseId, subagentId] of stream.subagentByToolUse) {
        if (subagentId === message.task_id) stream.subagentByToolUse.delete(toolUseId);
      }
    } else if (message.type === "stream_event" && !message.parent_tool_use_id && message.event.type === "message_start") {
      stream.activeMainStreamId = message.event.message.id;
      stream.streamedText.set(stream.activeMainStreamId, openMarkdownBuffer());
    } else if (message.type === "stream_event" && !message.parent_tool_use_id && stream.activeMainStreamId && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
      const buffered = stream.streamedText.get(stream.activeMainStreamId);
      if (buffered) {
        const complete = appendCompleteMarkdown(buffered, message.event.delta.text);
        if (complete) stream.emit({ type: "assistant", messageId: stream.activeMainStreamId, text: complete, append: true });
        stream.emit({ type: "assistant-tail", messageId: stream.activeMainStreamId, text: buffered.text });
      }
    } else if (message.type === "assistant") {
      const subagentId = message.parent_tool_use_id ? stream.subagentByToolUse.get(message.parent_tool_use_id) : undefined;
      if (subagentId) {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            stream.emit({ type: "subagent.activity", id: subagentId, activityId: `${message.uuid}:text`, kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            stream.emit({ type: "subagent.activity", id: subagentId, activityId: block.id, kind: "tool", title: toolDisplayName(block.name, block.input), text: JSON.stringify(block.input, null, 2) });
          }
        }
        return;
      }
      const streamId = message.message.id;
      const streamed = stream.streamedText.get(streamId);
      if (streamed !== undefined) {
        if (streamed.text) stream.emit({ type: "assistant", messageId: streamId, text: streamed.text, append: true });
        stream.streamedText.delete(streamId);
        if (stream.activeMainStreamId === streamId) stream.activeMainStreamId = undefined;
      }
      for (const block of message.message.content) {
        if (block.type === "text" && streamed === undefined && block.text.trim()) {
          stream.emit({ type: "assistant", messageId: message.uuid, text: block.text });
        } else if (block.type === "tool_use") {
          stream.emit({ type: "tool", intent: normalizeToolIntent(block.name, block.input, block.id) });
        }
      }
      /** A synthetic reply costs no context and counts none, so reporting it would blank the meter. */
      if (message.message.model !== SYNTHETIC_MODEL && stream.model) {
        const usage = message.message.usage;
        stream.emit({
          type: "usage",
          tokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
          limit: contextWindowLimit("claude", stream.model),
          model: message.message.model,
        });
      }
    } else if (message.type === "result") {
      /** The open input stream keeps the session alive, so the turn's result is what ends the run. */
      if (this.absorbedSteering()) return;
      if (message.subtype !== "success" || message.is_error) {
        this.conclude({ status: "failed", message: message.subtype === "success" ? message.result : message.errors.join("\n") });
        /** A turn that broke leaves a session nobody can vouch for; the next run resumes it instead. */
        this.close();
        return;
      }
      this.conclude({ status: "succeeded" });
    }
  }

  /** Whether the message belonged to a workflow. Read before the stream guard, so a workflow reports between turns too. */
  private receiveWorkflow(message: SDKMessage) {
    if (message.type !== "system") return false;
    if (message.subtype === "task_started" && message.task_type === "local_workflow") {
      this.workflowIds.add(message.task_id);
      this.reportWorkflow({
        type: "workflow.started",
        id: message.task_id,
        name: message.workflow_name ?? message.description,
        description: message.description,
      });
      return true;
    }
    if (message.subtype === "task_progress" && this.workflowIds.has(message.task_id)) {
      /** The tree rides along with some frames and not others; a frame without one has nothing to say. */
      const progress = parseWorkflowProgress(workflowProgressOf(message));
      if (progress) {
        this.reportWorkflow({
          type: "workflow.progress",
          id: message.task_id,
          phases: progress.phases,
          agents: progress.agents,
          totalTokens: message.usage.total_tokens,
          totalToolCalls: message.usage.tool_uses,
        });
      }
      return true;
    }
    if (message.subtype === "task_notification" && this.workflowIds.has(message.task_id)) {
      this.workflowIds.delete(message.task_id);
      this.reportWorkflow({
        type: "workflow.finished",
        id: message.task_id,
        status: message.status === "completed" ? "completed" : message.status === "failed" ? "failed" : "stopped",
        summary: message.summary,
      });
      return true;
    }
    return false;
  }

  /**
   * The agent process reports its live tasks as a level rather than as start and finish bookends, so the
   * session swaps its whole set for each payload: a bookend it never saw, or saw twice, cannot leave the
   * session holding work that has already stopped.
   */
  private trackBackground(tasks: { task_id: string }[]) {
    const wasRunning = this.backgroundTaskIds.size > 0;
    this.backgroundTaskIds.clear();
    for (const task of tasks) this.backgroundTaskIds.add(task.task_id);
    if (wasRunning && !this.busy) this.onIdle();
  }

  private readonly canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    const turn = this.turn;
    const allow = { behavior: "allow" as const, updatedInput: toolInput, toolUseID: options.toolUseID };
    const answered = (decision: ToolDecision) => decision === "allow"
      ? allow
      : { behavior: "deny" as const, message: typeof decision === "object" ? decision.deny : "The user denied this action.", toolUseID: options.toolUseID };
    if (toolName === setupToolName || toolName.startsWith(automationToolPrefix) || readOnlyThreadTools.has(toolName) || readOnlyBrowserTools.has(toolName)) return allow;
    if (turn) {
      if (turn.input.channel === "main" && turn.input.policy === "autonomous" && toolName.startsWith("mcp__cua-driver__")) return allow;
      return answered(await turn.input.authorize(normalizeToolIntent(toolName, toolInput, options.toolUseID)));
    }
    /** Work that outlived its run still has to ask, so the turn the agent started takes the question. */
    const agentTurn = this.openAgentTurn();
    if (!agentTurn) return { behavior: "deny", message: "The run this call belongs to is over.", toolUseID: options.toolUseID };
    return answered(await agentTurn.turn.authorize(normalizeToolIntent(toolName, toolInput, options.toolUseID)));
  };
}
