import { randomUUID } from "node:crypto";
import type { InternalStartRunCommand, RunEvent } from "../../contracts/ipc.js";
import type { ToolIntent } from "../../domain/run.js";
import type { AgentProvider, AutomationBridge, ProviderEvent } from "./agent-provider.mjs";

type ActiveRun = {
  taskId: string;
  runId: string;
  workspaceRoot: string;
  projectless: boolean;
  abortController: AbortController;
  sequence: number;
  terminal: boolean;
  approvals: Map<string, { settled: boolean; resolve: (decision: "allow" | "deny") => void }>;
};

type CoordinatorOptions = {
  isWritePathInside?: (root: string, candidate: string) => boolean | Promise<boolean>;
  automations?: (taskId: string) => AutomationBridge;
};

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
    private readonly emit: (event: RunEvent) => void,
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
      sequence: 0,
      terminal: false,
      approvals: new Map(),
    };
    this.runs.set(command.taskId, active);
    this.publish(active, { type: "run.started" });
    this.publish(active, { type: "run.status", status: "running" });
    void this.execute(active, command);
  }

  cancel(taskId: string, runId: string) {
    const active = this.runs.get(taskId);
    if (!active || active.runId !== runId) return false;
    this.cancelActive(active);
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
        prompt: command.prompt,
        workspaceRoot: active.workspaceRoot,
        projectless: active.projectless,
        computerUse: command.computerUse,
        policy: command.policy,
        model: command.model,
        contextWindow: command.contextWindow,
        continuation: command.continuation,
        forkContinuation: command.forkContinuation,
        automations: this.options.automations?.(command.taskId),
        abortController: active.abortController,
        authorize: (intent) => this.authorize(active, intent),
        emit: (event) => this.handleProviderEvent(active, event),
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
    if (event.type === "assistant") this.publish(active, { type: "assistant.delta", messageId: event.messageId, text: event.text, ...(event.append ? { append: true } : {}) });
    if (event.type === "usage") this.publish(active, { type: "context.usage", tokens: event.tokens, limit: event.limit, model: event.model });
    if (event.type === "compaction-status") this.publish(active, { type: "context.compaction-status", compacting: event.compacting, ...(event.error === undefined ? {} : { error: event.error }) });
    if (event.type === "compaction") this.publish(active, { type: "context.compacted", trigger: event.trigger, preTokens: event.preTokens, ...(event.postTokens === undefined ? {} : { postTokens: event.postTokens }) });
    if (event.type === "tool") this.publish(active, { type: "tool.intent", intent: event.intent });
    if (event.type === "computer-use.setup-required") this.publish(active, event);
    if (event.type === "continuation") this.publish(active, { type: "continuation.updated", continuation: event.continuation });
    if (event.type === "subagent.started") this.publish(active, event);
    if (event.type === "subagent.progress") this.publish(active, event);
    if (event.type === "subagent.activity") this.publish(active, event);
    if (event.type === "subagent.finished") this.publish(active, event);
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
