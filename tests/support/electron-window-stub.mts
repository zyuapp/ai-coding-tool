import { EventEmitter } from "node:events";
import type { BrowserBounds } from "../../src/domain/browser.js";

export type Callback = (...args: unknown[]) => unknown;
export type SentMessage = { channel: string; event: unknown };
export type WindowOpenHandler = (details: { url: string }) => { action: string };
export type ElectronOptions = { show?: boolean };

let nextWebContentsId = 1;

export class FakeWebContentsView {
  declare options: unknown;
  declare bounds: BrowserBounds;
  loadedBounds?: BrowserBounds;
  declare visible: boolean;
  destroyed = false;
  webContents = {
    sent: [] as SentMessage[],
    send: (channel: string, event: unknown) => { this.webContents.sent.push({ channel, event }); },
    isDestroyed: () => this.destroyed,
    id: nextWebContentsId++,
    listeners: new Map<string, Callback>(),
    on: (name: string, listener: Callback) => { this.webContents.listeners.set(name, listener); },
    once: (name: string, listener: Callback) => { this.webContents.listeners.set(name, listener); },
    off: (name: string, listener: Callback) => {
      if (this.webContents.listeners.get(name) === listener) this.webContents.listeners.delete(name);
    },
    emit: (name: string, ...args: unknown[]) => this.webContents.listeners.get(name)?.(...args),
    setWindowOpenHandler(_handler: WindowOpenHandler) {},
    close: () => { this.destroyed = true; },
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

/** Windows register themselves on creation, so `getAllWindows` answers from the list a test reads. */
export function fakeWindows(onAllClosed: () => void = () => {}) {
  const windows: FakeWindow[] = [];

  class FakeWindow extends EventEmitter {
    static getAllWindows() { return windows; }
    declare options: ElectronOptions;
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
    constructor(options: ElectronOptions) { super(); this.options = options; this.visible = options.show !== false; windows.push(this); }
    close() {
      if (this.destroyed) return;
      let prevented = false;
      this.emit("close", { preventDefault: () => { prevented = true; } });
      if (!prevented) this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      const at = windows.indexOf(this);
      if (at !== -1) windows.splice(at, 1);
      this.emit("closed");
      if (windows.length === 0) onAllClosed();
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
    async loadFile() {}
  }

  return { FakeWindow, windows };
}
