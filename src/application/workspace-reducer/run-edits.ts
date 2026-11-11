/**
 * The run state, which only its owner rewrites: runs on their way, the messages waiting for them, and
 * what each live one reports. Another feature changes it through the functions here, each named for
 * what it means, or not at all.
 */
import type { PendingQuestion } from "../../domain/agent-question.js";
import type { PendingRun, QueuedMessage, RunsState } from "../state/runs.js";
import { withoutMatchingValues, withoutThreadKeys } from "../removals.js";
import { applyThreadEvent, withActiveRun, withApprovalAnswered, withBackgroundProcesses, withRunStatus, withSubagents, withWorkflows, type FinishedVerdict, type ThreadRunStatus } from "../thread-run-state.js";
import type { ThreadEvent } from "../../contracts/ipc.js";
import type { Thread } from "../../domain/thread.js";
import type { Subagent } from "../../domain/run.js";

/** The run state as one input leaves it. Only the functions here make one. */
class RunsChange {
  private declare readonly owned: never;
  constructor(readonly view: RunsState) {}
}

export type RunsEdit = RunsChange;

export function runsOf(state: RunsState): RunsEdit {
  const {
    activeRuns, runStatuses, approvals, streamingTails, backgroundProcesses, workflows, subagents, goals,
    pendingRuns, startingProposals, quietStops, quietSessions, queuedMessages, lastRunIds,
  } = state;
  return new RunsChange({
    activeRuns, runStatuses, approvals, streamingTails, backgroundProcesses, workflows, subagents, goals,
    pendingRuns, startingProposals, quietStops, quietSessions, queuedMessages, lastRunIds,
  });
}

/** A run on its way, resolving its checkout. */
export function pendingIn(edit: RunsEdit, pending: PendingRun): RunsEdit {
  return new RunsChange({ ...edit.view, pendingRuns: { ...edit.view.pendingRuns, [pending.id]: pending } });
}

/** A run no longer on its way, whether it started or was dropped. */
export function withoutPendingIn(edit: RunsEdit, pendingId: string): RunsEdit {
  const { [pendingId]: _settled, ...pendingRuns } = edit.view.pendingRuns;
  return new RunsChange({ ...edit.view, pendingRuns });
}

/** What waits behind a thread's run, in order. An empty queue is dropped. */
export function queuedIn(edit: RunsEdit, taskId: string, messages: QueuedMessage[]): RunsEdit {
  if (messages.length) return new RunsChange({ ...edit.view, queuedMessages: { ...edit.view.queuedMessages, [taskId]: messages } });
  const { [taskId]: _drained, ...queuedMessages } = edit.view.queuedMessages;
  return new RunsChange({ ...edit.view, queuedMessages });
}

/** One of the questions a thread's live run is waiting on, with what the user has written in answer so far. */
export function questionAnswerIn(edit: RunsEdit, taskId: string, question: PendingQuestion, answer: Pick<PendingQuestion, "answer" | "submitting">): RunsEdit {
  const active = edit.view.activeRuns[taskId];
  if (!active) return edit;
  const questions = active.questions?.map((pending) => pending === question ? { ...pending, ...answer } : pending);
  return new RunsChange({ ...edit.view, activeRuns: { ...edit.view.activeRuns, [taskId]: { ...active, questions } } });
}

/** A scheduled run a person joined, which is theirs from then on. */
export function attendedIn(edit: RunsEdit, taskId: string): RunsEdit {
  const active = edit.view.activeRuns[taskId];
  if (!active || active.origin === "composer") return edit;
  return new RunsChange({ ...edit.view, activeRuns: { ...edit.view.activeRuns, [taskId]: { ...active, origin: "composer" } } });
}

/** A coordinator's suggestion whose thread is on its way. */
export function proposalStartingIn(edit: RunsEdit, proposalId: string): RunsEdit {
  return new RunsChange({ ...edit.view, startingProposals: [...edit.view.startingProposals, proposalId] });
}

/** A suggestion no longer starting, whether it started, failed, or was stopped. */
export function proposalSettledIn(edit: RunsEdit, proposalId: string): RunsEdit {
  if (!edit.view.startingProposals.includes(proposalId)) return edit;
  return new RunsChange({ ...edit.view, startingProposals: edit.view.startingProposals.filter((id) => id !== proposalId) });
}

