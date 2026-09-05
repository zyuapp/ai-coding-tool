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
      showErrorBox: (title: string, content: string) => { messageBoxes.push({ title, content }); },
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

function fakeRuntimeViews(listeners: Map<string, Callback>) {
  const runtimeViews: FakeWebContentsView[] = [];
  class HostedView extends FakeWebContentsView {
    constructor(options: { webPreferences?: { additionalArguments?: string[] } }) {
      super(options);
      if (!options.webPreferences?.additionalArguments?.includes("--workspace-runtime")) return;
      runtimeViews.push(this);
      this.webContents.loadURL = async () => {
        this.loadedBounds = this.bounds;
        listeners.get("workspace-runtime:ready")?.({ sender: this.webContents });
      };
      const send = this.webContents.send;
      this.webContents.send = (channel, event) => {
        send(channel, event);
        if (channel === "workspace-runtime:request") {
          const request = event as { id: string };
          queueMicrotask(() => listeners.get("workspace-runtime:response")?.({ sender: this.webContents }, { id: request.id, result: { ok: true } }));
        }
      };
    }
  }
  return { HostedView, runtimeViews };
}

/** The Electron surface `src/main` reaches for, paired with the records a test asserts against. */
export function fakeElectron(userData: string) {
  const handlers = new Map<string, Callback>();
  const listeners = new Map<string, Callback>();
  const { HostedView, runtimeViews } = fakeRuntimeViews(listeners);
  const appListeners = new Map<string, Callback>();
  const protocolHandlers = new Map<string, Callback>();
  const globalShortcuts = new Map<string, Callback>();
  const agents: FakeAgent[] = [];
  const externalUrls: string[] = [];
  const openedPaths: string[] = [];
  const relaunches: Array<{ args?: string[] }> = [];
  const badgeCounts: number[] = [];
  const powerBlockerStarts: Array<{ id: number; type: "prevent-app-suspension" | "prevent-display-sleep" }> = [];
  const powerBlockerStops: number[] = [];
  const activePowerBlockers = new Set<number>();
  const webRequestListeners = new Map<string, Callback>();
  let quitAttempts = 0;
  let completedQuits = 0;
  let quitting = false;
  const { FakeWindow, windows } = fakeWindows(() => {
    if (!quitting) appListeners.get("window-all-closed")?.();
  });
  const Notification = fakeNotifications();
  const { dialog, messageBoxes } = fakeDialog();
  const { Menu, applicationMenu } = fakeMenu();
  const powerMonitor = new EventEmitter() as EventEmitter & { getSystemIdleState(idleThreshold: number): "active" };
  powerMonitor.getSystemIdleState = () => "active";
  const browserPartition = {
    setUserAgent() {},
    webRequest: {
      onBeforeSendHeaders: (listener: Callback | null) => listener ? webRequestListeners.set("before-send-headers", listener) : webRequestListeners.delete("before-send-headers"),
      onBeforeRequest: (listener: Callback | null) => listener ? webRequestListeners.set("before-request", listener) : webRequestListeners.delete("before-request"),
      onCompleted: (listener: Callback | null) => listener ? webRequestListeners.set("completed", listener) : webRequestListeners.delete("completed"),
      onErrorOccurred: (listener: Callback | null) => listener ? webRequestListeners.set("error", listener) : webRequestListeners.delete("error"),
    },
    async clearStorageData() {},
    async clearCache() {},
  };

  const electron = {
    app: {
      isPackaged: false,
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
          quitting = true;
          for (const window of [...windows]) window.close();
          if (windows.length === 0) {
            completedQuits += 1;
            appListeners.get("will-quit")?.();
          }
          quitting = false;
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
    desktopCapturer: { getSources: async () => [] },
    systemPreferences: {
      getMediaAccessStatus: () => "granted",
      isTrustedAccessibilityClient: () => true,
    },
    powerMonitor,
    powerSaveBlocker: {
      start: (type: "prevent-app-suspension" | "prevent-display-sleep") => {
        const id = powerBlockerStarts.length + 1;
        powerBlockerStarts.push({ id, type });
        activePowerBlockers.add(id);
        return id;
      },
      stop: (id: number) => { powerBlockerStops.push(id); return activePowerBlockers.delete(id); },
      isStarted: (id: number) => activePowerBlockers.has(id),
    },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }] },
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
      openPath: async (file: string) => { openedPaths.push(file); return ""; },
    },
    session: {
      defaultSession: { setPermissionRequestHandler() {} },
      fromPartition: () => browserPartition,
    },
    WebContentsView: HostedView,
  };

  const records = {
    app: electron.app,
    runtimeViews,
    handlers,
    listeners,
    windows,
    agents,
    appListeners,
    externalUrls,
    openedPaths,
    messageBoxes,
    dialog,
    applicationMenu,
    relaunches,
    quitAttempts: () => quitAttempts,
    completedQuits: () => completedQuits,
    protocolHandlers,
    globalShortcuts,
    notifications: Notification.raised,
    badgeCounts,
    powerMonitor,
    powerBlockerStarts,
    powerBlockerStops,
    activePowerBlockers,
    webRequestListeners,
  };
  return { electron, windows, appListeners, records };
}
