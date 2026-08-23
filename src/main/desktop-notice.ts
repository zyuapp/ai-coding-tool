import { ipcMain, Notification, type BrowserWindow, type IpcMainEvent } from "electron";
import { isThreadNotice, type ThreadNotice } from "../contracts/ipc.js";

/** Says what happened where the user already is, since taking the window would take their place. */
export function notify(title: string, body: string, onClick?: () => void) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: true });
  if (onClick) notification.on("click", onClick);
  notification.show();
}

/** What a notice needs from main: the window it belongs to, and bringing that window back to the user. */
export type NoticeHost = {
  window: () => BrowserWindow | null;
  reveal: () => void;
};

/**
 * Takes a thread's notice to where the user is. A window they are already looking at says it itself,
 * so nothing is announced then; anywhere else the desktop carries it and the click lands on the thread.
 */
export function announceThread(host: NoticeHost, notice: ThreadNotice) {
  const window = host.window();
  if (!window || window.isDestroyed() || window.isFocused()) return;
  notify(notice.title, notice.headline, () => {
    host.reveal();
    const shown = host.window();
    if (shown && !shown.isDestroyed()) shown.webContents.send("window:open-thread", notice.taskId);
  });
}

/** The window holds the threads, so it is the only place an announcement may come from. */
export function serveThreadNotices(host: NoticeHost, trusted: (event: IpcMainEvent) => boolean) {
  ipcMain.on("thread:announce", (event, notice: unknown) => {
    if (!trusted(event) || !isThreadNotice(notice)) return;
    announceThread(host, notice);
  });
}
