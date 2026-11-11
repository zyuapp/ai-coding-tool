/**
 * How a turn ends. The facts of its end go in and one settlement comes out: how it reads, whether it
 * reaches the user, whether it waits out a usage limit, what becomes of its queue, and what its
 * coordinator hears. Every way a turn ends, a run settling, a wait the user cancels, the app quitting
 * under it, or compacting, is settled here.
 */
import { drained, type QueueIntent } from "./workspace-reducer/run-queue.js";
import { runAnsweredIn, runStatusIn, runsOf } from "./workspace-reducer/run-edits.js";
import { afterward, andThen, applied, type Step } from "./workspace-reducer/slice.js";
import { engineLimitIn, limitPausedIn, newsQuietedIn, notedIn, reopenedIn, testimonyRestoredIn, threadsOf, turnEndedIn, verdictIn, withdrawnIn, type ThreadsEdit } from "./workspace-reducer/thread-edits.js";
import type { WorkspaceTransition } from "./workspace-reducer/types.js";
import { heardFacts } from "./member-facts.js";
import { whyTurnSurfaces, type RunSurfacing } from "./run-testimony.js";
import { threadOnScreen } from "./thread-attention.js";
import { turnEndStatus, type ActiveRun } from "./thread-run-state.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { RunEvent } from "../contracts/ipc.js";
import { coordinatorOf, endsAsStopped, isCoordinator } from "../domain/coordination.js";
import { runOutcome, type ThreadOutcome } from "../domain/thread-run.js";
import type { Thread } from "../domain/thread.js";
import { resumesOnItsOwn, type LimitPause, type UsageLimit } from "../domain/usage-limit.js";

export type TurnStatus = "succeeded" | "failed" | "cancelled";

/** Who asked a turn to end before it ended by itself: the user, Stop all, or the app quitting under it. */
export type StopIntent = "user" | "stop-all" | "quit";

/** What a turn's end is settled on. A turn that ends with no run, waiting in line or cut off with the app, has no `run`. */
export type TurnEnd = {
  status: TurnStatus;
  message?: string;
  limit?: UsageLimit;
  run?: Pick<ActiveRun, "origin" | "quiet" | "acknowledged" | "notified" | "usersOwn" | "answersStop" | "operation">;
  stop?: StopIntent;
};

export type Settlement = {
  /** How the turn is taken to have ended, which its moves go by. */
  status: TurnStatus;
  /** What becomes of its queue: the next message goes, or a cancelled turn hands it back. */
  queue: Extract<QueueIntent, "deliver" | "hand-back">;
  /** The failure the turn ends with, in the engine's words. */
  message?: string;
  /** Why the turn reaches the user, or null when it earned its silence. */
  surfacing: RunSurfacing | null;
  /** The verdict it leaves its thread, or null when it leaves none. */
  verdict: ThreadOutcome | null;
  /** How the thread reads its last run ended, or null when the turn has not ended but carries on after a session limit. */
  runEndedAs: ThreadOutcome | null;
  /** Compacting is not a turn, so how the last turn ended, its verdict and its report are put back. */
  restoresTestimony: boolean;
  /** A tick that earned its silence puts its thread back as if it never ran. */
  withdraws: boolean;
  /** A scheduled run that finished looking closes the filed-away issues it no longer reports. */
  closesIssues: boolean;
  /** The usage limit the turn reached, and whether its thread waits in line for it rather than only its engine's waiting threads. */
  limit: { reached: UsageLimit; waits: boolean } | null;
  /** A resolved thread left stuck by a failed turn is open again. */
  reopens: boolean;
  /** What its coordinator here hears, or null when it hears nothing. A quiet note waits for the next wake. */
  heard: { quiet: boolean } | null;
  /** The Stop all that asked for this end is answered. */
  answersStopAll: boolean;
  /** A coordinator cut off keeps what news it held quiet, as one the user stopped does. */
  hushesNews: boolean;
};

