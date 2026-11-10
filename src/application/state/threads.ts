import type { ActiveGoal } from "../../domain/goal.js";
import type { Thread } from "../../domain/thread.js";
import { awayLeadOf, remoteLeadOf } from "../../domain/coordination.js";

export type ThreadsState = {
  threads: Thread[];
  /** Native goals live only as long as this app session. */
  goals: Record<string, ActiveGoal>;
};

export function initialThreadsState(): ThreadsState {
  return { threads: [], goals: {} };
}

const remotelyLed = new WeakMap<readonly Thread[], readonly Thread[]>();
const leadsAway = new WeakMap<readonly Thread[], readonly Thread[]>();

/** The threads in a paired computer's list that a coordinator elsewhere started, and that still work under it. */
export function remotelyLedThreads(threads: readonly Thread[]): readonly Thread[] {
  let found = remotelyLed.get(threads);
  if (!found) {
    found = threads.filter((thread) => remoteLeadOf(thread) && thread.archivedAt === undefined);
    remotelyLed.set(threads, found);
  }
  return found;
}

/** The threads in a paired computer's list whose coordinator elsewhere is away, which work under it again once it is back. */
export function leadAwayThreads(threads: readonly Thread[]): readonly Thread[] {
  let found = leadsAway.get(threads);
  if (!found) {
    found = threads.filter((thread) => awayLeadOf(thread) && thread.archivedAt === undefined);
    leadsAway.set(threads, found);
  }
  return found;
}
