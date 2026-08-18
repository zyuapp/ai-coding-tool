import type { Task } from "../domain/task.js";

/** Where a dragged task lands: next to another task, or at the top of a project ("recents" when null). */
export type TaskDropTarget =
  | { taskId: string; place: "before" | "after" }
  | { projectId: string | null };

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
 * Moves one task and renumbers the visible list. Dropping onto a row in another project — or onto a
 * project header — reparents the task as well as repositioning it.
 */
export function moveTask(tasks: Task[], taskId: string, target: TaskDropTarget): Task[] {
  const visible = orderTasks(tasks.filter((task) => task.archivedAt === undefined));
  const moving = visible.find((task) => task.id === taskId);
  if (!moving) return tasks;
  const rest = visible.filter((task) => task.id !== taskId);

  let projectId: string | undefined;
  let index: number;
  if ("taskId" in target) {
    const anchor = rest.findIndex((task) => task.id === target.taskId);
    if (anchor === -1) return tasks;
    projectId = rest[anchor]!.projectId;
    index = anchor + (target.place === "after" ? 1 : 0);
  } else {
    projectId = target.projectId ?? undefined;
    const first = rest.findIndex((task) => task.projectId === projectId);
    index = first === -1 ? 0 : first;
  }

  const { projectId: _reassigned, ...detached } = moving;
  rest.splice(index, 0, projectId === undefined ? detached : { ...detached, projectId });
  const moved = new Map(rest.map((task, position) => [task.id, { ...task, sortIndex: position }]));
  return tasks.map((task) => {
    const next = moved.get(task.id);
    if (!next) return task;
    return next.sortIndex === task.sortIndex && next.projectId === task.projectId ? task : next;
  });
}
