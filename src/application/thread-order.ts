import type { ThreadDropTarget } from "../domain/project.js";
import { threadActivityAt, type Thread } from "../domain/thread.js";
import { wantsAttention } from "../domain/attention.js";
import type { SidebarMode, SidebarSections } from "../domain/sidebar.js";

/** The activity sidebar's three lists, in the order they are drawn. */
export type ActivitySections = Record<"priority" | "running" | "threads", Thread[]>;

type RankedThread = { thread: Thread; activity: number };

function newestFirst(threads: RankedThread[]): Thread[] {
  return threads.sort((left, right) => right.activity - left.activity).map(({ thread }) => thread);
}

/**
 * Ranks threads by what wants the user rather than by where they live. A thread leads when it is
 * blocked on the user, or when it is idle and its last run left a verdict or a run found something;
 * a thread still working belongs among the runs however it ended last time. Every thread appears once.
 *
 * Running holds its rows in the sidebar's own order instead, because ranking live threads by their
 * newest activity reshuffles the list under the user every time one of them speaks.
 */
export function activitySections(threads: Thread[], busy: Set<string>, blocked: Set<string>): ActivitySections {
  const priority: RankedThread[] = [];
  const running: Thread[] = [];
  const settled: RankedThread[] = [];
  for (const thread of threads) {
    if (blocked.has(thread.id)) {
      priority.push({ thread, activity: threadActivityAt(thread) });
    } else if (busy.has(thread.id)) {
      running.push(thread);
    } else {
      (wantsAttention(thread) ? priority : settled).push({ thread, activity: threadActivityAt(thread) });
    }
  }
  return {
    priority: newestFirst(priority),
    running: orderThreads(running),
    threads: newestFirst(settled),
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
  return right.updatedAt - left.updatedAt;
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
 * Moves one thread into `target` and renumbers the visible list. `target.index` counts rows in the
 * destination group with the moved thread already taken out, matching what a drop reports. A group is
 * one list in the sidebar: a project's threads, or the project-less list.
 *
 * A checkout is cut from one project, so a thread working in one reorders freely inside that
 * project's list but is never carried to another project.
 */
export function moveThread(threads: Thread[], threadId: string, target: ThreadDropTarget): Thread[] {
  const visible = orderThreads(threads.filter((thread) => thread.archivedAt === undefined));
  const moving = visible.find((thread) => thread.id === threadId);
  if (!moving) return threads;
  const rest = visible.filter((thread) => thread.id !== threadId);
  const projectId = target.projectId ?? undefined;
  if (moving.worktreeId && projectId !== moving.projectId) return threads;

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

/** The sidebar as the numbering reads it: the lists it draws, and which of them are folded open. */
export type SidebarShape = {
  mode: SidebarMode;
  sections: SidebarSections;
  /** The projects in the order the sidebar lists them, each with the threads it holds. */
  projects: { expanded: boolean; threads: Thread[] }[];
  recentThreads: Thread[];
  activityThreads: ActivitySections;
};

const ACTIVITY_ORDER = ["priority", "running", "threads"] as const;

/**
 * The threads a digit reaches: the first nine rows the sidebar draws, top to bottom. A folded
 * section or folder draws no rows, so the threads under it are not numbered.
 */
export function slotThreadIds(shape: SidebarShape, limit: number): string[] {
  const ids: string[] = [];
  const take = (threads: Thread[]) => {
    for (const thread of threads) {
      if (ids.length === limit) return;
      ids.push(thread.id);
    }
  };
  if (shape.mode === "activity") {
    for (const section of ACTIVITY_ORDER) if (shape.sections[section]) take(shape.activityThreads[section]);
    return ids;
  }
  if (shape.sections.projects) for (const project of shape.projects) if (project.expanded) take(project.threads);
  if (shape.sections.recents) take(shape.recentThreads);
  return ids;
}
