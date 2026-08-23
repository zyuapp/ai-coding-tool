/**
 * What a run said for itself, and whether it reaches the user. A function belongs here when it needs
 * the run behind the thread: where the run came from, whether it answered, and what it reported.
 */
import type { RunEvent } from "../contracts/ipc.js";
import type { FindingReport } from "../contracts/threads.js";
import { findingOutcome, withFinding, withLiftedSilences } from "../domain/attention.js";
import type { TaskOutcome } from "../domain/task.js";
import { applyTask, silencedThread, type ActiveRun, type RunTransitionState } from "./task-workspace.js";

/** A run only earns a verdict when it settles on its own; cancelling is the user's own doing. */
export function outcomeFor(event: RunEvent): TaskOutcome | null {
  if (event.type !== "run.status") return null;
  if (event.status === "succeeded") return "finished";
  if (event.status === "failed") return "failed";
  return null;
}

/** The run a scheduled tick is executing, and nothing else. Silence is only ever a schedule's to earn. */
export function scheduledRun(state: RunTransitionState, taskId: string): ActiveRun | undefined {
  const active = state.activeRuns[taskId];
  return active?.origin === "automation" ? active : undefined;
}

/**
 * Records what a run found and marks the run as having answered for itself. Anything the thread was
 * not already carrying is news, so the run surfaces; only a duplicate leaves the silence intact.
 */
export function withNotifiedRun<T extends RunTransitionState>(state: T, taskId: string, report: FindingReport, at: number, seen = false): T {
  const active = scheduledRun(state, taskId);
  if (!active) return state;
  /** A duplicate is still the run answering for itself, but it is not news, so it does not break the silence. */
  const raised = state.tasks.some((task) => task.id === taskId && findingOutcome(task, report.key) === "recorded");
  return {
    ...state,
    activeRuns: { ...state.activeRuns, [taskId]: {
      ...active,
      acknowledged: true,
      notified: active.notified || raised,
      reportedKeys: report.key === undefined || active.reportedKeys.includes(report.key) ? active.reportedKeys : [...active.reportedKeys, report.key],
    } },
    tasks: state.tasks.map((task) => task.id === taskId ? withFinding(task, report, at, seen) : task),
  };
}

/** A run saying it looked and found nothing. What it says never retracts what it already surfaced. */
export function withNothingToReport<T extends RunTransitionState>(state: T, taskId: string, checked: string, at: number): T {
  const active = scheduledRun(state, taskId);
  if (!active) return state;
  const acknowledged = { ...state, activeRuns: { ...state.activeRuns, [taskId]: { ...active, acknowledged: true } } };
  return applyTask(acknowledged, taskId, (task) => ({ ...task, lastChecked: { at, note: checked } }));
}

/**
 * Whether this run settled with nothing to say. Silence is earned by a scheduled quiet run that
 * succeeded and answered for itself without raising anything new: a failure, a cancellation, a run
 * that found something, and a run that answered nothing at all surface as they always have.
 */
export function settledUnseen(active: ActiveRun, event: RunEvent): boolean {
  return active.origin === "automation"
    && active.quiet
    && event.type === "run.status"
    && event.status === "succeeded"
    && active.acknowledged
    && !active.notified;
}

/**
 * What a settling run leaves on its thread besides a verdict: an unseen tick puts the thread back
 * where it found it, and a scheduled run that finished looking lifts the filed-away findings it no
 * longer reports.
 */
export function withSettledTick<T extends RunTransitionState>(state: T, taskId: string, active: ActiveRun, unseen: boolean, outcome: TaskOutcome): T {
  const lifting = outcome === "finished" && active.origin === "automation" && active.acknowledged;
  if (!unseen && !lifting) return state;
  return applyTask(state, taskId, (task) => {
    const settled = unseen ? silencedThread(task, active.messagesBefore, active.before) : task;
    return lifting ? withLiftedSilences(settled, active.reportedKeys) : settled;
  });
}
