/** Threads as the app finds them on launch. None of their work outlived the app, so what was going stopped with it. */
import { settleTurn, withSettledTurn } from "./run-settlement.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { Subagent } from "../domain/run.js";
import { threadActivityAt, type Thread } from "../domain/thread.js";
import type { StoredThread } from "../domain/thread-storage.js";

/** The threads the store kept, the subagents each was following, and those whose run the app quit under. */
export function restoredThreads(stored: readonly StoredThread[]): { threads: Thread[]; subagents: Record<string, Subagent[]>; cutOff: Thread[] } {
  const subagents: Record<string, Subagent[]> = {};
  const cutOff: Thread[] = [];
  const threads = stored.map(({ subagents: delegated, ...saved }) => {
    if (delegated?.length) subagents[saved.id] = delegated.map(restoredSubagent);
    const thread = restoredThread(saved);
    if (thread !== saved) cutOff.push(thread);
    return thread;
  });
  return { threads, subagents, cutOff };
}

/**
 * A turn cut off with the app reads as one the user stopped: it leaves the same verdict, unread unless
 * the thread is on screen, and its coordinator here hears it as stopped, so nothing it hears wakes it
 * by itself. A coordinator cut off keeps what news it held quiet, as one the user stopped does.
 * Nothing is put on the desktop for it.
 */
export function withCutOffTurnsEnded(state: WorkspaceState, cutOff: readonly Thread[], at: number): WorkspaceState {
  const settlement = settleTurn({ status: "cancelled", stop: "quit" });
  return cutOff.reduce((next, thread) => withSettledTurn(next, thread.id, settlement, undefined, at), state);
}

/** A subagent stored mid-work stopped with the app. */
function restoredSubagent(subagent: Subagent): Subagent {
  if (subagent.status !== "working") return subagent;
  const { stopping: _stopping, ...stopped } = subagent;
  return { ...stopped, status: "stopped" };
}

/**
 * A thread saved mid-turn was stopped with the app, a moment after the last thing it did: that is the
 * turn's end its coordinator hears, here or on a paired computer, since it comes after anything that
 * coordinator has already heard of it.
 */
function restoredThread(thread: Thread): Thread {
  if (!thread.runOpen) return thread;
  const { runOpen: _cutOff, ...rest } = thread;
  const moved = Math.max(thread.updatedAt, threadActivityAt(thread), thread.report?.at ?? 0, thread.lastFindingAt ?? 0, thread.remoteLead?.backAt ?? 0, ...(thread.decisions ?? []).map((decision) => decision.raisedAt));
  return { ...rest, runEndedAt: moved + 1, runEndedAs: "stopped" };
}
