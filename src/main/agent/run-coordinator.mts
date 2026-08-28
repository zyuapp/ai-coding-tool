import { randomUUID } from "node:crypto";
import type { AgentEvent, BackgroundReport, InternalStartRunCommand, RunEvent, WorkflowReport } from "../../contracts/ipc.js";
import type { ToolIntent } from "../../domain/run.js";
import type { AgentProvider, AgentTurn, AutomationBridge, FindingBridge, ProviderEvent, BrowserBridge, TerminalBridge, ThreadBridge, ToolDecision } from "./agent-provider.mjs";
import { SteerChannel } from "./steer-channel.mjs";

type PendingApproval = {
  settled: boolean;
  resolve: (decision: ToolDecision) => void;
  /** Only an unattended run has one: the deadline after which the question is answered for it. */
  deadline?: ReturnType<typeof setTimeout>;
};

type ActiveRun = {
  taskId: string;
  runId: string;
  workspaceRoot: string;
  projectless: boolean;
  abortController: AbortController;
  steering: SteerChannel;
  sequence: number;
  terminal: boolean;
  /** Started by the scheduler with nobody present, until somebody steers into it. */
  unattended: boolean;
  approvals: Map<string, PendingApproval>;
  /** Newest streamed tail, held back until the throttle window opens. */
  pendingTail?: { messageId: string; text: string };
  tailTimer?: ReturnType<typeof setTimeout>;
};

type CoordinatorOptions = {
  isWritePathInside?: (root: string, candidate: string) => boolean | Promise<boolean>;
  automations?: (taskId: string) => AutomationBridge;
  findings?: (taskId: string) => FindingBridge;
  threads?: (taskId: string) => ThreadBridge;
  browser?: (taskId: string) => BrowserBridge;
  terminal?: (taskId: string) => TerminalBridge;
  tailIntervalMs?: number;
  unattendedApprovalMs?: number;
};

/** Tails arrive per token; this is often enough to read as typing without flooding the renderer. */
const DEFAULT_TAIL_INTERVAL_MS = 40;

/** Long enough that a person who is around still decides; short enough that the next tick is not lost. */
const DEFAULT_UNATTENDED_APPROVAL_MS = 10 * 60_000;

