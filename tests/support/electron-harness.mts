import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Plugin } from "vite";
import type { TestContext } from "vitest";
import type { BrowserBounds } from "../../src/domain/browser.js";

type Callback = (...args: unknown[]) => unknown;
type RegisteredCallback = (...args: never[]) => unknown;
type HarnessMessage = Record<string, unknown>;
type SentMessage = { channel: string; event: unknown };
type WindowOpenHandler = (details: { url: string }) => { action: string };
type ElectronOptions = { show?: boolean };
type NotificationOptions = { title: string; body?: string; silent?: boolean };
type ComputerUseStub = Record<string, unknown>;
type StartOptions = { computerUse?: ComputerUseStub };
type HarnessGlobals = typeof globalThis & {
  __aicodingtoolElectron?: unknown;
  __aicodingtoolComputerUse?: ComputerUseStub;
};

export function registered<T extends RegisteredCallback>(registry: Map<string, Callback>, name: string): T {
  const callback = registry.get(name);
  if (!callback) throw new Error(`No ${name} callback was registered.`);
  return callback as unknown as T;
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function waitFor(predicate: () => unknown, description = "transport state") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

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

class FakeWebContentsView {
  declare options: unknown;
  declare bounds: BrowserBounds;
  declare visible: boolean;
  webContents = {
    on(_name: string, _listener: Callback) {},
    once(_name: string, _listener: Callback) {},
    off(_name: string, _listener: Callback) {},
    setWindowOpenHandler(_handler: WindowOpenHandler) {},
    close() {},
    reload() {},
    isLoading: () => false,
    getURL: () => "",
    getTitle: () => "",
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
    async loadURL() {},
    executeJavaScript: async (_script: string): Promise<unknown> => "",
  };
  constructor(options: unknown) { this.options = options; }
  setBounds(bounds: BrowserBounds) { this.bounds = bounds; }
  setVisible(visible: boolean) { this.visible = visible; }
  setBackgroundColor() {}
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

/** Both fakes are reached through globals, so the modules under test import them like the real ones. */
function fakePlugins(computerUse: boolean): Plugin[] {
  const plugins: Plugin[] = [{
    name: "fake-electron",
    enforce: "pre",
    resolveId(id) { if (id === "virtual:fake-electron") return "\0fake-electron"; },
    load(id) {
      if (id === "\0fake-electron") return "const e = globalThis.__aicodingtoolElectron; export const app=e.app, Menu=e.Menu, BaseWindow=e.BaseWindow, BrowserWindow=e.BrowserWindow, dialog=e.dialog, globalShortcut=e.globalShortcut, ipcMain=e.ipcMain, nativeTheme=e.nativeTheme, net=e.net, Notification=e.Notification, protocol=e.protocol, screen=e.screen, session=e.session, shell=e.shell, utilityProcess=e.utilityProcess, WebContentsView=e.WebContentsView;";
    },
  }];
  if (computerUse) {
    plugins.push({
      name: "fake-computer-use",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "./computer-use-host.js" && importer?.endsWith("/src/main/main.ts")) return "\0fake-computer-use";
      },
      load(id) {
        if (id === "\0fake-computer-use") return "const c = globalThis.__aicodingtoolComputerUse; export const computerUseForRun=c.computerUseForRun, computerUsePermissions=c.computerUsePermissions, requestComputerUsePermission=c.requestComputerUsePermission, stopComputerUse=c.stopComputerUse;";
      },
    });
  }
  return plugins;
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

/**
 * Boots src/main/main.ts against a stub Electron so IPC wiring can be driven from a test.
 * Each boot starts its own Vite server, so share one per test file rather than one per test.
 */
export async function startMainProcess(t: TestContext | null, prefix: string, options: StartOptions = {}) {
  let disposed = false;
  const userData = await mkdtemp(path.join(os.tmpdir(), prefix));
  const handlers = new Map<string, Callback>();
  const listeners = new Map<string, Callback>();
  const windows: FakeWindow[] = [];
  const agents: FakeAgent[] = [];
  const appListeners = new Map<string, Callback>();
  const protocolHandlers = new Map<string, Callback>();
  const globalShortcuts = new Map<string, Callback>();
  const externalUrls: string[] = [];
  const relaunches: Array<{ args?: string[] }> = [];
  let quitAttempts = 0;
  let completedQuits = 0;

  class FakeWindow {
    static getAllWindows() { return windows; }
    declare options: ElectronOptions;
    declare close: () => void;
    destroyed = false;
    focused = false;
    visible: boolean;
    webContents = {
      sent: [] as SentMessage[],
      listeners: new Map<string, Callback>(),
      windowOpenHandler: undefined as WindowOpenHandler | undefined,
      send: (channel: string, event: unknown) => this.webContents.sent.push({ channel, event }),
      on: (name: string, listener: Callback) => this.webContents.listeners.set(name, listener),
      setWindowOpenHandler: (handler: WindowOpenHandler) => { this.webContents.windowOpenHandler = handler; },
      getZoomFactor: () => 1,
    };
    /** Views live in exactly one window, the way Electron parents them. */
    children: FakeWebContentsView[] = [];
    contentView = {
      addChildView: (view: FakeWebContentsView) => {
        for (const other of windows) other.children = other.children.filter((child) => child !== view);
        this.children.push(view);
      },
      removeChildView: (view: FakeWebContentsView) => { this.children = this.children.filter((child) => child !== view); },
    };
    constructor(options: ElectronOptions) { this.options = options; this.visible = options.show !== false; windows.push(this); }
    destroy() {
      this.destroyed = true;
      const at = windows.indexOf(this);
      if (at !== -1) windows.splice(at, 1);
    }
    isDestroyed() { return this.destroyed === true; }
    isFocused() { return this.focused === true; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    maximize() {}
    getNormalBounds() { return { x: 0, y: 0, width: 1240, height: 820 }; }
    isVisible() { return this.visible !== false; }
    restore() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    on() {}
    async loadFile() {}
  }

  const Notification = fakeNotifications();
  const { dialog, messageBoxes } = fakeDialog();
  const { Menu, applicationMenu } = fakeMenu();

  const electron = {
    app: {
      dock: { setIcon() {} },
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
  const globals = globalThis as HarnessGlobals;
  globals.__aicodingtoolElectron = electron;
  globalThis.__dirname = path.join(process.cwd(), "dist/main/main");
  const versions = process.versions as NodeJS.ProcessVersions & { chrome?: string };
  versions.chrome = "141.0.0.0";

  const plugins = fakePlugins(options.computerUse !== undefined);

  const vite = await createServer({
    logLevel: "silent",
    appType: "custom",
    /** xterm's `module` field points at a file it does not ship, so its real ESM build is named here. */
    resolve: { alias: { electron: "virtual:fake-electron", "@xterm/headless": "@xterm/headless/lib-headless/xterm-headless.mjs" } },
    server: { middlewareMode: true },
    ssr: { external: ["@lydell/node-pty"] },
    plugins,
  });
  if (options.computerUse) globals.__aicodingtoolComputerUse = options.computerUse;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    appListeners.get("will-quit")?.();
    await vite.close();
    await rm(userData, { recursive: true, force: true });
    Reflect.deleteProperty(globals, "__aicodingtoolElectron");
    Reflect.deleteProperty(globals, "__aicodingtoolComputerUse");
    Reflect.deleteProperty(globalThis, "__dirname");
    delete versions.chrome;
  };
  t?.onTestFinished(dispose);
  try {
    await vite.ssrLoadModule("/src/main/main.ts");
  } catch (cause) {
    await dispose();
    throw cause;
  }
  while (windows.length === 0) await tick();

  const window = windows[0];
  if (!window) throw new Error("Main did not create a window.");
  return {
    app: electron.app,
    dispose,
    userData,
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
    window,
    trusted: { sender: window.webContents },
    untrusted: { sender: {} },
    sentOn: <T = unknown,>(channel: string) => window.webContents.sent.filter((entry) => entry.channel === channel).map((entry) => entry.event as T),
  };
}

export type MainHarness = Awaited<ReturnType<typeof startMainProcess>>;
