import { ipcMain, Notification, type BrowserWindow, type IpcMainEvent } from "electron";
import { isFindingNotice, type FindingNotice } from "../contracts/ipc.js";

/** Says what happened where the user already is, since taking the window would take their place. */
export function notify(title: string, body: string, onClick?: () => void) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: true });
  if (onClick) notification.on("click", onClick);
  notification.show();
}

/** What a finding needs from main: the window it belongs to, and bringing that window back to the user. */
export type FindingHost = {
  window: () => BrowserWindow | null;
  reveal: () => void;
};

/**
 * Takes a finding to where the user is. A window they are already looking at says it itself, so
 * nothing is announced then; anywhere else the desktop carries it and the click lands on the thread.
 */
export function announceFinding(host: FindingHost, notice: FindingNotice) {
  const window = host.window();
  if (!window || window.isDestroyed() || window.isFocused()) return;
  notify(notice.title, notice.headline, () => {
    host.reveal();
    const shown = host.window();
    if (shown && !shown.isDestroyed()) shown.webContents.send("window:open-thread", notice.taskId);
  });
}

/** The window holds the findings, so it is the only place an announcement may come from. */
export function serveFindingNotices(host: FindingHost, trusted: (event: IpcMainEvent) => boolean) {
  ipcMain.on("finding:announce", (event, notice: unknown) => {
    if (!trusted(event) || !isFindingNotice(notice)) return;
    announceFinding(host, notice);
  });
}