/** How a thread reads while no run of its own is live: idle, which is dropped, or stopped. */
export function runStatusIn(edit: RunsEdit, taskId: string, status: ThreadRunStatus): RunsEdit {
  return new RunsChange({ ...edit.view, runStatuses: withRunStatus({ runStatuses: edit.view.runStatuses }, taskId, status).runStatuses });
}

/** The Stop all that cancelled this run answered by its end. */
export function runAnsweredIn(edit: RunsEdit, runId: string): RunsEdit {
  return new RunsChange({ ...edit.view, quietStops: edit.view.quietStops.filter((id) => id !== runId) });
}

/** How long after Stop all stopped a thread's session work the agent's own turn is still its answer to that stop. */
const STOP_ANSWER_MS = 2 * 60_000;

/** Whether a turn the agent opens at `at` could still be its answer to the stop that hushed its session. */
export function answersInTime(session: { at: number }, at: number): boolean {
  return at - session.at <= STOP_ANSWER_MS;
}

/**
 * What a Stop all at `at` answers for here: the runs it cancelled, and the threads whose session work
 * it stopped. A run that never said it ended leaves its id behind, so only runs still going are kept,
 * and a stop of a thread's session work the agent never answered in time is let go of.
 */
export function stopAllIn(edit: RunsEdit, cancelled: readonly string[], hushed: readonly string[], threads: readonly Thread[], at: number): RunsEdit {
  const going = new Set(Object.values(edit.view.activeRuns).map((run) => run.runId));
  const quietStops = [...edit.view.quietStops.filter((runId) => going.has(runId)), ...cancelled];
  const stopped = new Set(hushed);
  const quietSessions = [
    ...edit.view.quietSessions.filter((session) => !stopped.has(session.taskId) && answersInTime(session, at) && threads.some((thread) => thread.id === session.taskId)),
    ...[...stopped].map((taskId) => ({ taskId, at })),
  ];
  return new RunsChange({ ...edit.view, quietStops, quietSessions });
}

/**
 * A stop asked of what a thread's session runs in the background, a workflow or a subagent included,
 * marked on its row until it is gone. Null when there is nothing there still to stop.
 */
export function stopAskedIn(edit: RunsEdit, taskId: string, processId: string): RunsEdit | null {
  const { view } = edit;
  const processes = view.backgroundProcesses[taskId] ?? [];
  const target = processes.find((process) => process.id === processId);
  if (target) {
    if (target.stopping) return null;
    return new RunsChange({ ...view, ...withBackgroundProcesses(view, taskId, processes.map((process) => process.id === target.id ? { ...process, stopping: true } : process)) });
  }
  const workflows = view.workflows[taskId] ?? [];
  const workflow = workflows.find((candidate) => candidate.id === processId);
  if (workflow) {
    if (workflow.stopping || workflow.status !== "running") return null;
    return new RunsChange({ ...view, ...withWorkflows(view, taskId, workflows.map((candidate) => candidate.id === workflow.id ? { ...candidate, stopping: true } : candidate)) });
  }
  const subagents = view.subagents[taskId] ?? [];
  const subagent = subagents.find((candidate) => candidate.id === processId);
  if (!subagent || subagent.stopping || subagent.status !== "working") return null;
  return new RunsChange({ ...view, ...withSubagents(view, taskId, subagents.map((candidate) => candidate.id === subagent.id ? { ...candidate, stopping: true as const } : candidate)) });
}

/** A scheduled run that answered for itself, having found something: news unless `raised` is false, and the issue it named. */
export function notifiedIn(edit: RunsEdit, taskId: string, raised: boolean, key: string | undefined): RunsEdit {
  const active = edit.view.activeRuns[taskId];
  if (!active) return edit;
  const reportedIssues = key === undefined || active.reportedIssues.includes(key) ? active.reportedIssues : [...active.reportedIssues, key];
  return new RunsChange({ ...edit.view, activeRuns: { ...edit.view.activeRuns, [taskId]: { ...active, acknowledged: true, notified: active.notified || raised, reportedIssues } } });
}

