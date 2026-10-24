/**
 * Where one thread's run stands: the run it has going, the starts still on their way to becoming
 * one, and how the last one left it. Every per-thread answer is a keyed lookup, so a row reading its
 * own thread's run costs the same however many threads and starts the workspace holds.
 */
import type { Thread } from "../domain/thread.js";
import { threadWorkspaceId } from "./thread-location.js";
import type { ActiveRun, ThreadRunStatus } from "./thread-run-state.js";
import type { PendingRun, WorkspaceState } from "./workspace-state.js";

type Starts = WorkspaceState["pendingRuns"];

const NO_STARTS: readonly PendingRun[] = [];

/** Starts grouped by the thread they are for, derived once per set of starts. */
const startsByThread = new WeakMap<Starts, ReadonlyMap<string, readonly PendingRun[]>>();

/** The run a thread has going, if any. */
export function runOf(state: Pick<WorkspaceState, "activeRuns">, taskId: string): ActiveRun | undefined {
  return state.activeRuns[taskId];
}

/** Each thread with starts still resolving where their run will happen, and those starts, oldest first. */
export function startingThreads(state: Pick<WorkspaceState, "pendingRuns">): ReadonlyMap<string, readonly PendingRun[]> {
  let grouped = startsByThread.get(state.pendingRuns);
  if (!grouped) {
    const built = new Map<string, PendingRun[]>();
    for (const pending of Object.values(state.pendingRuns)) {
      if (pending.taskId === undefined) continue;
      const held = built.get(pending.taskId);
      if (held) held.push(pending);
      else built.set(pending.taskId, [pending]);
    }
    grouped = built;
    startsByThread.set(state.pendingRuns, grouped);
  }
  return grouped;
}

/** The starts on their way to becoming this thread's run, oldest first. */
export function startsOf(state: Pick<WorkspaceState, "pendingRuns">, taskId: string): readonly PendingRun[] {
  return startingThreads(state).get(taskId) ?? NO_STARTS;
}

/**
 * Whether a thread is working, counting the moment between a send and the checkout it resolves to.
 * A run that has not started yet still has an answer on its way about where it will happen.
 */
export function threadBusy(state: Pick<WorkspaceState, "activeRuns" | "pendingRuns">, taskId: string): boolean {
  return Boolean(state.activeRuns[taskId]) || startingThreads(state).has(taskId);
}

/** Whether the user has a turn of their own going or on its way in this thread. */
export function usersTurn(state: Pick<WorkspaceState, "activeRuns" | "pendingRuns">, taskId: string): boolean {
  return state.activeRuns[taskId]?.origin === "composer" || startsOf(state, taskId).some((pending) => pending.origin === "composer");
}

/** What a thread's composer shows of its run: running while one is going, else how the last one ended. */
export function runStatus(state: Pick<WorkspaceState, "activeRuns" | "runStatuses">, taskId: string | null): ThreadRunStatus {
  if (!taskId) return "idle";
  return state.activeRuns[taskId] ? "running" : state.runStatuses[taskId] ?? "idle";
}

/** The thread a resolved start may begin its run on: one still there, not filed away, with no run going. */
export function threadToBegin(state: Pick<WorkspaceState, "threads" | "activeRuns">, taskId: string | undefined): Thread | undefined {
  const thread = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
  return thread && thread.archivedAt === undefined && !state.activeRuns[thread.id] ? thread : undefined;
}

/** Whether a run is going in a checkout, so nothing moves the ground under it. */
export function runsInWorkspace(state: WorkspaceState, workspaceId: string | undefined): boolean {
  if (!workspaceId) return false;
  return Object.keys(state.activeRuns).some((taskId) => {
    const thread = state.threads.find((item) => item.id === taskId);
    return thread ? threadWorkspaceId(state, thread) === workspaceId : false;
  });
}
