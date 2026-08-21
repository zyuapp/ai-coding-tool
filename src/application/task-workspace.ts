import type { RunEvent, WorkflowEvent } from "../contracts/ipc.js";
import type { BackgroundProcess, Subagent } from "../domain/run.js";
import type { Workflow } from "../domain/workflow.js";
import type { Annotation, PastedText, Task, TaskMessage } from "../domain/task.js";

export type ActiveRun = {
  taskId: string;
  runId: string;
  sequence: number;
  status: "running" | "compacting" | "awaiting-approval";
};

export type TaskRunStatus = "idle" | "running" | "stopped";

export type ApprovalView = {
  approvalId: string;
  taskId: string;
  runId: string;
  title: string;
  description: string;
  toolName: string;
  input: Record<string, unknown>;
};

/**
 * The unfinished end of a streaming message. It stays out of the task so nothing half-written is
 * persisted, and the next committed block replaces it.
 */
export type StreamingTail = {
  messageId: string;
  text: string;
};

/** Runs and their outcomes are keyed by task, so tasks progress independently. */
export type RunTransitionState = {
  tasks: Task[];
  activeRuns: Record<string, ActiveRun>;
  runStatuses: Record<string, TaskRunStatus>;
  approvals: Record<string, ApprovalView>;
  streamingTails: Record<string, StreamingTail>;
  /**
   * What each task's live run has running in the background. The agent process (re)starts with none,
   * so this is never persisted and never outlives the run that reported it.
   */
  backgroundProcesses: Record<string, BackgroundProcess[]>;
  /** What each task has driven as a dynamic workflow. A workflow left running outlives the run that started it. */
  workflows: Record<string, Workflow[]>;
};

function now() {
  return Date.now();
}

/** Scheduled runs carry their own framing: nobody is present to answer a question or end the loop. */
export function automationRunPrompt(prompt: string, runNumber: number) {
  return `${prompt}\n\n---\nThis is automated run #${runNumber} of this task's automation, started by Claudex's scheduler with no user watching. If the automation's stop condition is now met, call the claudex-automation stop tool to end it.`;
}

export function automationRunLabel(runNumber: number) {
  return `Automation run #${runNumber}`;
}

export function createTaskMessage(kind: TaskMessage["kind"], text: string, detail?: string, attachments?: string[], annotations?: Annotation[], pastes?: PastedText[]): TaskMessage {
  return {
    id: crypto.randomUUID(),
    kind,
    text,
    ...(detail === undefined ? {} : { detail }),
    ...(attachments?.length ? { attachments } : {}),
    ...(annotations?.length ? { annotations } : {}),
    ...(pastes?.length ? { pastes } : {}),
    at: now(),
  };
}

export function createFailureMessage(text: string): TaskMessage {
  return { ...createTaskMessage("system", text), tone: "error" };
}

export function withActiveRun<T extends RunTransitionState>(state: T, taskId: string, run: ActiveRun | null): T {
  if (run) return { ...state, activeRuns: { ...state.activeRuns, [taskId]: run } } as T;
  const { [taskId]: _finished, ...activeRuns } = state.activeRuns;
  return { ...state, activeRuns } as T;
}

export function withRunStatus<T extends RunTransitionState>(state: T, taskId: string, status: TaskRunStatus): T {
  if (status !== "idle") return { ...state, runStatuses: { ...state.runStatuses, [taskId]: status } } as T;
  const { [taskId]: _cleared, ...runStatuses } = state.runStatuses;
  return { ...state, runStatuses } as T;
}

export function withStreamingTail<T extends RunTransitionState>(state: T, taskId: string, tail: StreamingTail | null): T {
  if (tail) return { ...state, streamingTails: { ...state.streamingTails, [taskId]: tail } } as T;
  if (!(taskId in state.streamingTails)) return state;
  const { [taskId]: _cleared, ...streamingTails } = state.streamingTails;
  return { ...state, streamingTails } as T;
}

