import { app, Menu } from "electron";

let markAllRead: (() => void) | null = null;
let hasUnread = false;

function applyDockMenu() {
  if (!app.dock || !markAllRead) return;
  app.dock.setMenu(Menu.buildFromTemplate([{ label: "Mark All as Read", enabled: hasUnread, click: markAllRead }]));
}

/** The Dock icon's menu, which clears what its badge counts. */
export function installDockMenu(onMarkAllRead: () => void) {
  markAllRead = onMarkAllRead;
  applyDockMenu();
}

export function setUnreadBadge(count: number) {
  app.setBadgeCount(count);
  if (count > 0 === hasUnread) return;
  hasUnread = count > 0;
  applyDockMenu();
}
