/**
 * What the workspace puts on the desktop when a thread needs the user. The window decides whether
 * the user is somewhere it has to be reached; this only decides whether there is anything to say.
 */
import type { Task } from "../domain/task.js";
import type { WorkspaceEffect } from "./workspace-reducer.js";

/** A line a thread wants in front of the user, kept back entirely while notifications are turned off. */
export function announced(notifications: boolean, task: Task, headline: string): WorkspaceEffect[] {
  if (!notifications) return [];
  return [{ type: "announce-thread", notice: { taskId: task.id, title: task.title, headline } }];
}
