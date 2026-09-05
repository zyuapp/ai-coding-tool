import type { PendingQuestion } from "../domain/agent-question.js";
import type { BackgroundEvent, RunEvent, ThreadEvent, WorkflowEvent } from "../contracts/ipc.js";
import type { BackgroundProcess, Subagent, SubagentReport } from "../domain/run.js";
import type { Workflow } from "../domain/workflow.js";
import type { ActiveGoal } from "../domain/goal.js";
import { createConversationMessage, createFailureMessage } from "../domain/conversation.js";
import type { ThreadOutcome } from "../domain/thread-run.js";
import type { Thread } from "../domain/thread.js";
import { appendMessages, replaceLastMessage, withdrawMessages } from "../domain/conversation-updates.js";

export type ActiveRun = RunProvenance & {
  taskId: string;
  runId: string;
  sequence: number;
  questions?: PendingQuestion[];
  replyingToQuestion?: boolean;
  status: "running" | "compacting" | "awaiting-approval";
  /** Whether this run has said it found something worth surfacing. */
  notified: boolean;
  /** Whether the run answered for itself with either tool. Answering neither is what surfaces a quiet tick. */
  acknowledged: boolean;
  /** Every issue this run reported, held back or not, so settling can tell which handled ones have gone away. */
  reportedIssues: string[];
  /** How many messages the thread held when this run began, so a silent one can withdraw its own. */
  messagesBefore: number;
  /** Where the thread stood when this run began, so a silent one can leave it exactly there. */
  before: ThreadMark;
};

/**
 * What a tick has to put back to have said nothing at all: the verdict of the run before it, which
 * beginning a run always supersedes, and the moments the sidebar orders threads by.
 */
export type ThreadMark = {
  updatedAt: number;
  runEndedAt?: number;
  outcome?: ThreadOutcome;
  outcomeUnread?: true;
};

export function threadMark(thread: Thread | undefined): ThreadMark {
  return {
    updatedAt: thread?.updatedAt ?? 0,
    ...(thread?.runEndedAt === undefined ? {} : { runEndedAt: thread.runEndedAt }),
    ...(thread?.outcome === undefined ? {} : { outcome: thread.outcome }),
    ...(thread?.outcomeUnread ? { outcomeUnread: true as const } : {}),
  };
}

/**
 * Puts a thread back where a tick found it: the messages that tick wrote are withdrawn, so they
 * count for nothing in the thread's activity, the moments it moved are rolled back, and the verdict
 * beginning the run superseded is returned, unread as it was. A tick that says nothing takes
 * nothing away either.
 */
export function withdrawRun(thread: Thread, from: number, before: ThreadMark): Thread {
  const { runEndedAt: _stamped, outcome: _superseded, outcomeUnread: _unread, ...rest } = thread;
  return {
    ...rest,
    messages: withdrawMessages(thread.messages, from),
    updatedAt: before.updatedAt,
    ...(before.runEndedAt === undefined ? {} : { runEndedAt: before.runEndedAt }),
    ...(before.outcome === undefined ? {} : { outcome: before.outcome }),
    ...(before.outcomeUnread ? { outcomeUnread: true as const } : {}),
  };
}

/**
 * Who a run answers to. A run is the composer's unless the scheduler started it, and a human joining
 * a scheduled run makes it theirs again, so nothing is ever quiet by inference.
 */
export type RunProvenance = {
  origin: "composer" | "automation";
  quiet: boolean;
  /** A native thread operation that starts without adding a user message. */
  operation?: "compact" | "review";
};

export const ATTENDED_RUN: RunProvenance = { origin: "composer", quiet: false };

export type ThreadRunStatus = "idle" | "running" | "stopped";

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
 * The unfinished end of a streaming message. It stays out of the thread so nothing half-written is
 * persisted, and the next committed block replaces it.
 */
export type StreamingTail = {
  messageId: string;
  text: string;
};