/**
 * Whether a thread's turn ending is heard only with its coordinator's next wake. What Stop all
 * stopped is quiet once it has stopped, as is the turn the agent opened itself to answer that stop,
 * and a turn cut off with the app. A turn the user's own message started is theirs, and they are
 * there to see it end, unless it failed.
 */
export function endsQuietly({ status, stop, answersStop, usersOwn }: { status: TurnStatus; stop?: StopIntent | undefined; answersStop?: boolean | undefined; usersOwn?: boolean | undefined }): boolean {
  return answersStop === true
    || stop === "quit"
    || stop === "stop-all" && endsAsStopped(runOutcome(status) ?? undefined)
    || usersOwn === true && status !== "failed";
}

/**
 * Settles a turn's end. A turn being stopped that a session limit got to first ends as the stop
 * asked, rather than waiting in line to carry on by itself; a weekly limit waits for the user either
 * way, so it is said as the failure it is. Either limit is its account's, so it still holds its
 * engine's waiting threads. A turn that
 * waits out a session limit carries on by itself, so it is no news and not yet the end of its turn.
 */
export function settleTurn(end: TurnEnd): Settlement {
  const stopping = end.stop !== undefined || end.run?.answersStop === true;
  const stoppedFirst = stopping && end.status === "failed" && end.limit?.window === "session";
  const status: TurnStatus = stoppedFirst ? "cancelled" : end.status;
  const message = stoppedFirst ? undefined : end.message;
  const ended = runOutcome(status);
  const queue = status === "cancelled" ? "hand-back" : "deliver";
  if (end.run?.operation === "compact") {
    return { status, queue, ...(message === undefined ? {} : { message }), surfacing: null, verdict: null, runEndedAs: ended, restoresTestimony: true, withdraws: false, closesIssues: false, limit: null, reopens: false, heard: null, answersStopAll: false, hushesNews: false };
  }
  const surfacing = whyTurnSurfaces(end.run, status);
  const unseen = surfacing === null;
  const reached = end.status === "failed" ? end.limit : undefined;
  const carriesOn = reached !== undefined && !stopping && resumesOnItsOwn(reached);
  const finished = surfacing !== "failed" && surfacing !== "cancelled";
  return {
    status,
    queue,
    ...(message === undefined ? {} : { message }),
    surfacing,
    verdict: unseen || carriesOn ? null : ended,
    runEndedAs: carriesOn ? null : ended,
    restoresTestimony: false,
    withdraws: unseen,
    closesIssues: finished && end.run?.origin === "automation" && end.run.acknowledged,
    limit: reached ? { reached, waits: !stopping } : null,
    reopens: status === "failed" && !carriesOn,
    heard: unseen || carriesOn ? null : { quiet: endsQuietly({ status, stop: end.stop, answersStop: end.run?.answersStop, usersOwn: end.run?.usersOwn }) },
    answersStopAll: !unseen && end.stop === "stop-all",
    hushesNews: end.stop === "quit",
  };
}

/** The status event a run's end is applied as: one stopped before its limit drops the limit and the failure with it. */
export function settledEvent(event: Extract<RunEvent, { type: "run.status" }>, settlement: Settlement): Extract<RunEvent, { type: "run.status" }> {
  if (event.status === settlement.status) return event;
  const { limit: _waited, message: _said, ...stopped } = event;
  return { ...stopped, status: settlement.status };
}

/**
 * Applies a settlement to a thread whose turn has already closed, its run record gone and its end
 * stamped. `run` is the run that ended, when one did; `at` is when.
 */
export function withSettledTurn(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): WorkspaceState {
  return afterward(state, settledTurnStep(state, taskId, settlement, run, at));
}

/** {@link withSettledTurn}, as the edits it makes. */
function settledTurnStep(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): Step {
  if (settlement.restoresTestimony) return run ? { edits: [testimonyRestoredIn(threadsOf(state), taskId, run.before)] } : {};
  return andThen(state, turnTestimony(state, taskId, settlement, run), (next) => turnAftermath(next, taskId, settlement, run, at));
}

/**
 * What the turn leaves on its own thread: its verdict, and for a tick, the run withdrawn or its
 * filed-away issues closed. Anything the thread takes on after this, such as the move it asked to
 * make, stays.
 */
