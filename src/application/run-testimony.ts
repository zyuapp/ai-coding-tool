/**
 * What a run said for itself, and whether it reaches the user. A function belongs here when it needs
 * the run behind the thread: where the run came from, whether it answered, and what it reported.
 */
import type { RunEvent } from "../contracts/ipc.js";
import type { FindingReport } from "../contracts/threads.js";
import { isNews, withClosedIssues, withFinding } from "../domain/attention.js";
import type { TaskOutcome } from "../domain/task.js";
import { applyTask, withdrawRun, type ActiveRun, type RunTransitionState } from "./task-workspace.js";

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
  const raised = state.tasks.some((task) => task.id === taskId && isNews(task, report.key));
  return {
    ...state,
    activeRuns: { ...state.activeRuns, [taskId]: {
      ...active,
      acknowledged: true,
      notified: active.notified || raised,
      reportedIssues: report.key === undefined || active.reportedIssues.includes(report.key) ? active.reportedIssues : [...active.reportedIssues, report.key],
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

/** Why a settling run reaches the user, or null when it has earned its silence. */
export type RunSurfacing = "failed" | "cancelled" | "attended" | "loud" | "reported" | "no-answer";

/** How the run left off. Anything that is not a verdict of its own was ended for it. */
function howRunEnded(event: RunEvent): "finished" | "failed" | "cancelled" {
  return outcomeFor(event) ?? "cancelled";
}

/** What the run said for itself. Only a quiet scheduled run that answered and raised nothing is silent. */
function whatRunSaid(active: ActiveRun): "attended" | "loud" | "reported" | "no-answer" | null {
  if (active.origin !== "automation") return "attended";
  if (!active.quiet) return "loud";
  if (!active.acknowledged) return "no-answer";
  return active.notified ? "reported" : null;
}

/**
 * Why this run reaches the user, or null when it settles with nothing to say. Silence is earned by
 * a scheduled quiet run that succeeded and answered for itself without raising anything new.
 */
export function whyRunSurfaces(active: ActiveRun, event: RunEvent): RunSurfacing | null {
  const ending = howRunEnded(event);
  return ending === "finished" ? whatRunSaid(active) : ending;
}

/**
 * What a settling run leaves on its thread besides a verdict: a run that surfaced nothing puts the
 * thread back where it found it, and a scheduled run that finished looking closes the filed-away
 * issues it no longer reports.
 */
export function withSettledTick<T extends RunTransitionState>(state: T, taskId: string, active: ActiveRun, surfacing: RunSurfacing | null): T {
  const unseen = surfacing === null;
  const finished = surfacing !== "failed" && surfacing !== "cancelled";
  const closing = finished && active.origin === "automation" && active.acknowledged;
  if (!unseen && !closing) return state;
  return applyTask(state, taskId, (task) => {
    const settled = unseen ? withdrawRun(task, active.messagesBefore, active.before) : task;
    return closing ? withClosedIssues(settled, active.reportedIssues) : settled;
  });
}
