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

/**
 * Boots src/main/main.ts against a stub Electron so IPC wiring can be driven from a test.
 * Each boot starts its own Vite server, so share one per test file rather than one per test.
 */
export async function startMainProcess(t, prefix) {
  let disposed = false;
  const userData = await mkdtemp(path.join(os.tmpdir(), prefix));
  const handlers = new Map();
  const listeners = new Map();
  const windows = [];
  const agents = [];
  const appListeners = new Map();
  const protocolHandlers = new Map();

  class FakeWindow {
    static getAllWindows() { return windows; }
    webContents = {
      sent: [],
      listeners: new Map(),
      send: (channel, event) => this.webContents.sent.push({ channel, event }),
      on: (name, listener) => this.webContents.listeners.set(name, listener),
      getZoomFactor: () => 1,
    };
    contentView = { addChildView() {}, removeChildView() {} };
    constructor(options) { this.options = options; windows.push(this); }
    isDestroyed() { return false; }
    on() {}
    async loadFile() {}
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
    setBounds() {}
    setVisible() {}
  }

  globalThis.__claudexElectron = {
    app: {
      dock: { setIcon() {} },
      setName() {},
      getAppPath: () => process.cwd(),
      getPath: () => userData,
      whenReady: () => Promise.resolve(),
      on: (name, listener) => appListeners.set(name, listener),
      quit() {},
    },
    BrowserWindow: FakeWindow,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      on: (name, listener) => listeners.set(name, listener),
    },
    utilityProcess: { fork: () => { const agent = new FakeAgent(); agents.push(agent); return agent; } },
    protocol: { registerSchemesAsPrivileged() {}, handle: (scheme, handler) => protocolHandlers.set(scheme, handler) },
    net: { fetch: async (url) => new Response(url) },
    session: { fromPartition: () => ({ setUserAgent() {}, async clearStorageData() {}, async clearCache() {} }) },
    WebContentsView: FakeWebContentsView,
  };
  globalThis.__dirname = path.join(process.cwd(), "dist/main/main");

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
        if (id === "\0fake-electron") return "const e = globalThis.__claudexElectron; export const app=e.app, BrowserWindow=e.BrowserWindow, dialog=e.dialog, ipcMain=e.ipcMain, net=e.net, protocol=e.protocol, session=e.session, utilityProcess=e.utilityProcess, WebContentsView=e.WebContentsView;";
      },
    }],
  });
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    appListeners.get("will-quit")?.();
    await vite.close();
    await rm(userData, { recursive: true, force: true });
    delete globalThis.__claudexElectron;
    delete globalThis.__dirname;
  };
  t?.after(dispose);
  await vite.ssrLoadModule("/src/main/main.ts");
  while (windows.length === 0) await tick();

  const window = windows[0];
  return {
    dispose,
    userData,
    handlers,
    listeners,
    windows,
    agents,
    appListeners,
    protocolHandlers,
    window,
    trusted: { sender: window.webContents },
    untrusted: { sender: {} },
    sentOn: (channel) => window.webContents.sent.filter((entry) => entry.channel === channel).map((entry) => entry.event),
  };
}
