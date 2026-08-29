/**
 * What the workspace puts on the desktop when a thread needs the user. The window decides whether
 * the user is somewhere it has to be reached; this only decides whether there is anything to say.
 */
import type { Thread } from "../domain/thread.js";
import type { WorkspaceEffect } from "./workspace-reducer.js";
import type { WorkspaceState } from "./workspace-state.js";

type NoticeState = Pick<WorkspaceState, "notifications" | "threads" | "sideChats">;

/** What a notice calls the thread. A side chat only exists beside another thread, so it names both. */
function noticeTitle(state: NoticeState, thread: Thread): string {
  const chat = state.sideChats.find((item) => item.id === thread.id);
  if (!chat) return thread.title;
  const source = state.threads.find((item) => item.id === chat.sourceThreadId);
  return source ? `${source.title} · ${thread.title}` : thread.title;
}

/** A line a thread wants in front of the user, kept back entirely while notifications are turned off. */
export function announced(state: NoticeState, thread: Thread, headline: string): WorkspaceEffect[] {
  if (!state.notifications) return [];
  return [{ type: "announce-thread", notice: { taskId: thread.id, title: noticeTitle(state, thread), headline } }];
}