/** Runs and their outcomes are keyed by thread, so threads progress independently. */
export type RunTransitionState = {
  threads: Thread[];
  goals: Record<string, ActiveGoal>;
  activeRuns: Record<string, ActiveRun>;
  runStatuses: Record<string, ThreadRunStatus>;
  approvals: Record<string, ApprovalView>;
  streamingTails: Record<string, StreamingTail>;
  /**
   * What each thread's session has running in the background. The agent process (re)starts with none and
   * says so, so this is never persisted, and it outlives the run that started the work.
   */
  backgroundProcesses: Record<string, BackgroundProcess[]>;
  /** What each thread has driven as a dynamic workflow. A workflow left running outlives the run that started it. */
  workflows: Record<string, Workflow[]>;
  /**
   * The helper agents each thread has delegated to. A live feed rather than thread content, so a report
   * arriving every few milliseconds never rewrites the thread it belongs to.
   */
  subagents: Record<string, Subagent[]>;
};

function now() {
  return Date.now();
}

/** Scheduled runs carry their own framing: nobody is present to answer a question or end the loop. */
export function automationRunPrompt(prompt: string, runNumber: number, surfaceWhen?: string) {
  const framing = `This is automated run #${runNumber} of this task's automation, started by AICodingTool's scheduler with no user watching. If the automation's stop condition is now met, call the aicodingtool-automation stop tool to end it.`;
  return `${prompt}\n\n---\n${framing}${surfaceWhen ? `\n\n${quietFraming(surfaceWhen)}` : ""}`;
}

/** A quiet run has to earn its silence: saying nothing at all is what a broken run does too. */
function quietFraming(surfaceWhen: string) {
  return `This run is quiet: it settles without reaching the user unless you say otherwise. Surface it when: ${surfaceWhen} If that is what you found, call the aicodingtool-automation notify tool with a headline before you finish. If it is not, call nothing_to_report with what you checked. Call neither and the run surfaces as an ordinary one, which is what a run that could not do its job should do.`;
}

export function automationRunLabel(runNumber: number) {
  return `Automation run #${runNumber}`;
}

export function withActiveRun<T extends RunTransitionState>(state: T, threadId: string, run: ActiveRun | null): T {
  if (run) return { ...state, activeRuns: { ...state.activeRuns, [threadId]: run } } as T;
  const { [threadId]: _finished, ...activeRuns } = state.activeRuns;
  return { ...state, activeRuns } as T;
}

export function withRunStatus<T extends RunTransitionState>(state: T, threadId: string, status: ThreadRunStatus): T {
  if (status !== "idle") return { ...state, runStatuses: { ...state.runStatuses, [threadId]: status } } as T;
  const { [threadId]: _cleared, ...runStatuses } = state.runStatuses;
  return { ...state, runStatuses } as T;
}

export function withStreamingTail<T extends RunTransitionState>(state: T, threadId: string, tail: StreamingTail | null): T {
  if (tail) return { ...state, streamingTails: { ...state.streamingTails, [threadId]: tail } } as T;
  if (!(threadId in state.streamingTails)) return state;
  const { [threadId]: _cleared, ...streamingTails } = state.streamingTails;
  return { ...state, streamingTails } as T;
}

export function withBackgroundProcesses<T extends RunTransitionState>(state: T, threadId: string, processes: BackgroundProcess[]): T {
  if (processes.length) return { ...state, backgroundProcesses: { ...state.backgroundProcesses, [threadId]: processes } } as T;
  if (!(threadId in state.backgroundProcesses)) return state;
  const { [threadId]: _ended, ...backgroundProcesses } = state.backgroundProcesses;
  return { ...state, backgroundProcesses } as T;
}

export function withWorkflows<T extends RunTransitionState>(state: T, threadId: string, workflows: Workflow[]): T {
  if (workflows.length) return { ...state, workflows: { ...state.workflows, [threadId]: workflows } } as T;
  if (!(threadId in state.workflows)) return state;
  const { [threadId]: _ended, ...rest } = state.workflows;
  return { ...state, workflows: rest } as T;
}

/** Every workflow record but the named one, with that one replaced by what the update returns. */
function updateWorkflow<T extends RunTransitionState>(state: T, threadId: string, id: string, update: (existing?: Workflow) => Workflow): T {
  const workflows = state.workflows[threadId] ?? [];
  const existing = workflows.find((workflow) => workflow.id === id);
  return withWorkflows(state, threadId, existing
    ? workflows.map((workflow) => workflow.id === id ? update(workflow) : workflow)
    : [...workflows, update(undefined)]);
}

