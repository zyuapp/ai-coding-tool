/**
 * What a run said for itself, and whether it reaches the user. A function belongs here when it needs
 * the run behind the thread: where the run came from, whether it answered, and what it reported.
 */
import type { RunEvent } from "../contracts/ipc.js";
import type { FindingReport } from "../contracts/threads.js";
import { isNews, withFinding } from "../domain/attention.js";
import type { RunStatus } from "../domain/run.js";
import type { ThreadOutcome } from "../domain/thread-run.js";
import { threadOnScreen, type ScreenState } from "./thread-attention.js";
import { updateThread, type ActiveRun, type RunTransitionState } from "./thread-run-state.js";

/**
 * The verdict a settled turn leaves its thread, which is what ranks it. Only a thread the user was
 * not already looking at is marked unread by it; the one on screen they cannot have missed. A thread
 * already filed away is past ranking, so it is left none.
 */
export function withVerdict<T extends RunTransitionState & ScreenState>(state: T, taskId: string, outcome: ThreadOutcome): T {
  const unread = threadOnScreen(state, taskId) ? {} : { outcomeUnread: true as const };
  return updateThread(state, taskId, (thread) => thread.archivedAt !== undefined ? thread : { ...thread, outcome, ...unread });
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
  const raised = state.threads.some((thread) => thread.id === taskId && isNews(thread, report.key));
  return {
    ...state,
    activeRuns: { ...state.activeRuns, [taskId]: {
      ...active,
      acknowledged: true,
      notified: active.notified || raised,
      reportedIssues: report.key === undefined || active.reportedIssues.includes(report.key) ? active.reportedIssues : [...active.reportedIssues, report.key],
    } },
    threads: state.threads.map((thread) => thread.id === taskId ? withFinding(thread, report, at, seen) : thread),
  };
}

/** A run saying it looked and found nothing. What it says never retracts what it already surfaced. */
export function withNothingToReport<T extends RunTransitionState>(state: T, taskId: string, checked: string, at: number): T {
  const active = scheduledRun(state, taskId);
  if (!active) return state;
  const acknowledged = { ...state, activeRuns: { ...state.activeRuns, [taskId]: { ...active, acknowledged: true } } };
  return updateThread(acknowledged, taskId, (thread) => ({ ...thread, lastChecked: { at, note: checked } }));
}

/** Why a settling run reaches the user, or null when it has earned its silence. */
export type RunSurfacing = "failed" | "cancelled" | "attended" | "loud" | "reported" | "no-answer";

/** How the run left off. Only a run that reached an end of its own finished or failed. */
function howRunEnded(status: RunStatus | undefined): "finished" | "failed" | "cancelled" {
  return status === "succeeded" ? "finished" : status === "failed" ? "failed" : "cancelled";
}

/** What the run said for itself. Only a quiet scheduled run that answered and raised nothing is silent. */
function whatRunSaid(active: Pick<ActiveRun, "origin" | "quiet" | "acknowledged" | "notified">): "attended" | "loud" | "reported" | "no-answer" | null {
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
  return whyTurnSurfaces(active, event.type === "run.status" ? event.status : undefined);
}

/** Why a turn ending with this status reaches the user. One that ends with no run behind it was the user's own. */
export function whyTurnSurfaces(run: Pick<ActiveRun, "origin" | "quiet" | "acknowledged" | "notified"> | undefined, status: RunStatus | undefined): RunSurfacing | null {
  const ending = howRunEnded(status);
  if (ending !== "finished") return ending;
  return run ? whatRunSaid(run) : "attended";
}

/**
 * The line a settling run puts on the desktop, or null when it has none to put there. A scheduled run
 * speaks through what it finds, so only a failure of one is worth taking to the user this way.
 */
export function settledHeadline(surfacing: RunSurfacing | null, message?: string): string | null {
  if (surfacing === "failed") return message?.trim() || "The run failed.";
  return surfacing === "attended" ? "The run finished." : null;
}
