import type { RunEvent } from "../contracts/ipc.js";
import type { Task, TaskMessage } from "../domain/task.js";

export type ActiveRun = {
  taskId: string;
  runId: string;
  sequence: number;
  status: "running" | "compacting" | "awaiting-approval";
};

export type ApprovalView = {
  approvalId: string;
  taskId: string;
  runId: string;
  title: string;
  description: string;
  toolName: string;
  input: Record<string, unknown>;
};

export type RunTransitionState = {
  tasks: Task[];
  activeRun: ActiveRun | null;
  lastRunStatus: "idle" | "running" | "stopped";
  lastRunTaskId: string | null;
  approvals: Record<string, ApprovalView>;
};

function now() {
  return Date.now();
}

export function createTaskMessage(kind: TaskMessage["kind"], text: string, detail?: string): TaskMessage {
  return { id: crypto.randomUUID(), kind, text, ...(detail === undefined ? {} : { detail }), at: now() };
}

export function applyTask<T extends RunTransitionState>(state: T, taskId: string, update: (task: Task) => Task): T {
  return { ...state, tasks: state.tasks.map((task) => task.id === taskId ? update(task) : task) } as T;
}

export function applyRunEvent<T extends RunTransitionState>(state: T, event: RunEvent): T {
  const active = state.activeRun;
  if (!active || event.taskId !== active.taskId || event.runId !== active.runId || event.sequence <= active.sequence) return state;
  const withSequence = { ...state, activeRun: { ...active, sequence: event.sequence } } as T;

  if (event.type === "run.started") return withSequence;
  if (event.type === "run.status") {
    if (event.status === "running" || event.status === "awaiting-approval") {
      return { ...withSequence, activeRun: { ...withSequence.activeRun!, status: event.status } } as T;
    }
    let next = { ...withSequence, activeRun: null, lastRunTaskId: event.taskId, lastRunStatus: event.status === "cancelled" ? "stopped" : "idle" } as T;
    const { [event.runId]: _expired, ...approvals } = next.approvals;
    next = { ...next, approvals } as T;
    if (event.status === "failed" && event.message) next = applyTask(next, event.taskId, (task) => ({ ...task, messages: [...task.messages, createTaskMessage("system", event.message!)], updatedAt: now() }));
    return next;
  }
  if (event.type === "assistant.delta") {
    return applyTask(withSequence, event.taskId, (task) => {
      const messages = [...task.messages];
      const last = messages.at(-1);
      if (last?.kind === "assistant" && last.id === event.messageId) messages[messages.length - 1] = { ...last, text: `${last.text}\n${event.text}` };
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
    const activeState = { ...withSequence, activeRun: { ...withSequence.activeRun!, status: event.compacting ? "compacting" as const : "running" as const } } as T;
    return event.error
      ? applyTask(activeState, event.taskId, (task) => ({ ...task, messages: [...task.messages, createTaskMessage("system", event.error!)], updatedAt: now() }))
      : activeState;
  }
  if (event.type === "context.compacted") {
    const activeState = { ...withSequence, activeRun: { ...withSequence.activeRun!, status: "running" as const } } as T;
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