/** A scheduled run that answered for itself, having found nothing. */
export function acknowledgedIn(edit: RunsEdit, taskId: string): RunsEdit {
  const active = edit.view.activeRuns[taskId];
  if (!active) return edit;
  return new RunsChange({ ...edit.view, activeRuns: { ...edit.view.activeRuns, [taskId]: { ...active, acknowledged: true } } });
}

/** A run whose thread was dismissed while it went on. */
export function runDismissedIn(edit: RunsEdit, taskId: string): RunsEdit {
  const active = edit.view.activeRuns[taskId];
  if (!active || active.dismissed) return edit;
  return new RunsChange({ ...edit.view, activeRuns: { ...edit.view.activeRuns, [taskId]: { ...active, dismissed: true } } });
}

/** Watches, keyed by thread, that ended while a tick of each was going: a tick that settles unseen puts its thread back to its verdict. */
export function watchesEndedBeforeIn(edit: RunsEdit, verdicts: ReadonlyMap<string, FinishedVerdict>): RunsEdit {
  let activeRuns: RunsState["activeRuns"] | undefined;
  for (const taskId in edit.view.activeRuns) {
    const verdict = verdicts.get(taskId);
    const active = edit.view.activeRuns[taskId];
    if (!verdict || !active) continue;
    activeRuns ??= { ...edit.view.activeRuns };
    activeRuns[taskId] = { ...active, before: { ...active.before, ...verdict } };
  }
  return activeRuns ? new RunsChange({ ...edit.view, activeRuns }) : edit;
}

/** What a thread's session reports of work that outlives the run that started it, as {@link applyThreadEvent} keeps it. */
export function threadEventIn(edit: RunsEdit, event: ThreadEvent): RunsEdit {
  return new RunsChange(applyThreadEvent(edit.view, event));
}

/** A subagent's log as its run kept it, ahead of whatever it has reported since. */
export function subagentActivityIn(edit: RunsEdit, taskId: string, subagentId: string, activity: Subagent["activity"]): RunsEdit {
  const stored = new Set(activity.map((item) => item.id));
  const held = edit.view.subagents[taskId] ?? [];
  return new RunsChange(withSubagents(edit.view, taskId, held.map((subagent) => subagent.id === subagentId
    ? { ...subagent, activity: [...activity, ...subagent.activity.filter((item) => !stored.has(item.id))] }
    : subagent)));
}

/** Threads gone for good leave no run, queue, approval or report of theirs behind. */
export function runsForgottenIn(edit: RunsEdit, removed: Set<string>): RunsEdit {
  const { view } = edit;
  return new RunsChange({
    ...view,
    pendingRuns: withoutMatchingValues(view.pendingRuns, (pending) => Boolean(pending.taskId && removed.has(pending.taskId))),
    queuedMessages: withoutThreadKeys(view.queuedMessages, removed),
    lastRunIds: withoutThreadKeys(view.lastRunIds, removed),
    activeRuns: withoutThreadKeys(view.activeRuns, removed),
    runStatuses: withoutThreadKeys(view.runStatuses, removed),
    approvals: withoutMatchingValues(view.approvals, (approval) => removed.has(approval.taskId)),
    streamingTails: withoutThreadKeys(view.streamingTails, removed),
    backgroundProcesses: withoutThreadKeys(view.backgroundProcesses, removed),
    workflows: withoutThreadKeys(view.workflows, removed),
    subagents: withoutThreadKeys(view.subagents, removed),
  });
}

/** A thread's live run with its approval answered, running again. */
export function approvalAnsweredIn(edit: RunsEdit, taskId: string): RunsEdit {
  return new RunsChange(withApprovalAnswered(edit.view, taskId));
}

/** The user stopping a thread's run, which the run remembers, so however it ends first it ends as the stop asked. */
export function cancellingIn(edit: RunsEdit, taskId: string): RunsEdit {
  const active = edit.view.activeRuns[taskId];
  if (!active || active.cancelling) return edit;
  return new RunsChange(withActiveRun(edit.view, taskId, { ...active, cancelling: true }));
}
