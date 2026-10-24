/**
 * How a turn ends. The facts of its end go in and one settlement comes out: how it reads, whether it
 * reaches the user, whether it waits out a usage limit, what becomes of its queue, and what its
 * coordinator hears. Every way a turn ends, a run settling, a wait the user cancels, the app quitting
 * under it, or compacting, is settled here.
 */
import { drainQueue, type QueueIntent } from "./workspace-reducer/run-queue.js";
import type { WorkspaceTransition } from "./workspace-reducer/types.js";
import { withNewsQuieted } from "./coordination.js";
import { withFactsHeard } from "./member-facts.js";
import { withRunAnswered } from "./outstanding-stops.js";
import { whyTurnSurfaces, withVerdict, type RunSurfacing } from "./run-testimony.js";
import { updateThread, withdrawRun, type ActiveRun, type ThreadMark } from "./thread-run-state.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { RunEvent } from "../contracts/ipc.js";
import { withClosedIssues } from "../domain/attention.js";
import { coordinatorOf, endsAsStopped, isCoordinator, reopenedIfStuck } from "../domain/coordination.js";
import { runOutcome, type ThreadOutcome } from "../domain/thread-run.js";
import type { Thread } from "../domain/thread.js";
import { resumesOnItsOwn, withEngineLimit, type LimitPause, type UsageLimit } from "../domain/usage-limit.js";

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
  if (settlement.restoresTestimony) return run ? withRestoredTestimony(state, taskId, run.before) : state;
  return withTurnAftermath(withTurnTestimony(state, taskId, settlement, run), taskId, settlement, run, at);
}

/**
 * What the turn leaves on its own thread: its verdict, and for a tick, the run withdrawn or its
 * filed-away issues closed. Anything the thread takes on after this, such as the move it asked to
 * make, stays.
 */
export function withTurnTestimony(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined): WorkspaceState {
  if (settlement.restoresTestimony) return state;
  let next = settlement.verdict ? withVerdict(state, taskId, settlement.verdict) : state;
  if (run && (settlement.withdraws || settlement.closesIssues)) {
    next = updateThread(next, taskId, (thread) => {
      const withdrawn = settlement.withdraws ? withdrawRun(thread, run.messagesBefore, run.before) : thread;
      return settlement.closesIssues ? withClosedIssues(withdrawn, run.reportedIssues) : withdrawn;
    });
  }
  return next;
}

/** Takes up the thread's queue once its testimony is already left, as the turn's end says. */
export function settledAfterTestimony(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): WorkspaceTransition {
  return drainQueue(withTurnAftermath(state, taskId, settlement, run, at), taskId, settlement.queue);
}

/** What follows from the turn's end beyond its testimony: its usage limit, a reopening, Stop all's answer, and its coordinator. */
function withTurnAftermath(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): WorkspaceState {
  let next = state;
  if (settlement.limit) next = settlement.limit.waits ? pausedForLimit(next, taskId, settlement.limit.reached, settlement.runEndedAs === null, at) : limitReached(next, taskId, settlement.limit.reached);
  if (settlement.reopens) next = updateThread(next, taskId, reopenedIfStuck);
  if (settlement.answersStopAll && run) next = withRunAnswered(next, run.runId);
  const thread = next.threads.find((item) => item.id === taskId);
  if (settlement.heard && thread) next = withTurnHeard(next, thread, settlement.status, at, settlement.heard.quiet);
  if (settlement.hushesNews && isCoordinator(thread)) next = withNewsQuieted(next, taskId);
  return next;
}

/** Applies a settlement and takes up the thread's queue as the turn's end says. */
export function settledTurn(state: WorkspaceState, taskId: string, settlement: Settlement, run: ActiveRun | undefined, at: number): WorkspaceTransition {
  return drainQueue(withSettledTurn(state, taskId, settlement, run, at), taskId, settlement.queue);
}

/**
 * A limit one thread's run reached, which is its account's, so every thread of its engine already
 * waiting waits for it too, whether or not that thread itself waits in line.
 */
function limitReached(state: WorkspaceState, taskId: string, limit: UsageLimit): WorkspaceState {
  const thread = state.threads.find((item) => item.id === taskId);
  const threads = thread ? withEngineLimit(state.threads, thread.engine, limit) : state.threads;
  return threads === state.threads ? state : { ...state, threads };
}

/** Puts a thread whose run hit the limit in line. One that carries on by itself has its verdict and its end taken off. */
function pausedForLimit(state: WorkspaceState, taskId: string, limit: UsageLimit, carriesOn: boolean, at: number): WorkspaceState {
  if (!state.threads.some((item) => item.id === taskId)) return state;
  const workflow = (state.workflows[taskId] ?? []).some((item) => item.status === "stopped");
  const pause: LimitPause = { ...limit, pausedAt: at, ...(workflow ? { workflow: true as const } : {}) };
  return updateThread(limitReached(state, taskId, limit), taskId, (item) => {
    if (!carriesOn) return { ...item, limitPause: pause };
    const { outcome: _expected, outcomeUnread: _unread, runEndedAs: _carriedOn, ...rest } = item;
    return { ...rest, limitPause: pause };
  });
}

/** Its coordinator here hearing that a thread's turn ended. */
function withTurnHeard(state: WorkspaceState, thread: Thread, status: TurnStatus, at: number, quiet: boolean): WorkspaceState {
  const lead = coordinatorOf(state.threads, thread);
  return lead ? withFactsHeard(state, lead, thread, [{ kind: "ended", status, quiet }], at).state : state;
}

/** Compaction updates the transcript, but it does not replace how the last thread run ended, its verdict, nor its report. */
function withRestoredTestimony(state: WorkspaceState, taskId: string, before: ThreadMark): WorkspaceState {
  return updateThread(state, taskId, ({ outcome: _outcome, outcomeUnread: _unread, runEndedAt: _ended, runEndedAs: _endedAs, ...thread }) => ({
    ...thread,
    ...(before.runEndedAs === undefined ? {} : { runEndedAs: before.runEndedAs }),
    ...(before.outcome === undefined ? {} : { outcome: before.outcome }),
    ...(before.outcomeUnread ? { outcomeUnread: true as const } : {}),
    ...(before.runEndedAt === undefined ? {} : { runEndedAt: before.runEndedAt }),
    ...(before.report ? { report: before.report } : {}),
  }));
}
