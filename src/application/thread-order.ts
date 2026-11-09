import type { ThreadDropTarget } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { wantsAttention } from "../domain/attention.js";
import { coordinatedThreadIds } from "../domain/coordination.js";
import type { SidebarSections } from "../domain/sidebar.js";
import type { ThreadHost } from "./computers.js";

/**
 * Every order a thread list is drawn in lives here: {@link orderThreads} where the user put each row,
 * {@link recentFirst} newest `rankedAt` first, and Snoozed's next to wake first. Lists take one of
 * these rather than sorting threads themselves, so no row moves while its run speaks.
 */

/** The activity sidebar's lists, in the order they are drawn. */
export type ActivitySections = Record<"priority" | "running" | "threads" | "snoozed", Thread[]>;

/** Newest `rankedAt` first, in a new array. */
export function recentFirst(threads: readonly Thread[]): Thread[] {
  return [...threads].sort((left, right) => right.rankedAt - left.rankedAt);
}

/**
 * The threads last active where a new thread is about to start: one project's, or the chats that
 * have none. A thread working under a coordinator is reached through it, so it is left out.
 */
export function recentIn(threads: readonly Thread[], projectId: string | undefined, limit: number): Thread[] {
  const members = coordinatedThreadIds(threads);
  return recentFirst(threads.filter((thread) => thread.projectId === projectId && thread.archivedAt === undefined && !members.has(thread.id))).slice(0, limit);
}

/**
 * Ranks threads by what wants the user rather than by where they live. A thread leads when it is
 * blocked on the user, or when it is idle and its last run left a verdict or a run found something;
 * a thread still working belongs among the runs however it ended last time. Reviewers stay in Threads
 * unless blocked on the user. A snoozed thread waits in Snoozed, the next to wake first. Every thread
 * appears once. Running holds its rows where the user put them.
 */
export function activitySections(threads: Thread[], busy: Set<string>, blocked: Set<string>): ActivitySections {
  const priority: Thread[] = [];
  const running: Thread[] = [];
  const settled: Thread[] = [];
  const snoozed: Thread[] = [];
  for (const thread of threads) {
    if (thread.snoozedUntil !== undefined) {
      snoozed.push(thread);
    } else if (blocked.has(thread.id)) {
      priority.push(thread);
    } else if (thread.role === "reviewer") {
      settled.push(thread);
    } else if (busy.has(thread.id)) {
      running.push(thread);
    } else {
      (wantsAttention(thread) ? priority : settled).push(thread);
    }
  }
  return {
    priority: recentFirst(priority),
    running: orderThreads(running),
    threads: recentFirst(settled),
    snoozed: snoozed.sort((left, right) => left.snoozedUntil! - right.snoozedUntil!),
  };
}

/**
 * Sidebar order. `sortIndex` wins so rows never move on their own; threads stored before
 * sortIndex existed fall back to recency until {@link backfillSortIndex} pins them down.
 */
function compareThreads(left: Thread, right: Thread) {
  if (left.sortIndex !== undefined && right.sortIndex !== undefined) return left.sortIndex - right.sortIndex;
  if (left.sortIndex !== undefined) return -1;
  if (right.sortIndex !== undefined) return 1;
  return right.rankedAt - left.rankedAt;
}

export function orderThreads(threads: Thread[]): Thread[] {
  for (let index = 1; index < threads.length; index += 1) {
    if (compareThreads(threads[index - 1]!, threads[index]!) > 0) return [...threads].sort(compareThreads);
  }
  return threads;
}

/** Freezes the order threads loaded in, so a first launch after upgrading keeps the list the user last saw. */
export function backfillSortIndex(threads: Thread[]): Thread[] {
  if (threads.every((thread) => thread.sortIndex !== undefined)) return threads;
  const positions = new Map(orderThreads(threads).map((thread, index) => [thread.id, index]));
  return threads.map((thread) => thread.sortIndex === undefined ? { ...thread, sortIndex: positions.get(thread.id)! } : thread);
}

export function nextSortIndex(threads: Thread[]): number {
  let lowest = 0;
  for (const thread of threads) lowest = Math.min(lowest, thread.sortIndex ?? 0);
  return lowest - 1;
}

/**
 * Why a thread can reorder within its folder but not be carried to another, or null when it can:
 * it lives on another computer, works in a checkout cut from one project, or is drawn beneath its
 * coordinator.
 */
export function threadMoveBlock(thread: Thread, host: Pick<ThreadHost, "name"> | undefined, coordinated: boolean): string | null {
  if (host) return `Stays in its folder on ${host.name}`;
  if (thread.worktreeId) return "Stays in its worktree's folder";
  if (coordinated) return "Stays with its coordinator";
  return null;
}

/**
 * Moves one thread into `target` and renumbers the visible list. `target.index` counts rows in the
 * destination group with the moved thread already taken out, matching what a drop reports. A group is
 * one list in the sidebar: a project's threads, or the project-less list. A thread
 * {@link threadMoveBlock} pins reorders only within its own group.
 */
export function moveThread(threads: Thread[], threadId: string, target: ThreadDropTarget): Thread[] {
  const members = coordinatedThreadIds(threads);
  const moving = threads.find((thread) => thread.id === threadId && thread.archivedAt === undefined);
  const projectId = target.projectId ?? undefined;
  if (!moving || (projectId !== moving.projectId && threadMoveBlock(moving, undefined, members.has(moving.id)))) return threads;
  /** Threads under a coordinator are drawn beneath it, so a drop's index never counts them, nor places one. */
  const visible = orderThreads(threads.filter((thread) => thread.archivedAt === undefined && !members.has(thread.id)));
  if (!visible.includes(moving)) return threads;
  const rest = visible.filter((thread) => thread !== moving);

  const group = rest.filter((thread) => thread.projectId === projectId);
  const anchor = group[Math.max(0, target.index)];
  const index = anchor
    ? rest.indexOf(anchor)
    : group.length ? rest.indexOf(group[group.length - 1]!) + 1 : 0;

  const { projectId: _reassigned, ...detached } = moving;
  rest.splice(index, 0, projectId === undefined ? detached : { ...detached, projectId });
  const moved = new Map(rest.map((thread, position) => [thread.id, { ...thread, sortIndex: position }]));
  return threads.map((thread) => {
    const next = moved.get(thread.id);
    if (!next) return thread;
    return next.sortIndex === thread.sortIndex && next.projectId === thread.projectId ? thread : next;
  });
}

const ACTIVITY_ORDER = ["priority", "running", "threads", "snoozed"] as const;

/**
 * The threads a digit reaches: the first nine rows the sidebar draws, top to bottom. A folded
 * section draws no rows, so the threads under it have no shortcut slot.
 */
export function slotThreadIds(sections: SidebarSections, activityThreads: ActivitySections, limit: number): string[] {
  const ids: string[] = [];
  const take = (threads: Thread[]) => {
    for (const thread of threads) {
      if (ids.length === limit) return;
      ids.push(thread.id);
    }
  };
  for (const section of ACTIVITY_ORDER) if (sections[section]) take(activityThreads[section]);
  return ids;
}
