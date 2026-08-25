import { EventEmitter } from "node:events";
import { FakeWebContentsView, fakeWindows, type Callback } from "./electron-window-stub.mjs";

type HarnessMessage = Record<string, unknown>;
type NotificationOptions = { title: string; body?: string; silent?: boolean };

class FakeAgent extends EventEmitter {
  messages: HarnessMessage[] = [];
  stderr = new EventEmitter();
  throwOnPost = false;
  postMessage(message: unknown) {
    if (this.throwOnPost) throw new Error("post failed");
    this.messages.push(message as HarnessMessage);
  }
  kill() {}
}

/** Dialogs are answered rather than shown, so a test reads what was asked and takes the default. */
function fakeDialog() {
  const messageBoxes: Array<Record<string, unknown>> = [];
  return {
    messageBoxes,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showMessageBox: async (_window: unknown, options: Record<string, unknown>) => { messageBoxes.push(options); return { response: 1 }; },
    },
  };
}

/** The menu is built rather than displayed, so a test reads the template and clicks an item. */
function fakeMenu() {
  let applicationMenu: unknown = null;
  return {
    applicationMenu: () => applicationMenu,
    Menu: {
      buildFromTemplate: (template: unknown) => template,
      setApplicationMenu: (menu: unknown) => { applicationMenu = menu; },
    },
  };
}

/** Notifications are shown rather than sent, so a test reads what was raised and clicks it. */
function fakeNotifications() {
  type FakeNotificationInstance = {
    options: NotificationOptions;
    shown: boolean;
    click(): void;
  };
  const raised: FakeNotificationInstance[] = [];
  return class FakeNotification {
    static isSupported() { return true; }
    static raised = raised;
    readonly handlers = new Map<string, () => void>();
    shown = false;
    constructor(readonly options: NotificationOptions) {
      raised.push(this);
    }
    on(name: string, handler: () => void) { this.handlers.set(name, handler); return this; }
    show() { this.shown = true; }
    click() { this.handlers.get("click")?.(); }
  };
}

/** The Electron surface `src/main` reaches for, paired with the records a test asserts against. */
export function fakeElectron(userData: string) {
  const handlers = new Map<string, Callback>();
  const listeners = new Map<string, Callback>();
  const appListeners = new Map<string, Callback>();
  const protocolHandlers = new Map<string, Callback>();
  const globalShortcuts = new Map<string, Callback>();
  const agents: FakeAgent[] = [];
  const externalUrls: string[] = [];
  const relaunches: Array<{ args?: string[] }> = [];
  const badgeCounts: number[] = [];
  let quitAttempts = 0;
  let completedQuits = 0;
  const { FakeWindow, windows } = fakeWindows();
  const Notification = fakeNotifications();
  const { dialog, messageBoxes } = fakeDialog();
  const { Menu, applicationMenu } = fakeMenu();

  const electron = {
    app: {
      dock: { setIcon() {} },
      setBadgeCount(count: number) { badgeCounts.push(count); },
      setName() {},
      getName: () => "AI Coding Tool",
      getAppPath: () => process.cwd(),
      getPath: () => userData,
      setPath() {},
      whenReady: () => Promise.resolve(),
      on: (name: string, listener: Callback) => appListeners.set(name, listener),
      requestSingleInstanceLock: () => true,
      setAsDefaultProtocolClient() {},
      focus(_options?: unknown) {},
      quit() {
        quitAttempts += 1;
        let prevented = false;
        appListeners.get("before-quit")?.({ preventDefault: () => { prevented = true; } });
        if (!prevented) {
          completedQuits += 1;
          appListeners.get("will-quit")?.();
        }
      },
      relaunch: (relaunchOptions: { args?: string[] }) => { relaunches.push(relaunchOptions); },
      exit() {},
    },
    BaseWindow: FakeWindow,
    BrowserWindow: FakeWindow,
    globalShortcut: {
      register: (accelerator: string, callback: Callback) => { globalShortcuts.set(accelerator, callback); return true; },
      unregisterAll: () => globalShortcuts.clear(),
    },
    Notification,
    nativeTheme: { themeSource: "system" },
    powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => true },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    dialog,
    Menu,
    ipcMain: {
      handle: (name: string, handler: Callback) => handlers.set(name, handler),
      on: (name: string, listener: Callback) => listeners.set(name, listener),
    },
    utilityProcess: { fork: () => { const agent = new FakeAgent(); agents.push(agent); return agent; } },
    protocol: { registerSchemesAsPrivileged() {}, handle: (scheme: string, handler: Callback) => protocolHandlers.set(scheme, handler) },
    net: { fetch: async (url: string) => new Response(url) },
    shell: {
      openExternal: async (url: string) => { externalUrls.push(url); },
      openPath: async () => "",
    },
    session: {
      defaultSession: { setPermissionRequestHandler() {} },
      fromPartition: () => ({
        setUserAgent() {},
        webRequest: { onBeforeSendHeaders() {} },
        async clearStorageData() {},
        async clearCache() {},
      }),
    },
    WebContentsView: FakeWebContentsView,
  };

  const records = {
    app: electron.app,
    handlers,
    listeners,
    windows,
    agents,
    appListeners,
    externalUrls,
    messageBoxes,
    applicationMenu,
    relaunches,
    quitAttempts: () => quitAttempts,
    completedQuits: () => completedQuits,
    protocolHandlers,
    globalShortcuts,
    notifications: Notification.raised,
    badgeCounts,
  };
  return { electron, windows, appListeners, records };
}