export function withBackgroundProcesses<T extends RunTransitionState>(state: T, taskId: string, processes: BackgroundProcess[]): T {
  if (processes.length) return { ...state, backgroundProcesses: { ...state.backgroundProcesses, [taskId]: processes } } as T;
  if (!(taskId in state.backgroundProcesses)) return state;
  const { [taskId]: _ended, ...backgroundProcesses } = state.backgroundProcesses;
  return { ...state, backgroundProcesses } as T;
}

export function withWorkflows<T extends RunTransitionState>(state: T, taskId: string, workflows: Workflow[]): T {
  if (workflows.length) return { ...state, workflows: { ...state.workflows, [taskId]: workflows } } as T;
  if (!(taskId in state.workflows)) return state;
  const { [taskId]: _ended, ...rest } = state.workflows;
  return { ...state, workflows: rest } as T;
}

/** Every workflow record but the named one, with that one replaced by what the update returns. */
function updateWorkflow<T extends RunTransitionState>(state: T, taskId: string, id: string, update: (existing?: Workflow) => Workflow): T {
  const workflows = state.workflows[taskId] ?? [];
  const existing = workflows.find((workflow) => workflow.id === id);
  return withWorkflows(state, taskId, existing
    ? workflows.map((workflow) => workflow.id === id ? update(workflow) : workflow)
    : [...workflows, update(undefined)]);
}

export function runStatusFor(state: RunTransitionState, taskId: string | null): TaskRunStatus {
  return taskId ? state.runStatuses[taskId] ?? "idle" : "idle";
}

export function applyTask<T extends RunTransitionState>(state: T, taskId: string, update: (task: Task) => Task): T {
  return { ...state, tasks: state.tasks.map((task) => task.id === taskId ? update(task) : task) } as T;
}

function updateSubagent<T extends RunTransitionState>(state: T, taskId: string, subagentId: string, update: (subagent?: Subagent) => Subagent): T {
  return applyTask(state, taskId, (task) => {
    const subagents = [...(task.subagents ?? [])];
    const index = subagents.findIndex((subagent) => subagent.id === subagentId);
    if (index === -1) subagents.push(update());
    else subagents[index] = update(subagents[index]);
    return { ...task, subagents, updatedAt: now() };
  });
}

/** What a workflow reports, kept by its thread: the run that started it may be long over. */
export function applyWorkflowEvent<T extends RunTransitionState>(state: T, event: WorkflowEvent): T {
  if (event.type === "workflow.started") {
    return updateWorkflow(state, event.taskId, event.id, (existing) => ({
      ...(existing ?? { phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: now() }),
      id: event.id,
      name: event.name,
      description: event.description,
      status: "running",
    }));
  }
  if (event.type === "workflow.progress") {
    return updateWorkflow(state, event.taskId, event.id, (existing) => ({
      ...(existing ?? { id: event.id, name: event.id, description: "Dynamic workflow", status: "running" as const, startedAt: now() }),
      phases: event.phases,
      agents: event.agents,
      totalTokens: event.totalTokens,
      totalToolCalls: event.totalToolCalls,
    }));
  }
  return updateWorkflow(state, event.taskId, event.id, (existing) => ({
    ...(existing ?? { id: event.id, name: event.id, description: "Dynamic workflow", phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: now() }),
    status: event.status,
    finishedAt: now(),
    stopping: false,
    ...(event.summary ? { summary: event.summary } : {}),
  }));
}

