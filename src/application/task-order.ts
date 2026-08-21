import type { Task, TaskDropTarget } from "../domain/task.js";

/**
 * Sidebar order. `sortIndex` wins so rows never move on their own; tasks stored before
 * sortIndex existed fall back to recency until {@link backfillSortIndex} pins them down.
 */
export function orderTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    if (left.sortIndex !== undefined && right.sortIndex !== undefined) return left.sortIndex - right.sortIndex;
    if (left.sortIndex !== undefined) return -1;
    if (right.sortIndex !== undefined) return 1;
    return right.updatedAt - left.updatedAt;
  });
}

/** Freezes the order tasks loaded in, so a first launch after upgrading keeps the list the user last saw. */
export function backfillSortIndex(tasks: Task[]): Task[] {
  if (tasks.every((task) => task.sortIndex !== undefined)) return tasks;
  const positions = new Map(orderTasks(tasks).map((task, index) => [task.id, index]));
  return tasks.map((task) => task.sortIndex === undefined ? { ...task, sortIndex: positions.get(task.id)! } : task);
}

export function nextSortIndex(tasks: Task[]): number {
  return Math.min(0, ...tasks.map((task) => task.sortIndex ?? 0)) - 1;
}

/**
 * Moves one task into `target` and renumbers the visible list. `target.index` counts rows in the
 * destination group with the moved task already taken out, matching what a drop reports. A group is
 * one list in the sidebar: a project's own threads, one of its checkouts, or the project-less list.
 *
 * A thread working in a checkout is placed by that checkout, so dragging never carries it out of one.
 */
export function moveTask(tasks: Task[], taskId: string, target: TaskDropTarget): Task[] {
  const visible = orderTasks(tasks.filter((task) => task.archivedAt === undefined));
  const moving = visible.find((task) => task.id === taskId);
  if (!moving) return tasks;
  if ((moving.worktreeId ?? undefined) !== target.worktreeId) return tasks;
  const rest = visible.filter((task) => task.id !== taskId);
  const projectId = target.projectId ?? undefined;

  const group = rest.filter((task) => task.projectId === projectId && (task.worktreeId ?? undefined) === target.worktreeId);
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
