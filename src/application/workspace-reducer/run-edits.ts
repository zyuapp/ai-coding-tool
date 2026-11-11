/**
 * The run state, which only its owner rewrites: runs on their way, the messages waiting for them, and
 * what each live one reports. Another feature changes it through the functions here, each named for
 * what it means, or not at all.
 */
import type { PendingQuestion } from "../../domain/agent-question.js";
import type { PendingRun, QueuedMessage, RunsState } from "../state/runs.js";

/** The run state as one input leaves it. Only the functions here make one. */
class RunsChange {
  private declare readonly owned: never;
  constructor(readonly view: RunsState) {}
}

export type RunsEdit = RunsChange;

export function runsOf(state: RunsState): RunsEdit {
  const {
    activeRuns, runStatuses, approvals, streamingTails, backgroundProcesses, workflows, subagents,
    pendingRuns, startingProposals, quietStops, quietSessions, queuedMessages, lastRunIds,
  } = state;
  return new RunsChange({
    activeRuns, runStatuses, approvals, streamingTails, backgroundProcesses, workflows, subagents,
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
