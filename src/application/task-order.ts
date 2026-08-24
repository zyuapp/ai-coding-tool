import { threadActivityAt, type Task, type TaskDropTarget } from "../domain/task.js";
import { wantsAttention } from "../domain/attention.js";

/** The activity sidebar's three lists, in the order they are drawn. */
export type ActivitySections = Record<"priority" | "running" | "threads", Task[]>;

type RankedTask = { task: Task; activity: number };

function newestFirst(tasks: RankedTask[]): Task[] {
  return tasks.sort((left, right) => right.activity - left.activity).map(({ task }) => task);
}

/**
 * Ranks threads by what wants the user rather than by where they live. A thread leads when it is
 * blocked on the user, or when it is idle and its last run left a verdict or a run found something;
 * a thread still working belongs among the runs however it ended last time. Every thread appears once.
 *
 * Running holds its rows in the sidebar's own order instead, because ranking live threads by their
 * newest activity reshuffles the list under the user every time one of them speaks.
 */
export function activitySections(tasks: Task[], busy: Set<string>, blocked: Set<string>): ActivitySections {
  const priority: RankedTask[] = [];
  const running: Task[] = [];
  const threads: RankedTask[] = [];
  for (const task of tasks) {
    if (blocked.has(task.id)) {
      priority.push({ task, activity: threadActivityAt(task) });
    } else if (busy.has(task.id)) {
      running.push(task);
    } else {
      (wantsAttention(task) ? priority : threads).push({ task, activity: threadActivityAt(task) });
    }
  }
  return {
    priority: newestFirst(priority),
    running: orderTasks(running),
    threads: newestFirst(threads),
  };
}

/**
 * Sidebar order. `sortIndex` wins so rows never move on their own; tasks stored before
 * sortIndex existed fall back to recency until {@link backfillSortIndex} pins them down.
 */
function compareTasks(left: Task, right: Task) {
  if (left.sortIndex !== undefined && right.sortIndex !== undefined) return left.sortIndex - right.sortIndex;
  if (left.sortIndex !== undefined) return -1;
  if (right.sortIndex !== undefined) return 1;
  return right.updatedAt - left.updatedAt;
}

export function orderTasks(tasks: Task[]): Task[] {
  for (let index = 1; index < tasks.length; index += 1) {
    if (compareTasks(tasks[index - 1]!, tasks[index]!) > 0) return [...tasks].sort(compareTasks);
  }
  return tasks;
}

/** Freezes the order tasks loaded in, so a first launch after upgrading keeps the list the user last saw. */
export function backfillSortIndex(tasks: Task[]): Task[] {
  if (tasks.every((task) => task.sortIndex !== undefined)) return tasks;
  const positions = new Map(orderTasks(tasks).map((task, index) => [task.id, index]));
  return tasks.map((task) => task.sortIndex === undefined ? { ...task, sortIndex: positions.get(task.id)! } : task);
}

export function nextSortIndex(tasks: Task[]): number {
  let lowest = 0;
  for (const task of tasks) lowest = Math.min(lowest, task.sortIndex ?? 0);
  return lowest - 1;
}

/**
 * Moves one task into `target` and renumbers the visible list. `target.index` counts rows in the
 * destination group with the moved task already taken out, matching what a drop reports. A group is
 * one list in the sidebar: a project's threads, or the project-less list.
 *
 * A checkout is cut from one project, so a thread working in one reorders freely inside that
 * project's list but is never carried to another project.
 */
export function moveTask(tasks: Task[], taskId: string, target: TaskDropTarget): Task[] {
  const visible = orderTasks(tasks.filter((task) => task.archivedAt === undefined));
  const moving = visible.find((task) => task.id === taskId);
  if (!moving) return tasks;
  const rest = visible.filter((task) => task.id !== taskId);
  const projectId = target.projectId ?? undefined;
  if (moving.worktreeId && projectId !== moving.projectId) return tasks;

  const group = rest.filter((task) => task.projectId === projectId);
  const anchor = group[Math.max(0, target.index)];
  const index = anchor
    ? rest.indexOf(anchor)
    : group.length ? rest.indexOf(group[group.length - 1]!) + 1 : 0;

  const { projectId: _reassigned, ...detached } = moving;
  rest.splice(index, 0, projectId === undefined ? detached : { ...detached, projectId });
  const moved = new Map(rest.map((task, position) => [task.id, { ...task, sortIndex: position }]));
  return tasks.map((task) => {
    const next = moved.get(task.id);
    if (!next) return task;
    return next.sortIndex === task.sortIndex && next.projectId === task.projectId ? task : next;
  });
}
