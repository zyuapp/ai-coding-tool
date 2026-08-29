/**
 * What the workspace puts on the desktop when a thread needs the user. The window decides whether
 * the user is somewhere it has to be reached; this only decides whether there is anything to say.
 */
import type { Thread } from "../domain/thread.js";
import type { WorkspaceEffect } from "./workspace-reducer.js";
import type { WorkspaceState } from "./workspace-state.js";

type NoticeState = Pick<WorkspaceState, "notifications" | "tasks" | "sideChats">;

/** What a notice calls the thread. A side chat only exists beside another thread, so it names both. */
function noticeTitle(state: NoticeState, task: Thread): string {
  const chat = state.sideChats.find((item) => item.id === task.id);
  if (!chat) return task.title;
  const source = state.tasks.find((item) => item.id === chat.sourceTaskId);
  return source ? `${source.title} · ${task.title}` : task.title;
}

/** A line a thread wants in front of the user, kept back entirely while notifications are turned off. */
export function announced(state: NoticeState, task: Thread, headline: string): WorkspaceEffect[] {
  if (!state.notifications) return [];
  return [{ type: "announce-thread", notice: { taskId: task.id, title: noticeTitle(state, task), headline } }];
}
