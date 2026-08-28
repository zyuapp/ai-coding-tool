/** The count the app icon carries: one for every thread the user has not seen, and zero for none. */
export function showUnreadCount(count: number) {
  if ("desktop" in window) window.desktop.setBadgeCount(count);
}
