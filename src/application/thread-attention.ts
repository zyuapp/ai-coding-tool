/**
 * What threads have left unseen, once side chats are counted. A side chat is a tab within another
 * thread's dock rather than a row of its own, so its mark belongs to the thread that holds it.
 */
import { hasUnreadAttention } from "../domain/attention.js";
import type { Thread } from "../domain/thread.js";
import { dockFor, tabHolderOf, type DockState } from "./workspace-dock.js";

type ScreenState = Pick<DockState, "currentId" | "sideChats" | "docks"> & { computers?: { active: string | null } };

/**
 * Whether the user is looking at a thread. A side chat, or a thread under a coordinator, is on screen
 * when the thread whose dock holds it is current and that dock is showing its tab. While
 * a paired computer's thread is on screen, none of this computer's own are.
 */
export function threadOnScreen(state: ScreenState, taskId: string): boolean {
  if (state.computers?.active) return false;
  if (state.currentId === taskId) return true;
  const holder = tabHolderOf(state, taskId);
  if (!holder || state.currentId !== holder) return false;
  const dock = dockFor(state, holder);
  return dock.open && dock.tab === taskId;
}

/** The marks the sidebar and the app icon share, with every side chat folded into its source thread. */
export function unreadView(state: { threads: Thread[] } & Pick<DockState, "sideChats">, listed: Thread[]) {
  const sideChatAttention = new Set<string>();
  for (const chat of state.sideChats) {
    const thread = state.threads.find((item) => item.id === chat.id);
    if (thread && hasUnreadAttention(thread)) sideChatAttention.add(chat.sourceThreadId);
  }
  const unreadCount = listed.filter((thread) => hasUnreadAttention(thread) || sideChatAttention.has(thread.id)).length;
  return { sideChatAttention, unreadCount };
}
