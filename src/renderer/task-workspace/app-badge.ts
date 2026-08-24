import { unreadAttentionCount } from "../../domain/attention";
import type { Task } from "../../domain/task";

/** The count the app icon carries: one for every thread the user has not seen, and zero for none. */
export function showUnreadCount(tasks: Task[]) {
  if ("desktop" in window) window.desktop.setBadgeCount(unreadAttentionCount(tasks));
}
