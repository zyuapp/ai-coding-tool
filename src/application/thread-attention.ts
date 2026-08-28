/**
 * What threads have left unseen, once side chats are counted. A side chat is a tab within another
 * thread's dock rather than a row of its own, so its mark belongs to the thread that holds it.
 */
import { hasUnreadAttention } from "../domain/attention.js";
import type { Task } from "../domain/task.js";
import { dockFor, type DockState } from "./workspace-dock.js";

type ScreenState = Pick<DockState, "currentId" | "sideChats" | "docks">;

/**
 * Whether the user is looking at a thread. A side chat is never the current thread, so it is on
 * screen when its source thread is current and the dock in front is showing that chat's tab.
 */
export function threadOnScreen(state: ScreenState, taskId: string): boolean {
  if (state.currentId === taskId) return true;
  const chat = state.sideChats.find((item) => item.id === taskId);
  if (!chat || state.currentId !== chat.sourceTaskId) return false;
  const dock = dockFor(state, chat.sourceTaskId);
  return dock.open && dock.tab === taskId;
}

/** The marks the sidebar and the app icon share, with every side chat folded into its source thread. */
export function unreadView(state: { tasks: Task[] } & Pick<DockState, "sideChats">, listed: Task[]) {
  const sideChatAttention = new Set<string>();
  for (const chat of state.sideChats) {
    const task = state.tasks.find((item) => item.id === chat.id);
    if (task && hasUnreadAttention(task)) sideChatAttention.add(chat.sourceTaskId);
  }
  const unreadCount = listed.filter((task) => hasUnreadAttention(task) || sideChatAttention.has(task.id)).length;
  return { sideChatAttention, unreadCount };
}