export function runStatusFor(state: RunTransitionState, threadId: string | null): ThreadRunStatus {
  return threadId ? state.runStatuses[threadId] ?? "idle" : "idle";
}

export function updateThread<T extends RunTransitionState>(state: T, threadId: string, update: (thread: Thread) => Thread): T {
  return { ...state, threads: state.threads.map((thread) => thread.id === threadId ? update(thread) : thread) } as T;
}

export function withSubagents<T extends RunTransitionState>(state: T, threadId: string, subagents: Subagent[]): T {
  if (subagents.length) return { ...state, subagents: { ...state.subagents, [threadId]: subagents } } as T;
  if (!(threadId in state.subagents)) return state;
  const { [threadId]: _cleared, ...rest } = state.subagents;
  return { ...state, subagents: rest } as T;
}

function updateSubagent<T extends RunTransitionState>(state: T, threadId: string, subagentId: string, update: (subagent?: Subagent) => Subagent): T {
  const held = state.subagents[threadId] ?? [];
  const index = held.findIndex((subagent) => subagent.id === subagentId);
  if (index === -1) return withSubagents(state, threadId, [...held, update()]);
  const replaced = update(held[index]);
  if (replaced === held[index]) return state;
  return withSubagents(state, threadId, held.map((subagent, position) => position === index ? replaced : subagent));
}

