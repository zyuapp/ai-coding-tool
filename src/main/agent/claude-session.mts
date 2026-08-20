import type { CanUseTool, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { emptyScan, scanBlocks, type BlockScan } from "../../domain/markdown-stream.js";
import { contextWindowLimit } from "../../domain/run.js";
import type { BackgroundProcess, BackgroundProcessKind, ExecutionPolicy, ToolIntent } from "../../domain/run.js";
import type { ProviderResult, ProviderRunInput } from "./agent-provider.mjs";
import { AUTOMATION_SERVER_NAME } from "./automation-tools.mjs";
import { BROWSER_SERVER_NAME } from "./browser-tools.mjs";
import { THREAD_SERVER_NAME } from "./thread-tools.mjs";

const setupToolName = "mcp__claudex-computer-use__request_setup";
/** Scheduled runs have nobody to approve anything, and these tools only reach the run's own automation. */
const automationToolPrefix = `mcp__${AUTOMATION_SERVER_NAME}__`;
/** Reading the workspace changes nothing, so it needs no approval; starting or stopping a run does. */
const threadToolPrefix = `mcp__${THREAD_SERVER_NAME}__`;
const readOnlyThreadTools = new Set([`${threadToolPrefix}list_threads`, `${threadToolPrefix}read_thread`, `${threadToolPrefix}wait_for_thread`]);
/** Reading a page the panel already holds changes nothing; opening one and acting in it does. */
const browserToolPrefix = `mcp__${BROWSER_SERVER_NAME}__`;
const readOnlyBrowserTools = new Set([`${browserToolPrefix}browser_read`, `${browserToolPrefix}browser_tabs`]);

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

function userMessage(prompt: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" };
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

type MarkdownBuffer = {
  /** Text the stream has produced but not released yet. */
  text: string;
  scan: BlockScan;
};

/** Releases whole Markdown blocks and keeps the rest buffered, so a half-written fence never ships. */
function appendCompleteMarkdown(buffer: MarkdownBuffer, text: string) {
  buffer.text += text;
  const scan = scanBlocks(buffer.text, buffer.scan);
  buffer.scan = scan;
  if (!scan.safeEnd) return "";
  const complete = buffer.text.slice(0, scan.safeEnd);
  buffer.text = buffer.text.slice(scan.safeEnd);
  buffer.scan = { safeEnd: 0, scanned: scan.scanned - scan.safeEnd, ...(scan.fence ? { fence: scan.fence } : {}) };
  return complete;
}

type Pending = { message: SDKUserMessage; delivered?: () => void };

/** One turn: what the run asked for, and everything the stream builds up while answering it. */
type Turn = {
  input: ProviderRunInput;
  settle: (result: ProviderResult) => void;
  streamedText: Map<string, MarkdownBuffer>;
  activeMainStreamId?: string;
  subagentIds: Set<string>;
  subagentByToolUse: Map<string, string>;
  release: () => void;
};

export type SessionOpener = (prompt: AsyncIterable<SDKUserMessage>, canUseTool: CanUseTool) => Query;

/**
 * One live Claude session, kept across turns. The CLI process, its MCP servers, and everything it
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
  /** What the CLI called this session. A later run resumes it by this id. */
  sessionId?: string;
  private model?: string;
  private effort?: string;

  constructor(readonly key: string, private readonly onEnded: () => void) {}

  get busy() {
    return this.turn !== null;
  }

  get live() {
    return !this.ended;
  }

  open(opener: SessionOpener, seed: ProviderRunInput) {
    this.model = seed.model;
    this.effort = seed.effort;
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
    input.attach({ stopProcess: (processId) => query.stopTask(processId) });
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
        settle: resolve,
        streamedText: new Map(),
        subagentIds: new Set(),
        subagentByToolUse: new Map(),
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
    await this.drainSteering(turn);
  }

  close() {
    if (this.ended) return;
    this.ended = true;
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
      await query.applyFlagSettings?.({ effortLevel: input.effort })?.catch?.(() => {});
    }
  }

  private async drainSteering(turn: Turn) {
    for (let steer = await turn.input.steering.next(); steer; steer = await turn.input.steering.next()) {
      if (this.turn !== turn) return;
      this.push({ message: userMessage(steer.prompt), delivered: () => turn.input.emit({ type: "steered", messageId: steer.messageId }) });
    }
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
    const turn = this.turn;
    if (!turn) return;
    const { input } = turn;
    if (message.type === "system" && message.subtype === "init") {
      input.emit({ type: "continuation", continuation: { provider: "claude", value: message.session_id } });
    } else if (message.type === "system" && message.subtype === "compact_boundary") {
      input.emit({
        type: "compaction",
        trigger: message.compact_metadata.trigger,
        preTokens: message.compact_metadata.pre_tokens,
        ...(message.compact_metadata.post_tokens === undefined ? {} : { postTokens: message.compact_metadata.post_tokens }),
      });
    } else if (message.type === "system" && message.subtype === "status" && (message.status === "compacting" || message.compact_result)) {
      input.emit({
        type: "compaction-status",
        compacting: message.status === "compacting",
        ...(message.compact_result === "failed" ? { error: message.compact_error ?? "Context compaction failed." } : {}),
      });
    } else if (message.type === "system" && message.subtype === "background_tasks_changed") {
      input.emit({ type: "background.changed", processes: backgroundProcesses(message.tasks) });
    } else if (message.type === "system" && message.subtype === "task_started" && message.subagent_type) {
      turn.subagentIds.add(message.task_id);
      if (message.tool_use_id) turn.subagentByToolUse.set(message.tool_use_id, message.task_id);
      input.emit({
        type: "subagent.started",
        id: message.task_id,
        description: message.description,
        agentType: message.subagent_type,
      });
    } else if (message.type === "system" && message.subtype === "task_progress" && (message.subagent_type || turn.subagentIds.has(message.task_id))) {
      input.emit({
        type: "subagent.progress",
        id: message.task_id,
        description: message.description,
        ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
        ...(message.summary ? { summary: message.summary } : {}),
        totalTokens: message.usage.total_tokens,
      });
    } else if (message.type === "system" && message.subtype === "task_notification" && turn.subagentIds.has(message.task_id)) {
      input.emit({
        type: "subagent.finished",
        id: message.task_id,
        status: message.status === "completed" ? "completed" : message.status,
        summary: message.summary,
      });
    } else if (message.type === "stream_event" && !message.parent_tool_use_id && message.event.type === "message_start") {
      turn.activeMainStreamId = message.event.message.id;
      turn.streamedText.set(turn.activeMainStreamId, { text: "", scan: emptyScan() });
    } else if (message.type === "stream_event" && !message.parent_tool_use_id && turn.activeMainStreamId && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
      const buffered = turn.streamedText.get(turn.activeMainStreamId);
      if (buffered) {
        const complete = appendCompleteMarkdown(buffered, message.event.delta.text);
        if (complete) input.emit({ type: "assistant", messageId: turn.activeMainStreamId, text: complete, append: true });
        input.emit({ type: "assistant-tail", messageId: turn.activeMainStreamId, text: buffered.text });
      }
    } else if (message.type === "assistant") {
      const subagentId = message.parent_tool_use_id ? turn.subagentByToolUse.get(message.parent_tool_use_id) : undefined;
      if (subagentId) {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim()) {
            input.emit({ type: "subagent.activity", id: subagentId, activityId: `${message.uuid}:text`, kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            input.emit({ type: "subagent.activity", id: subagentId, activityId: block.id, kind: "tool", title: toolDisplayName(block.name, block.input), text: JSON.stringify(block.input, null, 2) });
          }
        }
        return;
      }
      const streamId = message.message.id;
      const streamed = turn.streamedText.get(streamId);
      if (streamed !== undefined) {
        if (streamed.text) input.emit({ type: "assistant", messageId: streamId, text: streamed.text, append: true });
        turn.streamedText.delete(streamId);
        if (turn.activeMainStreamId === streamId) turn.activeMainStreamId = undefined;
      }
      for (const block of message.message.content) {
        if (block.type === "text" && streamed === undefined && block.text.trim()) {
          input.emit({ type: "assistant", messageId: message.uuid, text: block.text });
        } else if (block.type === "tool_use") {
          input.emit({ type: "tool", intent: normalizeToolIntent(block.name, block.input, block.id) });
        }
      }
      const usage = message.message.usage;
      input.emit({
        type: "usage",
        tokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        limit: contextWindowLimit(input.model),
        model: message.message.model,
      });
    } else if (message.type === "result") {
      /** The open input stream keeps the session alive, so the turn's result is what ends the run. */
      if (message.subtype !== "success" || message.is_error) {
        this.settle({ status: "failed", message: message.subtype === "success" ? message.result : message.errors.join("\n") });
        /** A turn that broke leaves a session nobody can vouch for; the next run resumes it instead. */
        this.close();
        return;
      }
      this.settle({ status: "succeeded" });
    }
  }

  private readonly canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    const turn = this.turn;
    const allow = { behavior: "allow" as const, updatedInput: toolInput, toolUseID: options.toolUseID };
    if (toolName === setupToolName || toolName.startsWith(automationToolPrefix) || readOnlyThreadTools.has(toolName) || readOnlyBrowserTools.has(toolName)) return allow;
    if (!turn) return { behavior: "deny", message: "The run this call belongs to is over.", toolUseID: options.toolUseID };
    if (turn.input.channel === "main" && turn.input.policy === "autonomous" && toolName.startsWith("mcp__cua-driver__")) return allow;
    const decision = await turn.input.authorize(normalizeToolIntent(toolName, toolInput, options.toolUseID));
    return decision === "allow"
      ? allow
      : { behavior: "deny", message: "The user denied this action.", toolUseID: options.toolUseID };
  };
}
