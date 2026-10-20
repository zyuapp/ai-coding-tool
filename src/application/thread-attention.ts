/**
 * What threads have left unseen, once side chats and coordinators' threads are counted. Neither has
 * a row of its own, so its mark belongs to the row that speaks for it.
 */
import { hasUnreadAttention, readAttention } from "../domain/attention.js";
import { coordinatedThreadIds, coordinatedThreads, coordinatorOf, leadIdOf } from "../domain/coordination.js";
import type { Thread } from "../domain/thread.js";
import { dockFor, tabHolderOf, type DockState } from "./workspace-dock.js";

export type ScreenState = Pick<DockState, "currentId" | "sideChats" | "docks"> & { threads: readonly Thread[]; computers?: { active: string | null } };

/**
 * Whether the user is looking at a thread. A thread under the current coordinator is, since its
 * conversation and Overview show where each stands. A side chat is on screen when the thread whose
 * dock holds it is current and that dock is showing its tab. While a paired computer's thread is on
 * screen, none of this computer's own are.
 */
export function threadOnScreen(state: ScreenState, taskId: string): boolean {
  if (state.computers?.active) return false;
  if (state.currentId === taskId) return true;
  const thread = state.threads.find((item) => item.id === taskId);
  if (state.currentId !== null && coordinatorOf(state.threads, thread)?.id === state.currentId) return true;
  const holder = tabHolderOf(state, taskId);
  if (!holder || state.currentId !== holder) return false;
  const dock = dockFor(state, holder);
  return dock.open && dock.tab === taskId;
}

/**
 * The marks the sidebar and the app icon share, with every side chat folded into its source thread
 * and every thread under a coordinator into the coordinator, whose row speaks for it. The icon counts
 * rows, so it says what the sidebar does.
 */
export function unreadView(state: { threads: Thread[] } & Pick<DockState, "sideChats">, listed: Thread[]) {
  const sideChatAttention = new Set<string>();
  for (const chat of state.sideChats) {
    const thread = state.threads.find((item) => item.id === chat.id);
    if (thread && hasUnreadAttention(thread)) sideChatAttention.add(chat.sourceThreadId);
  }
  const members = coordinatedThreadIds(listed);
  const rows = new Set<string>();
  for (const thread of listed) {
    if (hasUnreadAttention(thread) || sideChatAttention.has(thread.id)) rows.add(members.has(thread.id) ? leadIdOf(thread)! : thread.id);
  }
  return { sideChatAttention, unreadCount: rows.size };
}

/** Landing on a thread reads it, and landing on a coordinator reads the threads under it too, as its row speaks for them. */
export function readRow<T extends { threads: Thread[] }>(state: T, threadId: string | null): T {
  const read = readAttention(state, threadId);
  if (!threadId) return read;
  return coordinatedThreads(read.threads, threadId).reduce((next, member) => readAttention(next, member.id), read);
}