const UNATTENDED_DENIAL = "Nobody is watching this scheduled run, so this action was denied rather than left waiting. Take a route that needs no approval, or stop and report what you could not do.";

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
      unattended: command.unattended === true,
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
    /** Somebody is here after all, so the run's questions go back to waiting for them. */
    active.unattended = false;
    return active.steering.push({ messageId, prompt });
  }

  cancel(taskId: string, runId: string) {
    const active = this.runs.get(taskId);
    if (!active || active.runId !== runId) return false;
    this.cancelActive(active);
    return true;
  }

  /**
   * Kills one background process of the thread's session. It is addressed to the session rather than
   * to a run, because a workflow outlives the run that started it and still has to be stoppable.
   */
  stopProcess(taskId: string, processId: string) {
    return this.provider.stopProcess(taskId, processId);
  }

  decideApproval(taskId: string, runId: string, approvalId: string, allow: boolean) {
    const active = this.runs.get(taskId);
    if (!active || active.runId !== runId || active.terminal) return false;
    const pending = active.approvals.get(approvalId);
    if (!pending) return false;
    /** Answering one is somebody being here, so the run's later questions wait for them too. */
    active.unattended = false;
    if (!this.settleApproval(active, approvalId, pending, allow ? "allow" : "deny")) return false;
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
        engine: command.engine,
        model: command.model,
        effort: command.effort,
        operation: command.operation,
        claude: command.claude,
        continuation: command.continuation,
        forkContinuation: command.forkContinuation,
        automations: this.options.automations?.(command.taskId),
        findings: this.options.findings?.(command.taskId),
        threads: this.options.threads?.(command.taskId),
        browser: command.browserTools === false ? undefined : this.options.browser?.(command.taskId),
        terminal: this.options.terminal?.(command.taskId),
        steering: active.steering,
        abortController: active.abortController,
        authorize: (intent) => this.authorize(active, intent),
        emit: (event) => this.handleProviderEvent(active, event),
        reportWorkflow: (report) => this.reportWorkflow(active.taskId, report),
        reportBackground: (report) => this.reportBackground(active.taskId, report),
        beginAgentTurn: () => this.beginAgentTurn(active),
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
    if (event.type === "continuation-lost") this.publish(active, { type: "continuation.lost" });
    if (event.type === "steered") this.publish(active, { type: "queued.delivered", messageId: event.messageId });
    if (event.type === "subagent.started") this.publish(active, event);
    if (event.type === "subagent.progress") this.publish(active, event);
    if (event.type === "subagent.activity") this.publish(active, event);
    if (event.type === "subagent.finished") this.publish(active, event);
  }

  /** A workflow answers to the thread rather than to a run, so nothing about a run's state holds it back. */
  private reportWorkflow(taskId: string, report: WorkflowReport) {
    this.emit({ ...report, taskId });
  }

  /** A shell or a monitor outlives the run that started it, so its set answers to the thread too. */
  private reportBackground(taskId: string, report: BackgroundReport) {
    this.emit({ ...report, taskId });
  }

  /**
   * Gives a turn the agent started itself somewhere to land. It is a run like any other, so what the
   * agent says is read where the thread's other turns are, and what it asks for is approved there too.
   */
  private beginAgentTurn(seed: ActiveRun): AgentTurn | null {
    if (this.runs.has(seed.taskId)) return null;
    const active: ActiveRun = {
      taskId: seed.taskId,
      runId: randomUUID(),
      workspaceRoot: seed.workspaceRoot,
      projectless: seed.projectless,
      abortController: new AbortController(),
      steering: new SteerChannel(),
      sequence: 0,
      terminal: false,
      unattended: false,
      approvals: new Map(),
    };
    this.runs.set(active.taskId, active);
    this.publish(active, { type: "run.started", agentInitiated: true });
    this.publish(active, { type: "run.status", status: "running" });
    return {
      emit: (event) => this.handleProviderEvent(active, event),
      authorize: (intent) => this.authorize(active, intent),
      steering: active.steering,
      end: (result) => this.finish(active, result.status, result.message),
    };
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

  private async authorize(active: ActiveRun, intent: ToolIntent): Promise<ToolDecision> {
    if (!this.isCurrent(active) || active.terminal || active.abortController.signal.aborted) return "deny";
    if (intent.writePath && this.options.isWritePathInside) {
      if (!(await this.options.isWritePathInside(active.workspaceRoot, intent.writePath))) return "deny";
      if (!this.isCurrent(active) || active.terminal || active.abortController.signal.aborted) return "deny";
    }
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const pending: PendingApproval = { settled: false, resolve };
      active.approvals.set(approvalId, pending);
      /**
       * Only a run the scheduler started answers for itself, and only while it stays unattended: a
       * question left standing would hold the thread busy and cost the automation every later tick.
       */
      if (active.unattended) {
        pending.deadline = setTimeout(() => {
          if (!active.unattended || !this.settleApproval(active, approvalId, pending, { deny: UNATTENDED_DENIAL })) return;
          if (!active.terminal && this.isCurrent(active)) this.publish(active, { type: "run.status", status: "running" });
        }, this.options.unattendedApprovalMs ?? DEFAULT_UNATTENDED_APPROVAL_MS);
        pending.deadline.unref?.();
      }
      active.abortController.signal.addEventListener("abort", () => {
        this.settleApproval(active, approvalId, pending, "deny");
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

  /** Answers one pending approval exactly once, and stops any deadline it was under. */
  private settleApproval(active: ActiveRun, approvalId: string, pending: PendingApproval, decision: ToolDecision) {
    if (pending.settled) return false;
    pending.settled = true;
    clearTimeout(pending.deadline);
    active.approvals.delete(approvalId);
    pending.resolve(decision);
    return true;
  }

  private expireApprovals(active: ActiveRun) {
    for (const [approvalId, pending] of active.approvals) {
      this.settleApproval(active, approvalId, pending, "deny");
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
