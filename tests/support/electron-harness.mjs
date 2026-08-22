import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export async function waitFor(predicate, description = "transport state") {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

class FakeAgent extends EventEmitter {
  messages = [];
  stderr = new EventEmitter();
  throwOnPost = false;
  postMessage(message) {
    if (this.throwOnPost) throw new Error("post failed");
    this.messages.push(message);
  }
  kill() {}
}

class FakeWebContentsView {
  webContents = {
    on() {},
    once() {},
    off() {},
    setWindowOpenHandler() {},
    close() {},
    reload() {},
    isLoading: () => false,
    getURL: () => "",
    getTitle: () => "",
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
    async loadURL() {},
    async executeJavaScript() { return ""; },
  };
  constructor(options) { this.options = options; }
  setBounds(bounds) { this.bounds = bounds; }
  setVisible(visible) { this.visible = visible; }
  setBackgroundColor() {}
}

/** Notifications are shown rather than sent, so a test reads what was raised and clicks it. */
function fakeNotifications() {
  const raised = [];
  return class FakeNotification {
    static isSupported() { return true; }
    static raised = raised;
    constructor(options) {
      this.options = options;
      this.handlers = new Map();
      raised.push(this);
    }
    on(name, handler) { this.handlers.set(name, handler); return this; }
    show() { this.shown = true; }
    click() { this.handlers.get("click")?.(); }
  };
}

/**
 * Boots src/main/main.ts against a stub Electron so IPC wiring can be driven from a test.
 * Each boot starts its own Vite server, so share one per test file rather than one per test.
 */
export async function startMainProcess(t, prefix, options = {}) {
  let disposed = false;
  const userData = await mkdtemp(path.join(os.tmpdir(), prefix));
  const handlers = new Map();
  const listeners = new Map();
  const windows = [];
  const agents = [];
  const appListeners = new Map();
  const protocolHandlers = new Map();
  const globalShortcuts = new Map();
  const externalUrls = [];
  const relaunches = [];
  let quitAttempts = 0;
  let completedQuits = 0;

  class FakeWindow {
    static getAllWindows() { return windows; }
    webContents = {
      sent: [],
      listeners: new Map(),
      send: (channel, event) => this.webContents.sent.push({ channel, event }),
      on: (name, listener) => this.webContents.listeners.set(name, listener),
      setWindowOpenHandler: (handler) => { this.webContents.windowOpenHandler = handler; },
      getZoomFactor: () => 1,
    };
    /** Views live in exactly one window, the way Electron parents them. */
    children = [];
    contentView = {
      addChildView: (view) => {
        for (const other of windows) other.children = other.children.filter((child) => child !== view);
        this.children.push(view);
      },
      removeChildView: (view) => { this.children = this.children.filter((child) => child !== view); },
    };
    constructor(options) { this.options = options; this.visible = options?.show !== false; windows.push(this); }
    destroy() {
      this.destroyed = true;
      const at = windows.indexOf(this);
      if (at !== -1) windows.splice(at, 1);
    }
    isDestroyed() { return this.destroyed === true; }
    isFocused() { return this.focused === true; }
    isMinimized() { return false; }
    isVisible() { return this.visible !== false; }
    restore() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    on() {}
    async loadFile() {}
  }

  const Notification = fakeNotifications();

  globalThis.__claudexElectron = {
    app: {
      dock: { setIcon() {} },
      setName() {},
      getAppPath: () => process.cwd(),
      getPath: () => userData,
      whenReady: () => Promise.resolve(),
      on: (name, listener) => appListeners.set(name, listener),
      requestSingleInstanceLock: () => true,
      setAsDefaultProtocolClient() {},
      focus() {},
      quit() {
        quitAttempts += 1;
        let prevented = false;
        appListeners.get("before-quit")?.({ preventDefault: () => { prevented = true; } });
        if (!prevented) {
          completedQuits += 1;
          appListeners.get("will-quit")?.();
        }
      },
      relaunch: (relaunchOptions) => { relaunches.push(relaunchOptions); },
      exit() {},
    },
    BrowserWindow: FakeWindow,
    globalShortcut: {
      register: (accelerator, callback) => { globalShortcuts.set(accelerator, callback); return true; },
      unregisterAll: () => globalShortcuts.clear(),
    },
    Notification,
    nativeTheme: { themeSource: "system" },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      on: (name, listener) => listeners.set(name, listener),
    },
    utilityProcess: { fork: () => { const agent = new FakeAgent(); agents.push(agent); return agent; } },
    protocol: { registerSchemesAsPrivileged() {}, handle: (scheme, handler) => protocolHandlers.set(scheme, handler) },
    net: { fetch: async (url) => new Response(url) },
    shell: {
      openExternal: async (url) => { externalUrls.push(url); },
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
  globalThis.__dirname = path.join(process.cwd(), "dist/main/main");
  process.versions.chrome = "141.0.0.0";

  const vite = await createServer({
    logLevel: "silent",
    appType: "custom",
    /** xterm's `module` field points at a file it does not ship, so its real ESM build is named here. */
    resolve: { alias: { electron: "virtual:fake-electron", "@xterm/headless": "@xterm/headless/lib-headless/xterm-headless.mjs" } },
    server: { middlewareMode: true },
    ssr: { external: ["@lydell/node-pty"] },
    plugins: [{
      name: "fake-electron",
      enforce: "pre",
      resolveId(id) { if (id === "virtual:fake-electron") return "\0fake-electron"; },
      load(id) {
        if (id === "\0fake-electron") return "const e = globalThis.__claudexElectron; export const app=e.app, BrowserWindow=e.BrowserWindow, dialog=e.dialog, globalShortcut=e.globalShortcut, ipcMain=e.ipcMain, nativeTheme=e.nativeTheme, net=e.net, Notification=e.Notification, protocol=e.protocol, session=e.session, shell=e.shell, utilityProcess=e.utilityProcess, WebContentsView=e.WebContentsView;";
      },
    }, ...(options.computerUse ? [{
      name: "fake-computer-use",
      enforce: "pre",
      resolveId(id, importer) {
        if (id === "./computer-use-host.js" && importer?.endsWith("/src/main/main.ts")) return "\0fake-computer-use";
      },
      load(id) {
        if (id === "\0fake-computer-use") return "const c = globalThis.__claudexComputerUse; export const computerUseForRun=c.computerUseForRun, computerUsePermissions=c.computerUsePermissions, requestComputerUsePermission=c.requestComputerUsePermission, stopComputerUse=c.stopComputerUse;";
      },
    }] : [])],
  });
  if (options.computerUse) globalThis.__claudexComputerUse = options.computerUse;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    appListeners.get("will-quit")?.();
    await vite.close();
    await rm(userData, { recursive: true, force: true });
    delete globalThis.__claudexElectron;
    delete globalThis.__claudexComputerUse;
    delete globalThis.__dirname;
    delete process.versions.chrome;
  };
  t?.after(dispose);
  try {
    await vite.ssrLoadModule("/src/main/main.ts");
  } catch (cause) {
    await dispose();
    throw cause;
  }
  while (windows.length === 0) await tick();

  const window = windows[0];
  return {
    app: globalThis.__claudexElectron.app,
    dispose,
    userData,
    handlers,
    listeners,
    windows,
    agents,
    appListeners,
    externalUrls,
    relaunches,
    quitAttempts: () => quitAttempts,
    completedQuits: () => completedQuits,
    protocolHandlers,
    globalShortcuts,
    notifications: Notification.raised,
    window,
    trusted: { sender: window.webContents },
    untrusted: { sender: {} },
    sentOn: (channel) => window.webContents.sent.filter((entry) => entry.channel === channel).map((entry) => entry.event),
  };
}