export function applyRunEvent<T extends RunTransitionState>(state: T, event: RunEvent): T {
  const active = state.activeRuns[event.taskId];
  if (!active || event.runId !== active.runId || event.sequence <= active.sequence) return state;
  const withSequence = withActiveRun(state, event.taskId, { ...active, sequence: event.sequence });

  if (event.type === "run.started") {
    /** A workflow the last run left running is still going; the ones that ended are that run's history. */
    const carried = (state.workflows[event.taskId] ?? []).filter((workflow) => workflow.status === "running");
    return withWorkflows(withBackgroundProcesses(withStreamingTail(withSequence, event.taskId, null), event.taskId, []), event.taskId, carried);
  }
  if (event.type === "run.status") {
    if (event.status === "running" || event.status === "awaiting-approval") {
      return withActiveRun(withSequence, event.taskId, { ...active, sequence: event.sequence, status: event.status });
    }
    /** The agent process ends with the run, taking every process it started with it. */
    let next = withRunStatus(withActiveRun(withBackgroundProcesses(withStreamingTail(withSequence, event.taskId, null), event.taskId, []), event.taskId, null), event.taskId, event.status === "cancelled" ? "stopped" : "idle");
    const { [event.runId]: _expired, ...approvals } = next.approvals;
    next = { ...next, approvals } as T;
    next = applyTask(next, event.taskId, (task) => ({ ...task, runEndedAt: now() }));
    const subagents = next.tasks.find((task) => task.id === event.taskId)?.subagents;
    if (subagents?.some((subagent) => subagent.status === "working")) {
      const status = event.status === "succeeded" ? "completed" : event.status === "failed" ? "failed" : "stopped";
      next = applyTask(next, event.taskId, (task) => ({
        ...task,
        subagents: task.subagents?.map((subagent) => subagent.status === "working" ? { ...subagent, status, finishedAt: now() } : subagent),
        updatedAt: now(),
      }));
    }
    /** A run cut short took its workflows with it; a run that answered leaves them running in the background. */
    const workflows = next.workflows[event.taskId];
    if (event.status !== "succeeded" && workflows?.some((workflow) => workflow.status === "running")) {
      next = withWorkflows(next, event.taskId, workflows.map((workflow) => workflow.status === "running"
        ? { ...workflow, status: "stopped" as const, finishedAt: now(), stopping: false }
        : workflow));
    }
    if (event.status === "failed" && event.message) next = applyTask(next, event.taskId, (task) => ({ ...task, messages: [...task.messages, createFailureMessage(event.message!)], updatedAt: now() }));
    return next;
  }
  if (event.type === "assistant.tail") {
    return withStreamingTail(withSequence, event.taskId, event.text ? { messageId: event.messageId, text: event.text } : null);
  }
  if (event.type === "assistant.delta") {
    /** The block being committed is what the tail was showing, so it stops standing in for it. */
    return applyTask(withStreamingTail(withSequence, event.taskId, null), event.taskId, (task) => {
      const messages = [...task.messages];
      const last = messages.at(-1);
      if (last?.kind === "assistant" && last.id === event.messageId) messages[messages.length - 1] = { ...last, text: `${last.text}${event.append ? "" : "\n"}${event.text}` };
      else messages.push({ id: event.messageId, kind: "assistant", text: event.text, at: now() });
      return { ...task, messages, updatedAt: now() };
    });
  }
  if (event.type === "context.usage") {
    return applyTask(withSequence, event.taskId, (task) => ({
      ...task,
      contextUsage: { tokens: event.tokens, limit: event.limit, model: event.model },
    }));
  }
  if (event.type === "context.compaction-status") {
    const activeState = withActiveRun(withSequence, event.taskId, { ...active, sequence: event.sequence, status: event.compacting ? "compacting" : "running" });
    return event.error
      ? applyTask(activeState, event.taskId, (task) => ({ ...task, messages: [...task.messages, createFailureMessage(event.error!)], updatedAt: now() }))
      : activeState;
  }
  if (event.type === "context.compacted") {
    const activeState = withActiveRun(withSequence, event.taskId, { ...active, sequence: event.sequence, status: "running" });
    return applyTask(activeState, event.taskId, (task) => ({
      ...task,
      messages: [...task.messages, createTaskMessage(
        "system",
        event.postTokens === undefined
          ? `Context ${event.trigger}-compacted at ${event.preTokens.toLocaleString("en-US")} tokens.`
          : `Context ${event.trigger}-compacted: ${event.preTokens.toLocaleString("en-US")} → ${event.postTokens.toLocaleString("en-US")} tokens.`,
      )],
      ...(task.contextUsage && event.postTokens !== undefined
        ? { contextUsage: { ...task.contextUsage, tokens: event.postTokens } }
        : {}),
      updatedAt: now(),
    }));
  }
  if (event.type === "tool.intent") {
    return applyTask(withSequence, event.taskId, (task) => ({
      ...task,
      messages: [...task.messages, createTaskMessage("tool", event.intent.name, JSON.stringify(event.intent.input, null, 2))],
      updatedAt: now(),
    }));
  }
  if (event.type === "subagent.started") {
    return updateSubagent(withSequence, event.taskId, event.id, (existing) => ({
      id: event.id,
      description: event.description,
      ...(event.agentType ? { agentType: event.agentType } : {}),
      status: "working",
      startedAt: existing?.startedAt ?? now(),
      activity: existing?.activity ?? [],
    }));
  }
  if (event.type === "subagent.progress") {
    return updateSubagent(withSequence, event.taskId, event.id, (existing) => ({
      id: event.id,
      description: event.description,
      ...(existing?.agentType ? { agentType: existing.agentType } : {}),
      status: existing?.status ?? "working",
      ...(event.lastToolName ? { lastToolName: event.lastToolName } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      totalTokens: event.totalTokens,
      startedAt: existing?.startedAt ?? now(),
      ...(existing?.finishedAt ? { finishedAt: existing.finishedAt } : {}),
      activity: existing?.activity ?? [],
    }));
  }
  if (event.type === "subagent.activity") {
    return updateSubagent(withSequence, event.taskId, event.id, (existing) => {
      const activity = existing?.activity ?? [];
      return {
        id: event.id,
        description: existing?.description ?? "Subagent",
        ...(existing?.agentType ? { agentType: existing.agentType } : {}),
        status: existing?.status ?? "working",
        ...(existing?.lastToolName ? { lastToolName: existing.lastToolName } : {}),
        ...(existing?.summary ? { summary: existing.summary } : {}),
        ...(existing?.totalTokens === undefined ? {} : { totalTokens: existing.totalTokens }),
        startedAt: existing?.startedAt ?? now(),
        ...(existing?.finishedAt ? { finishedAt: existing.finishedAt } : {}),
        activity: activity.some((item) => item.id === event.activityId)
          ? activity
          : [...activity, { id: event.activityId, kind: event.kind, ...(event.title ? { title: event.title } : {}), text: event.text, at: now() }],
      };
    });
  }
  if (event.type === "subagent.finished") {
    return updateSubagent(withSequence, event.taskId, event.id, (existing) => ({
      id: event.id,
      description: existing?.description ?? "Subagent",
      ...(existing?.agentType ? { agentType: existing.agentType } : {}),
      status: event.status,
      ...(existing?.lastToolName ? { lastToolName: existing.lastToolName } : {}),
      summary: event.summary || existing?.summary,
      ...(existing?.totalTokens === undefined ? {} : { totalTokens: existing.totalTokens }),
      startedAt: existing?.startedAt ?? now(),
      finishedAt: now(),
      activity: existing?.activity ?? [],
    }));
  }
  /** A stop already asked for stays marked until the run stops reporting that process. */
  if (event.type === "background.changed") {
    const stopping = new Set((state.backgroundProcesses[event.taskId] ?? []).filter((process) => process.stopping).map((process) => process.id));
    return withBackgroundProcesses(withSequence, event.taskId, event.processes.map((process) => stopping.has(process.id) ? { ...process, stopping: true } : process));
  }
  if (event.type === "approval.requested") {
    const input = event.intent.input && typeof event.intent.input === "object" && !Array.isArray(event.intent.input)
      ? event.intent.input as Record<string, unknown>
      : { value: event.intent.input };
    const approval: ApprovalView = {
      approvalId: event.approvalId,
      taskId: event.taskId,
      runId: event.runId,
      title: event.title,
      description: event.description,
      toolName: event.intent.name,
      input,
    };
    return { ...withSequence, approvals: { ...withSequence.approvals, [event.runId]: approval } } as T;
  }
  if (event.type === "continuation.updated") {
    return applyTask(withSequence, event.taskId, (task) => ({ ...task, continuation: event.continuation, continuationStatus: "available", updatedAt: now() }));
  }
  return withSequence;
}
