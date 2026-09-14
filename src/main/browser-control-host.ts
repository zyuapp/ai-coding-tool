import type { WebContentsView } from "electron";
import { MAX_BROWSER_FRAME_BYTES, type BrowserControl, type BrowserFrame, type BrowserViewport } from "../contracts/browser-control.js";

export type RemoteBrowserTab = {
  id: string;
  offscreen?: boolean;
  view: WebContentsView;
  epoch: number;
  shown: boolean;
  taskId?: string;
  remote?: { viewport: BrowserViewport; timer?: ReturnType<typeof setTimeout>; ownsDebugger?: boolean };
};
type LayoutMetrics = { cssLayoutViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number } };

/** Capture and input share a debugger. Serialize them so a screenshot cannot detach mid-keystroke. */
const pageWork = new WeakMap<RemoteBrowserTab, { tail: Promise<unknown>; count: number }>();
export function serializeBrowserPage<T>(tab: RemoteBrowserTab, work: () => Promise<T>): Promise<T> {
  const queue = pageWork.get(tab) ?? { tail: Promise.resolve(), count: 0 };
  if (queue.count >= 32) return Promise.reject(new Error("The browser is busy. Try again."));
  queue.count += 1;
  const result = queue.tail.catch(() => {}).then(() => {
    if (tab.view.webContents.isDestroyed()) throw new Error("That browser tab has closed.");
    return work();
  });
  queue.tail = result.catch(() => {}).finally(() => { queue.count -= 1; });
  pageWork.set(tab, queue);
  return result;
}

async function debuggerWork<T>(tab: RemoteBrowserTab, work: (debug: Electron.Debugger) => Promise<T>): Promise<T> {
  const debug = tab.view.webContents.debugger;
  const borrowed = !debug.isAttached();
  if (!borrowed && !tab.remote?.ownsDebugger) throw new Error("Close this tab’s DevTools to control it here.");
  if (borrowed) { debug.attach("1.3"); if (tab.remote) tab.remote.ownsDebugger = true; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(debug), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (tab.remote?.ownsDebugger && debug.isAttached()) debug.detach();
        reject(new Error("The browser did not answer. Try closing its DevTools and reconnecting."));
      }, 5_000);
    })]);
  } finally {
    clearTimeout(timer);
    if (borrowed && !tab.remote && debug.isAttached()) debug.detach();
  }
}

export function createRemoteBrowserControl(getTab: (id: string) => RemoteBrowserTab | undefined, layout: (tab: RemoteBrowserTab) => void) {
  /** A dropped connection must not leave background pages drawing forever. Reads renew the lease. */
  function renewRemote(tab: RemoteBrowserTab) {
    if (!tab.remote) return;
    clearTimeout(tab.remote.timer);
    const timer = setTimeout(() => { void setRemoteViewport(tab.id, null, timer).catch(() => {}); }, 5_000);
    tab.remote.timer = timer;
    tab.remote.timer.unref?.();
  }

  async function setRemoteViewport(tabId: string, viewport: BrowserViewport | null, expiredTimer?: ReturnType<typeof setTimeout>): Promise<void> {
    const tab = getTab(tabId);
    if (!tab) return;
    return serializeBrowserPage(tab, async () => {
      if (expiredTimer && tab.remote?.timer !== expiredTimer) return;
      if (viewport && !tab.offscreen) throw new Error("Open a copy of this tab for remote control.");
      if (tab.remote) clearTimeout(tab.remote.timer);
      if (viewport) {
        tab.remote = { ...tab.remote, viewport };
        renewRemote(tab);
      } else {
        if (tab.remote?.ownsDebugger && tab.view.webContents.debugger.isAttached()) {
          await debuggerWork(tab, async (debug) => {
            await debug.sendCommand("Emulation.clearDeviceMetricsOverride");
            await debug.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false });
          }).catch(() => {});
          if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach();
        }
        delete tab.remote;
      }
      tab.view.webContents.setBackgroundThrottling(!viewport);
      layout(tab);
      if (viewport) await debuggerWork(tab, async (debug) => {
        await debug.sendCommand("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      });
    });
  }

  /** One bounded JPEG per request; callers request again only after displaying the previous frame. */
  async function captureRemoteFrame(tabId: string): Promise<BrowserFrame | null> {
    const tab = getTab(tabId);
    if (!tab) return null;
    return serializeBrowserPage(tab, async () => {
      if (!tab.remote) throw new Error("Reconnect the browser to resume viewing.");
      renewRemote(tab);
      layout(tab);
      const epoch = tab.epoch;
      return debuggerWork(tab, async (debug) => {
        const metrics = await debug.sendCommand("Page.getLayoutMetrics") as LayoutMetrics;
        const { clientWidth: width, clientHeight: height } = metrics.cssLayoutViewport;
        if (width < 1 || height < 1) throw new Error("The browser is still preparing the page.");
        const scale = Math.min(1, 1600 / width, 1200 / height);
        let data = "";
        for (const quality of [65, 35]) {
          const shot = await debug.sendCommand("Page.captureScreenshot", { format: "jpeg", quality, fromSurface: true, captureBeyondViewport: true,
            clip: { x: metrics.cssLayoutViewport.pageX, y: metrics.cssLayoutViewport.pageY, width, height, scale: quality === 65 ? scale : scale / 2 } });
          data = shot.data as string;
          if (data.length <= MAX_BROWSER_FRAME_BYTES) break;
        }
        if (data.length > MAX_BROWSER_FRAME_BYTES) throw new Error("The browser frame is too large.");
        if (tab.epoch !== epoch) throw new Error("The page changed. Refreshing…");
        return { width: Math.round(width), height: Math.round(height), epoch, data };
      });
    });
  }

  /** User input follows the document and geometry the user saw, never a page that replaced it. */
  async function controlPage(tabId: string, epoch: number, input: BrowserControl): Promise<void> {
    const tab = getTab(tabId);
    if (!tab) throw new Error("That browser tab has closed.");
    return serializeBrowserPage(tab, async () => {
      if (!tab.remote || epoch !== tab.epoch) throw new Error("The page changed. Wait for its next frame.");
      renewRemote(tab);
      // This entry point is only exposed to validated user commands, not agent browser tools.
      tab.taskId = undefined;
      await debuggerWork(tab, async (debug) => {
        await debug.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
        if (input.kind === "text") await debug.sendCommand("Input.insertText", { text: input.text });
        else if (input.kind === "key") {
          await debug.sendCommand("Input.dispatchKeyEvent", {
            type: input.phase === "up" ? "keyUp" : input.key === "Enter" ? "keyDown" : "rawKeyDown", key: input.key, code: input.code,
            ...(input.phase === "down" && input.key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}),
            windowsVirtualKeyCode: input.keyCode, modifiers: input.modifiers, autoRepeat: input.repeat,
          });
        } else {
          const metrics = await debug.sendCommand("Page.getLayoutMetrics") as LayoutMetrics;
          if (input.x >= metrics.cssLayoutViewport.clientWidth || input.y >= metrics.cssLayoutViewport.clientHeight) return;
          await debug.sendCommand("Input.dispatchMouseEvent", input.kind === "wheel"
            ? { type: "mouseWheel", x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers }
            : { type: input.phase === "down" ? "mousePressed" : input.phase === "up" ? "mouseReleased" : "mouseMoved",
              x: input.x, y: input.y, button: input.button, buttons: input.buttons, clickCount: input.clicks, modifiers: input.modifiers });
        }
      });
    });
  }

  return { setRemoteViewport, captureRemoteFrame, controlPage };
}
