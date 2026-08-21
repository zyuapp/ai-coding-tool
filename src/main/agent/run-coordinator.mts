import { randomUUID } from "node:crypto";
import type { AgentEvent, InternalStartRunCommand, RunEvent, WorkflowReport } from "../../contracts/ipc.js";
import type { ToolIntent } from "../../domain/run.js";
import type { AgentProvider, AutomationBridge, ProviderEvent, BrowserBridge, RunControls, TerminalBridge, ThreadBridge } from "./agent-provider.mjs";
import { SteerChannel } from "./steer-channel.mjs";

type ActiveRun = {
  taskId: string;
  runId: string;
  workspaceRoot: string;
  projectless: boolean;
  abortController: AbortController;
  steering: SteerChannel;
  sequence: number;
  terminal: boolean;
  approvals: Map<string, { settled: boolean; resolve: (decision: "allow" | "deny") => void }>;
  /** Absent until the provider has a live session to hand back. */
  controls?: RunControls;
  /** Newest streamed tail, held back until the throttle window opens. */
  pendingTail?: { messageId: string; text: string };
  tailTimer?: ReturnType<typeof setTimeout>;
};

type CoordinatorOptions = {
  isWritePathInside?: (root: string, candidate: string) => boolean | Promise<boolean>;
  automations?: (taskId: string) => AutomationBridge;
  threads?: (taskId: string) => ThreadBridge;
  browser?: (taskId: string) => BrowserBridge;
  terminal?: (taskId: string) => TerminalBridge;
  tailIntervalMs?: number;
};

/** Tails arrive per token; this is often enough to read as typing without flooding the renderer. */
const DEFAULT_TAIL_INTERVAL_MS = 40;

type RunEventPayload = RunEvent extends infer Event
  ? Event extends unknown
    ? Omit<Event, "taskId" | "runId" | "sequence">
    : never
  : never;

export class RunCoordinator {
  /** One live run per task; different tasks run concurrently. */
  private readonly runs = new Map<string, ActiveRun>();

  constructor(
    private readonly provider: AgentProvider,
    private readonly emit: (event: AgentEvent) => void,
    private readonly options: CoordinatorOptions = {},
  ) {}

  start(command: InternalStartRunCommand) {
    const previous = this.runs.get(command.taskId);
    if (previous) this.cancelActive(previous);
    const active: ActiveRun = {
      taskId: command.taskId,
      runId: command.runId,
      workspaceRoot: command.workspaceRoot,
      projectless: Boolean(command.projectless),
      abortController: new AbortController(),
      steering: new SteerChannel(),
      sequence: 0,
      terminal: false,
      approvals: new Map(),
    };
    this.runs.set(command.taskId, active);
    this.publish(active, { type: "run.started" });
    this.publish(active, { type: "run.status", status: "running" });
    void this.execute(active, command);
  }

  /** Only the run the message was queued against can take it; anything else leaves it for the next run. */
  steer(taskId: string, runId: string, messageId: string, prompt: string) {
    const active = this.runs.get(taskId);
    if (!active || active.runId !== runId || active.terminal) return false;
    return active.steering.push({ messageId, prompt });
  }

  cancel(taskId: string, runId: string) {
    const active = this.runs.get(taskId);
    if (!active || active.runId !== runId) return false;
    this.cancelActive(active);
    return true;
  }

  /** Kills one of the run's background processes. The set the run republishes is what confirms it. */
  stopProcess(taskId: string, runId: string, processId: string) {
    const active = this.runs.get(taskId);
    if (!active || active.runId !== runId || active.terminal || !active.controls) return false;
    void active.controls.stopProcess(processId).catch(() => {});
    return true;
  }

