/**
 * What a run said for itself, and whether it reaches the user. A function belongs here when it needs
 * the run behind the thread: where the run came from, whether it answered, and what it reported.
 */
import type { FindingReport } from "../contracts/threads.js";
import { isNews } from "../domain/attention.js";
import type { FindingsThread } from "../domain/finding.js";
import type { RunStatus } from "../domain/run.js";
import type { ThreadOutcome } from "../domain/thread-run.js";
import { threadOnScreen } from "./thread-attention.js";
import { acknowledgedIn, notifiedIn, runsOf } from "./workspace-reducer/run-edits.js";
import { afterward, type Step } from "./workspace-reducer/slice.js";
import { editThread, findingIn, threadsOf, verdictIn } from "./workspace-reducer/thread-edits.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { ActiveRun, RunTransitionState } from "./thread-run-state.js";

/**
 * The verdict a settled turn leaves its thread, which is what ranks it. Only a thread the user was
 * not already looking at is marked unread by it; the one on screen they cannot have missed. A thread
 * already filed away is past ranking, so it is left none.
 */
export function withVerdict(state: WorkspaceState, taskId: string, outcome: ThreadOutcome): WorkspaceState {
  return afterward(state, { edits: [verdictIn(threadsOf(state), taskId, outcome, !threadOnScreen(state, taskId))] });
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
export function notifiedRun(state: WorkspaceState, taskId: string, report: FindingReport, at: number, seen = false): Step {
  if (!scheduledRun(state, taskId)) return {};
  /** A duplicate is still the run answering for itself, but it is not news, so it does not break the silence. */
  const raised = state.threads.some((thread) => thread.id === taskId && isNews(thread, report.key));
  return { edits: [notifiedIn(runsOf(state), taskId, raised, report.key), findingIn(threadsOf(state), taskId, report, at, seen)] };
}

/** A run saying it looked and found nothing. What it says never retracts what it already surfaced. */
export function nothingToReport(state: WorkspaceState, taskId: string, checked: string, at: number): Step<FindingsThread> {
  if (!scheduledRun(state, taskId)) return {};
  return { edits: [acknowledgedIn(runsOf(state), taskId), editThread(threadsOf<FindingsThread>(state), taskId, () => ({ lastChecked: { at, note: checked } }))] };
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