export function withTurnTestimony(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined): WorkspaceState {
  return afterward(state, turnTestimony(state, taskId, settlement, run));
}

function turnTestimony(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined): Step {
  if (settlement.restoresTestimony) return {};
  let threads = threadsOf(state);
  /** Only a thread the user was not already looking at is marked unread by it; the one on screen they cannot have missed. */
  if (settlement.verdict) threads = verdictIn(threads, taskId, settlement.verdict, !threadOnScreen(state, taskId));
  if (run && (settlement.withdraws || settlement.closesIssues)) threads = withdrawnIn(threads, taskId, run, settlement);
  return { edits: [threads] };
}

/** Takes up the thread's queue once its testimony is already left, as the turn's end says. */
export function settledAfterTestimony(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): WorkspaceTransition {
  return applied(state, andThen(state, turnAftermath(state, taskId, settlement, run, at), (next) => drained(next, taskId, settlement.queue)));
}

/** What follows from the turn's end beyond its testimony: its usage limit, a reopening, Stop all's answer, and its coordinator. */
function turnAftermath(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): Step {
  let threads = threadsOf(state);
  let runs = runsOf(state);
  if (settlement.limit) threads = settlement.limit.waits ? pausedForLimit(state, threads, taskId, settlement.limit.reached, settlement.runEndedAs === null, at) : engineLimitIn(threads, taskId, settlement.limit.reached);
  if (settlement.reopens) threads = reopenedIn(threads, taskId);
  if (settlement.answersStopAll && run) runs = runAnsweredIn(runs, run.runId);
  const thread = threads.view.threads.find((item) => item.id === taskId);
  if (settlement.heard && thread) threads = turnHeard(afterward(state, { edits: [threads, runs] }), threads, thread, settlement.status, at, settlement.heard.quiet);
  if (settlement.hushesNews && isCoordinator(thread)) threads = newsQuietedIn(threads, taskId);
  return { edits: [threads, runs] };
}

/** Applies a settlement and takes up the thread's queue as the turn's end says. */
export function settledTurn(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): WorkspaceTransition {
  return applied(state, turnSettled(state, taskId, settlement, run, at));
}

/** {@link settledTurn}, as the edits it makes. */
export function turnSettled(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): Step {
  return andThen(state, settledTurnStep(state, taskId, settlement, run, at), (next) => drained(next, taskId, settlement.queue));
}

/** A thread's turn ending with `status`: it reads as stopped or idle, and keeps how and when it ended. */
export function turnEnded(state: WorkspaceState, taskId: string, status: TurnStatus): Step {
  return { edits: [runStatusIn(runsOf(state), taskId, turnEndStatus(status)), turnEndedIn(threadsOf(state), taskId, status)] };
}

/** Puts a thread whose run hit the limit in line. One that carries on by itself has its verdict and its end taken off. */
function pausedForLimit(state: WorkspaceState, threads: ThreadsEdit, taskId: string, limit: UsageLimit, carriesOn: boolean, at: number): ThreadsEdit {
  if (!threads.view.threads.some((item) => item.id === taskId)) return threads;
  const workflow = (state.workflows[taskId] ?? []).some((item) => item.status === "stopped");
  const pause: LimitPause = { ...limit, pausedAt: at, ...(workflow ? { workflow: true as const } : {}) };
  return limitPausedIn(engineLimitIn(threads, taskId, limit), taskId, pause, carriesOn);
}

/** Its coordinator here hearing that a thread's turn ended, as `state` reads with `threads` in. */
function turnHeard(state: WorkspaceState, threads: ThreadsEdit, thread: Thread, status: TurnStatus, at: number, quiet: boolean): ThreadsEdit {
  const lead = coordinatorOf(threads.view.threads, thread);
  if (!lead) return threads;
  const { notes } = heardFacts(state, lead, thread, [{ kind: "ended", status, quiet }], at);
  return notes.length ? notedIn(threads, lead.id, ...notes) : threads;
}

