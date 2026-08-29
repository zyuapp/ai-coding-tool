import { ipcMain, powerSaveBlocker, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { isMobileResponse, type MobileRequest, type MobileViewUpdate } from "../../contracts/mobile.js";
import type { MobileServerState } from "../../domain/mobile.js";
import type * as MobileHost from "./mobile-host.mjs" with { "resolution-mode": "import" };

/** What the bridge needs from the app: the window that holds workspace state, and where files live. */
export type MobileBridgeHost = {
  window: () => BrowserWindow | null;
  userData: string;
  /** The built phone page. */
  staticRoot: string;
};

let app: MobileBridgeHost | null = null;
let host: typeof MobileHost | null = null;
let awake: number | null = null;

/** The server lives in an ES module of its own, so `ws` is only loaded when the bridge is wired up. */
async function loaded() {
  if (!host) host = await import("./mobile-host.mjs");
  return host;
}

function send(request: MobileRequest) {
  const window = app?.window();
  if (!window || window.isDestroyed()) return false;
  window.webContents.send("mobile:request", request);
  return true;
}

function publishState(state: MobileServerState) {
  const window = app?.window();
  if (window && !window.isDestroyed()) window.webContents.send("mobile:changed", state);
  keepAwake(state.sessions.length > 0);
}

/**
 * A phone on the line is a user at the keyboard, so the Mac may not sleep out from under it. Every
 * session counts, not only the connected ones: a phone that locks its screen mid-run drops its
 * socket, and letting the Mac sleep then would kill the run that phone is waiting on. A session
 * outlives its socket by five minutes, which is the window this holds the machine awake for.
 *
 * This is idle sleep only. Nothing an application can assert keeps a Mac awake with the lid shut.
 */
function keepAwake(needed: boolean) {
  if (needed === (awake !== null)) return;
  if (needed) {
    awake = powerSaveBlocker.start("prevent-app-suspension");
    return;
  }
  if (awake !== null && powerSaveBlocker.isStarted(awake)) powerSaveBlocker.stop(awake);
  awake = null;
}

export async function startMobileBridge(options: MobileBridgeHost) {
  app = options;
  const mobile = await loaded();
  await mobile.startMobileHost({ userData: options.userData, staticRoot: options.staticRoot, send, onState: publishState });
}

export async function stopMobileBridge() {
  keepAwake(false);
  await host?.stopMobileHost();
}

/** Whether a phone is still counting on the window, which is why closing it only hides it. */
export function mobileBridgeHolding() {
  return host?.mobileBridgeHolding() ?? false;
}

export function mobileWindowGone() {
  host?.mobileWindowGone();
}

function setting(value: unknown) {
  if (typeof value !== "boolean") throw new Error("Invalid phone bridge setting.");
  return value;
}

function deviceId(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid device ID.");
  return value;
}

/** The window's own derivation of what a phone sees, so only its shape is worth checking. */
function isViewUpdate(value: unknown): value is MobileViewUpdate {
  if (!value || typeof value !== "object") return false;
  const update = value as Record<string, unknown>;
  if (update.kind === "snapshot") return Boolean(update.view) && typeof update.view === "object";
  return update.kind === "patch" && Boolean(update.patch) && typeof update.patch === "object";
}

/**
 * Settings reads and changes the bridge; the window answers what a phone asked and pushes what a
 * phone should see. Only the app's own window may do any of it.
 */
export function serveMobileBridge(trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean) {
  const guard = (event: IpcMainInvokeEvent) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
  };
  ipcMain.handle("mobile:state", async (event) => { guard(event); return (await loaded()).mobileState(); });
  ipcMain.handle("mobile:set-enabled", async (event, enabled: unknown) => { guard(event); return (await loaded()).setMobileEnabled(setting(enabled)); });
  ipcMain.handle("mobile:pair-code", async (event) => { guard(event); return (await loaded()).createMobilePairingCode(); });
  ipcMain.handle("mobile:revoke", async (event, id: unknown) => { guard(event); return (await loaded()).revokeMobileDevice(deviceId(id)); });
  ipcMain.handle("mobile:tailscale-refresh", async (event) => { guard(event); return (await loaded()).refreshTailscale(); });
  ipcMain.on("mobile:answer", (event, response: unknown) => {
    if (!trusted(event) || !isMobileResponse(response)) return;
    host?.answerMobileRequest(response);
  });
  ipcMain.on("mobile:publish", (event, update: unknown) => {
    if (!trusted(event) || !isViewUpdate(update)) return;
    host?.publishMobileView(update);
  });
}