  decideApproval(taskId: string, runId: string, approvalId: string, allow: boolean) {
    const active = this.runs.get(taskId);
    if (!active || active.runId !== runId || active.terminal) return false;
    const pending = active.approvals.get(approvalId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    active.approvals.delete(approvalId);
    pending.resolve(allow ? "allow" : "deny");
    if (!active.terminal && this.isCurrent(active)) this.publish(active, { type: "run.status", status: "running" });
    return true;
  }

  private async execute(active: ActiveRun, command: InternalStartRunCommand) {
    try {
      const result = await this.provider.execute({
        channel: command.channel,
        taskId: command.taskId,
        prompt: command.prompt,
        workspaceRoot: active.workspaceRoot,
        projectless: active.projectless,
        computerUse: command.computerUse,
        policy: command.policy,
        model: command.model,
        effort: command.effort,
        continuation: command.continuation,
        forkContinuation: command.forkContinuation,
        automations: this.options.automations?.(command.taskId),
        threads: this.options.threads?.(command.taskId),
        browser: this.options.browser?.(command.taskId),
        terminal: this.options.terminal?.(command.taskId),
        steering: active.steering,
        abortController: active.abortController,
        attach: (controls) => { active.controls = controls; },
        authorize: (intent) => this.authorize(active, intent),
        emit: (event) => this.handleProviderEvent(active, event),
        reportWorkflow: (report) => this.reportWorkflow(active.taskId, report),
      });
      if (!this.isCurrent(active) || active.terminal) return;
      this.finish(active, result.status, result.message);
    } catch (error) {
      if (!this.isCurrent(active) || active.terminal) return;
      this.finish(active, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  private handleProviderEvent(active: ActiveRun, event: ProviderEvent) {
    if (!this.isCurrent(active) || active.terminal) return;
    if (event.type === "assistant") {
      /** The committed block already contains whatever a waiting tail was holding. */
      active.pendingTail = undefined;
      this.publish(active, { type: "assistant.delta", messageId: event.messageId, text: event.text, ...(event.append ? { append: true } : {}) });
    }
    if (event.type === "assistant-tail") this.queueTail(active, event.messageId, event.text);
    if (event.type === "usage") this.publish(active, { type: "context.usage", tokens: event.tokens, limit: event.limit, model: event.model });
    if (event.type === "compaction-status") this.publish(active, { type: "context.compaction-status", compacting: event.compacting, ...(event.error === undefined ? {} : { error: event.error }) });
    if (event.type === "compaction") this.publish(active, { type: "context.compacted", trigger: event.trigger, preTokens: event.preTokens, ...(event.postTokens === undefined ? {} : { postTokens: event.postTokens }) });
    if (event.type === "tool") this.publish(active, { type: "tool.intent", intent: event.intent });
    if (event.type === "computer-use.setup-required") this.publish(active, event);
    if (event.type === "continuation") this.publish(active, { type: "continuation.updated", continuation: event.continuation });
    if (event.type === "steered") this.publish(active, { type: "queued.delivered", messageId: event.messageId });
    if (event.type === "subagent.started") this.publish(active, event);
    if (event.type === "subagent.progress") this.publish(active, event);
    if (event.type === "subagent.activity") this.publish(active, event);
    if (event.type === "subagent.finished") this.publish(active, event);
    if (event.type === "background.changed") this.publish(active, event);
  }

  /** A workflow answers to the thread rather than to a run, so nothing about a run's state holds it back. */
  private reportWorkflow(taskId: string, report: WorkflowReport) {
    this.emit({ ...report, taskId });
  }

  private queueTail(active: ActiveRun, messageId: string, text: string) {
    active.pendingTail = { messageId, text };
    if (active.tailTimer) return;
    this.flushTail(active);
    active.tailTimer = setTimeout(() => {
      active.tailTimer = undefined;
      const pending = active.pendingTail;
      if (pending) this.queueTail(active, pending.messageId, pending.text);
    }, this.options.tailIntervalMs ?? DEFAULT_TAIL_INTERVAL_MS);
    active.tailTimer.unref?.();
  }

  private flushTail(active: ActiveRun) {
    const pending = active.pendingTail;
    if (!pending || active.terminal) return;
    active.pendingTail = undefined;
    this.publish(active, { type: "assistant.tail", messageId: pending.messageId, text: pending.text });
  }

  private async authorize(active: ActiveRun, intent: ToolIntent): Promise<"allow" | "deny"> {
    if (!this.isCurrent(active) || active.terminal || active.abortController.signal.aborted) return "deny";
    if (intent.writePath && this.options.isWritePathInside) {
      if (!(await this.options.isWritePathInside(active.workspaceRoot, intent.writePath))) return "deny";
      if (!this.isCurrent(active) || active.terminal || active.abortController.signal.aborted) return "deny";
    }
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const pending = { settled: false, resolve };
      active.approvals.set(approvalId, pending);
      active.abortController.signal.addEventListener("abort", () => {
        if (!pending.settled) {
          pending.settled = true;
          active.approvals.delete(approvalId);
          resolve("deny");
        }
      }, { once: true });
      this.publish(active, {
        type: "approval.requested",
        approvalId,
        intent,
        title: `${intent.name} needs approval`,
        description: "Review this action before it runs.",
      });
      this.publish(active, { type: "run.status", status: "awaiting-approval" });
    });
  }

  private cancelActive(active: ActiveRun) {
    if (!active.terminal) this.finish(active, "cancelled");
    active.abortController.abort();
  }

  private finish(active: ActiveRun, status: "succeeded" | "failed" | "cancelled", message?: string) {
    if (active.terminal) return;
    active.terminal = true;
    clearTimeout(active.tailTimer);
    active.tailTimer = undefined;
    active.pendingTail = undefined;
    active.steering.close();
    this.expireApprovals(active);
    if (this.isCurrent(active)) {
      this.publish(active, { type: "run.status", status, message });
      this.runs.delete(active.taskId);
    }
  }

  private expireApprovals(active: ActiveRun) {
    for (const [approvalId, pending] of active.approvals) {
      if (!pending.settled) {
        pending.settled = true;
        pending.resolve("deny");
      }
      active.approvals.delete(approvalId);
    }
  }

  private isCurrent(active: ActiveRun) {
    return this.runs.get(active.taskId) === active;
  }

  private publish(active: ActiveRun, event: RunEventPayload) {
    if (!this.isCurrent(active)) return;
    this.emit({ ...event, taskId: active.taskId, runId: active.runId, sequence: ++active.sequence } as RunEvent);
  }
}