/** Shared subagent state changes, whether a run carries them or a session reports them later. */
function applySubagentReport<T extends RunTransitionState>(state: T, threadId: string, event: SubagentReport): T {
  if (event.type === "subagent.started") {
    return updateSubagent(state, threadId, event.id, (existing) => {
      const { finishedAt: _finishedAt, lastToolName: _lastToolName, ...preserved } = existing ?? {};
      return {
        ...preserved,
        id: event.id,
        description: event.description,
        ...(event.agentType ? { agentType: event.agentType } : {}),
        ...(event.sessionScoped ? { sessionScoped: true as const } : {}),
        status: "working",
        startedAt: existing?.startedAt ?? now(),
        activity: existing?.activity ?? [],
      };
    });
  }
  if (event.type === "subagent.status") {
    return updateSubagent(state, threadId, event.id, (existing) => {
      const base: Subagent = existing ?? {
        id: event.id,
        description: "Subagent",
        status: "working",
        startedAt: now(),
        activity: [],
      };
      if (event.status === "working") {
        const { finishedAt: _finishedAt, lastToolName: _lastToolName, ...preserved } = base;
        return { ...preserved, status: "working", ...(event.summary ? { summary: event.summary } : {}) };
      }
      const { finishedAt: _finishedAt, ...preserved } = base;
      return { ...preserved, status: "idle", ...(event.summary ? { summary: event.summary } : {}) };
    });
  }
  if (event.type === "subagent.progress") {
    return updateSubagent(state, threadId, event.id, (existing) => ({
      ...(existing ?? {
        id: event.id,
        status: "working" as const,
        startedAt: now(),
        activity: [],
      }),
      id: event.id,
      description: event.description,
      ...(event.agentType ? { agentType: event.agentType } : {}),
      ...(event.lastToolName ? { lastToolName: event.lastToolName } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      totalTokens: Math.max(existing?.totalTokens ?? 0, event.totalTokens),
    }));
  }
  if (event.type === "subagent.activity") {
    return updateSubagent(state, threadId, event.id, (existing) => {
      const base: Subagent = existing ?? {
        id: event.id,
        description: "Subagent",
        status: "working",
        startedAt: now(),
        activity: [],
      };
      if (base.activity.some((item) => item.id === event.activityId)) return base;
      return {
        ...base,
        activity: [...base.activity, {
          id: event.activityId,
          kind: event.kind,
          ...(event.title ? { title: event.title } : {}),
          text: event.text,
          at: now(),
        }],
      };
    });
  }
  return updateSubagent(state, threadId, event.id, (existing) => ({
    ...(existing ?? {
      id: event.id,
      description: "Subagent",
      startedAt: now(),
      activity: [],
    }),
    status: event.status,
    summary: event.summary || existing?.summary,
    finishedAt: now(),
  }));
}

/** What the agent process reports about work that outlives the run that started it. */
export function applyThreadEvent<T extends RunTransitionState>(state: T, event: ThreadEvent): T {
  switch (event.type) {
    case "subagent.started":
    case "subagent.status":
    case "subagent.progress":
    case "subagent.activity":
    case "subagent.finished":
      return applySubagentReport(state, event.taskId, event);
    case "background.changed":
      return applyBackgroundEvent(state, event);
    case "goal.changed": {
      const goals = { ...state.goals };
      if (event.goal) goals[event.taskId] = event.goal;
      else delete goals[event.taskId];
      return { ...state, goals };
    }
    default:
      return applyWorkflowEvent(state, event);
  }
}

/**
 * What the thread's session has running in the background, kept by the thread: a shell or a monitor
 * outlives the run that started it. A stop already asked for stays marked until the process is gone.
 */
function applyBackgroundEvent<T extends RunTransitionState>(state: T, event: BackgroundEvent): T {
  const stopping = new Set((state.backgroundProcesses[event.taskId] ?? []).filter((process) => process.stopping).map((process) => process.id));
  return withBackgroundProcesses(state, event.taskId, event.processes.map((process) => stopping.has(process.id) ? { ...process, stopping: true } : process));
}

/** What a workflow reports, kept by its thread: the run that started it may be long over. */
function applyWorkflowEvent<T extends RunTransitionState>(state: T, event: WorkflowEvent): T {
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

/** A run reaching its end: the run record goes, and what it left behind is settled on its thread. */
function applyRunFinished<T extends RunTransitionState>(state: T, event: Extract<RunEvent, { type: "run.status" }>): T {
  /** What the run left running is the session's, which outlives it, so only the session can end it. */
  let next = withRunStatus(withActiveRun(withStreamingTail(state, event.taskId, null), event.taskId, null), event.taskId, event.status === "cancelled" ? "stopped" : "idle");
  const { [event.runId]: _expired, ...approvals } = next.approvals;
  next = { ...next, approvals } as T;
  next = updateThread(next, event.taskId, (thread) => ({ ...thread, runEndedAt: now() }));
  const subagents = next.subagents[event.taskId];
  if (subagents?.some((subagent) => subagent.status === "working" && !subagent.sessionScoped)) {
    const status = event.status === "succeeded" ? "completed" : event.status === "failed" ? "failed" : "stopped";
    next = withSubagents(next, event.taskId, subagents.map((subagent) => subagent.status === "working" && !subagent.sessionScoped
      ? { ...subagent, status, finishedAt: now() }
      : subagent));
  }
  /** A run cut short took its workflows with it; a run that answered leaves them running in the background. */
  const workflows = next.workflows[event.taskId];
  if (event.status !== "succeeded" && workflows?.some((workflow) => workflow.status === "running")) {
    next = withWorkflows(next, event.taskId, workflows.map((workflow) => workflow.status === "running"
      ? { ...workflow, status: "stopped" as const, finishedAt: now(), stopping: false }
      : workflow));
  }
  if (event.status === "failed" && event.message) next = updateThread(next, event.taskId, (thread) => ({ ...thread, messages: appendMessages(thread.messages, [createFailureMessage(event.message!)]), updatedAt: now() }));
  return next;
}

export function applyRunEvent<T extends RunTransitionState>(state: T, event: RunEvent): T {
  const active = state.activeRuns[event.taskId];
  if (!active || event.runId !== active.runId || event.sequence <= active.sequence) return state;
  const withSequence = withActiveRun(state, event.taskId, { ...active, sequence: event.sequence });

  if (event.type === "run.started") {
    /** A workflow the last run left running is still going; the ones that ended are that run's history. */
    const carried = (state.workflows[event.taskId] ?? []).filter((workflow) => workflow.status === "running");
    return withWorkflows(withStreamingTail(withSequence, event.taskId, null), event.taskId, carried);
  }
  if (event.type === "run.status") {
    if (event.status === "running" || event.status === "awaiting-approval") {
      return withActiveRun(withSequence, event.taskId, { ...active, sequence: event.sequence, status: event.status });
    }
    return applyRunFinished(withSequence, event);
  }
  if (event.type === "question.requested") {
    const questions = event.request.questions.map((question) => ({ ...question, runId: event.runId, requestId: event.requestId, questionId: question.id, blocking: event.request.blocking }));
    const next = withActiveRun(withSequence, event.taskId, { ...withSequence.activeRuns[event.taskId], questions: [...(active.questions ?? []), ...questions] });
    const messages = questions.map((question) => {
      let text = question.question;
      if (question.options.length) {
        const options = question.options.map((option) => option.description ? `- ${option.label}: ${option.description}` : `- ${option.label}`);
        text += "\n\n" + options.join("\n");
      }
      return createConversationMessage("assistant", text);
    });
    return updateThread(next, event.taskId, (thread) => ({ ...thread, messages: [...thread.messages, ...messages], updatedAt: now() }));
  }
  if (event.type === "question.answered" || event.type === "question.closed") {
    const questions = (active.questions ?? []).filter((question) => question.requestId !== event.requestId || (event.type === "question.answered" && question.questionId !== event.questionId));
    const next = withActiveRun(withSequence, event.taskId, { ...withSequence.activeRuns[event.taskId], questions });
    if (event.type === "question.closed") return next;
    return updateThread(next, event.taskId, (thread) => ({ ...thread, messages: [...thread.messages, createConversationMessage("user", event.text)], updatedAt: now() }));
  }
  if (event.type === "assistant.tail") {
    return withStreamingTail(withSequence, event.taskId, event.text ? { messageId: event.messageId, text: event.text } : null);
  }
  if (event.type === "assistant.delta") {
    /** The block being committed is what the tail was showing, so it stops standing in for it. */
    return updateThread(withStreamingTail(withSequence, event.taskId, null), event.taskId, (thread) => {
      const last = thread.messages.at(-1);
      let messages;
      if (last?.kind === "assistant" && last.id === event.messageId) {
        messages = replaceLastMessage(thread.messages, { ...last, text: `${last.text}${event.append ? "" : "\n"}${event.text}` });
      } else {
        messages = appendMessages(thread.messages, [{ id: event.messageId, kind: "assistant", text: event.text, at: now() }]);
      }
      return { ...thread, messages, updatedAt: now() };
    });
  }
  if (event.type === "context.usage") {
    return updateThread(withSequence, event.taskId, (thread) => ({
      ...thread,
      contextUsage: { tokens: event.tokens, limit: event.limit, model: event.model },
    }));
  }
  if (event.type === "context.compaction-status") {
    const activeState = withActiveRun(withSequence, event.taskId, { ...active, sequence: event.sequence, status: event.compacting ? "compacting" : "running" });
    return event.error
      ? updateThread(activeState, event.taskId, (thread) => ({ ...thread, messages: appendMessages(thread.messages, [createFailureMessage(event.error!)]), updatedAt: now() }))
      : activeState;
  }
  if (event.type === "context.compacted") {
    const activeState = withActiveRun(withSequence, event.taskId, { ...active, sequence: event.sequence, status: "running" });
    return updateThread(activeState, event.taskId, (thread) => ({
      ...thread,
      messages: appendMessages(thread.messages, [createConversationMessage(
        "system",
        event.postTokens === undefined
          ? `Context ${event.trigger}-compacted at ${event.preTokens.toLocaleString("en-US")} tokens.`
          : `Context ${event.trigger}-compacted: ${event.preTokens.toLocaleString("en-US")} → ${event.postTokens.toLocaleString("en-US")} tokens.`,
      )]),
      ...(thread.contextUsage && event.postTokens !== undefined
        ? { contextUsage: { ...thread.contextUsage, tokens: event.postTokens } }
        : {}),
      updatedAt: now(),
    }));
  }
  if (event.type === "tool.intent") {
    return updateThread(withSequence, event.taskId, (thread) => ({
      ...thread,
      messages: appendMessages(thread.messages, [createConversationMessage("tool", event.intent.name, JSON.stringify(event.intent.input, null, 2))]),
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
    /** A session of the thread's own ends any inheritance: a copy forks what it was given until then. */
    return updateThread(withSequence, event.taskId, ({ inheritedContinuation: _spent, ...thread }) => ({ ...thread, continuation: event.continuation, continuationStatus: "available", updatedAt: now() }));
  }
  if (event.type === "continuation.lost") {
    return updateThread(withSequence, event.taskId, ({ continuation: _lost, ...thread }) => ({ ...thread, continuationStatus: "invalid", updatedAt: now() }));
  }
  return withSequence;
}
