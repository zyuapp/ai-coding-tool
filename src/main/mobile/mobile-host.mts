import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MobileRequest, MobileResponse, MobileViewUpdate } from "../../contracts/mobile.js";
import {
  emptyMobileServerState,
  emptyTailscaleState,
  MOBILE_DEFAULT_PORT,
  pairingOffer,
  preferredAddress,
  type MobilePairingOffer,
  type MobileServerState,
  type TailscaleState,
} from "../../domain/mobile.js";
import { allowedOrigins, bindHost, reachableAddresses, tailscaleAddress } from "./addresses.mjs";
import { MobileServer } from "./mobile-server.mjs";
import { PairingStore } from "./pairing.mjs";
import { MobileRelay } from "./session-host.mjs";
import { readTailscale, startTailscaleServe, stopTailscaleServe, type TailscaleAction } from "./tailscale.mjs";

export type MobileHostOptions = {
  userData: string;
  /** The built phone page, served to whatever scans the QR. */
  staticRoot: string;
  /** Hands one relayed request to the window. False when there is no window to hand it to. */
  send(request: MobileRequest): boolean;
  /** What settings should now say. Called after anything at all moves. */
  onState(state: MobileServerState): void;
  /**
   * How Tailscale is asked about and driven. The real one when absent, which is every caller but a
   * test: shelling out to whatever Tailscale the machine happens to be running makes a test answer
   * differently on two machines.
   */
  tailscale?: TailscaleHooks;
};

export type TailscaleHooks = {
  read(port: number | null, knownName: string | null): Promise<TailscaleState>;
  start(port: number): Promise<TailscaleAction>;
  stop(): Promise<TailscaleAction>;
};

const REAL_TAILSCALE: TailscaleHooks = { read: readTailscale, start: startTailscaleServe, stop: stopTailscaleServe };

/** What the user chose, kept across launches so a paired phone still reaches a Mac that restarted. */
type MobileSettings = {
  version: 1;
  enabled: boolean;
  lanExposed: boolean;
  tailscaleServe: boolean;
};

const DEFAULT_SETTINGS: MobileSettings = { version: 1, enabled: false, lanExposed: false, tailscaleServe: false };

let options: MobileHostOptions | null = null;
let settings: MobileSettings = DEFAULT_SETTINGS;
let devices: PairingStore | null = null;
let relay: MobileRelay | null = null;
let server: MobileServer | null = null;
let tailscale: TailscaleState = emptyTailscaleState();
let starting = false;
let failure: string | null = null;
/**
 * Starting and stopping the server are awaited by IPC handlers the user can hammer, so they run one
 * after another: a start that overlapped a stop would build a second server over live sessions.
 */
let lifecycle: Promise<unknown> = Promise.resolve();

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(work, work);
  lifecycle = next.catch(() => undefined);
  return next;
}

function host(): MobileHostOptions {
  if (!options) throw new Error("The phone bridge is not ready.");
  return options;
}

function settingsPath() {
  return path.join(host().userData, "mobile.v1.json");
}

function readSettings(): MobileSettings {
  try {
    const stored = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<MobileSettings> | null;
    if (!stored) return DEFAULT_SETTINGS;
    return {
      version: 1,
      enabled: stored.enabled === true,
      lanExposed: stored.lanExposed === true,
      tailscaleServe: stored.tailscaleServe === true,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings() {
  try {
    writeFileSync(settingsPath(), JSON.stringify(settings));
  } catch (error) {
    console.error("Could not write the phone bridge settings:", error);
  }
}

/** The name a phone can reach, which is only a name while Tailscale is actually serving it. */
function servedName() {
  return tailscale.serving ? tailscale.magicDnsName : null;
}

function addresses() {
  const port = server?.port ?? null;
  if (port === null) return [];
  return reachableAddresses({ port, lanExposed: settings.lanExposed, magicDnsName: servedName() });
}

/**
 * Where a page may have come from. A tailnet name Tailscale has told us about counts even while
 * Serve is reported off, because one slow answer from the daemon would otherwise turn every phone
 * on the tailnet away at the next reconnection.
 */
function origins() {
  const known = tailscale.magicDnsName ? [tailscaleAddress(tailscale.magicDnsName)] : [];
  return allowedOrigins([...addresses(), ...known]);
}

export function mobileState(): MobileServerState {
  if (!options) return emptyMobileServerState();
  const reachable = addresses();
  const primary = preferredAddress(reachable);
  const pending = devices?.pending(Date.now()) ?? null;
  return {
    enabled: settings.enabled,
    status: starting ? "starting" : failure ? "error" : server?.status ?? "off",
    lanExposed: settings.lanExposed,
    port: server?.port ?? null,
    addresses: reachable,
    primary,
    devices: devices?.views() ?? [],
    sessions: server?.sessionViews() ?? [],
    tailscale,
    pairing: pending && primary ? pairingOffer(primary, pending) : null,
    error: failure ?? server?.error ?? null,
  };
}

function announce() {
  if (options) options.onState(mobileState());
}

function makeServer() {
  const store = devices;
  const bridge = relay;
  if (!store || !bridge) throw new Error("The phone bridge is not ready.");
  return new MobileServer({
    devices: store,
    staticRoot: host().staticRoot,
    port: MOBILE_DEFAULT_PORT,
    allowedOrigins: origins,
    snapshot: (sessionId) => bridge.snapshot(sessionId),
    command: (sessionId, command) => bridge.command(sessionId, command),
    onChange: announce,
  });
}

async function startServer() {
  if (server || !settings.enabled) return;
  starting = true;
  failure = null;
  announce();
  const started = makeServer();
  try {
    await started.start(bindHost(settings.lanExposed));
    server = started;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    starting = false;
  }
  /** Asking Tailscale can take a moment, so the bridge is reported as up before the answer lands. */
  if (server && settings.tailscaleServe) await applyTailscaleServe(true);
  else void refreshTailscaleState().then(announce);
  announce();
}

async function stopServer() {
  const running = server;
  server = null;
  await running?.stop();
  relay?.failAll("The phone bridge was turned off.");
}

/**
 * Reads the settings, and starts the server when the user left it on. Tailscale is asked about in
 * the background, because a machine without it must not slow the app's own launch.
 */
export async function startMobileHost(hooks: MobileHostOptions): Promise<void> {
  options = hooks;
  settings = readSettings();
  devices = new PairingStore(path.join(hooks.userData, "mobile-devices.v1.json"));
  relay = new MobileRelay({ send: hooks.send });
  if (settings.enabled) await inTurn(startServer);
  else void refreshTailscaleState().then(announce);
}

export async function stopMobileHost(): Promise<void> {
  /** Not written back: this only stops a start still queued behind the stop from taking effect. */
  settings = { ...settings, enabled: false };
  await inTurn(stopServer);
  options = null;
  devices = null;
  relay = null;
  tailscale = emptyTailscaleState();
}

export async function setMobileEnabled(enabled: boolean): Promise<MobileServerState> {
  if (settings.enabled === enabled) return mobileState();
  settings = { ...settings, enabled };
  writeSettings();
  if (enabled) await inTurn(startServer);
  else {
    await inTurn(stopServer);
    devices?.discardCode();
    failure = null;
  }
  announce();
  return mobileState();
}

/** The second bind is a different socket, so turning it on or off restarts the server under it. */
export async function setMobileLanExposed(exposed: boolean): Promise<MobileServerState> {
  if (settings.lanExposed === exposed) return mobileState();
  settings = { ...settings, lanExposed: exposed };
  writeSettings();
  devices?.discardCode();
  if (settings.enabled) {
    await inTurn(stopServer);
    await inTurn(startServer);
  }
  announce();
  return mobileState();
}

export async function createMobilePairingCode(): Promise<MobilePairingOffer> {
  const store = devices;
  if (!store) throw new Error("The phone bridge is not ready.");
  const primary = preferredAddress(addresses());
  if (!primary) throw new Error("Turn the phone bridge on before pairing a phone.");
  const code = store.mint(Date.now());
  announce();
  return pairingOffer(primary, code);
}

export async function revokeMobileDevice(deviceId: string): Promise<MobileServerState> {
  if (devices?.revoke(deviceId)) server?.dropDevice(deviceId);
  announce();
  return mobileState();
}

async function refreshTailscaleState() {
  tailscale = await tailscaleHooks().read(server?.port ?? null, tailscale.magicDnsName);
  return tailscale;
}

function tailscaleHooks(): TailscaleHooks {
  return options?.tailscale ?? REAL_TAILSCALE;
}

export async function refreshTailscale(): Promise<MobileServerState> {
  await refreshTailscaleState();
  announce();
  return mobileState();
}

/** Turning Serve on needs a port to point at, so it only ever happens while the server is listening. */
async function applyTailscaleServe(enabled: boolean) {
  const port = server?.port ?? null;
  const action = !enabled
    ? await tailscaleHooks().stop()
    : port === null
      ? { ok: false as const, message: "Turn the phone bridge on before serving it over Tailscale." }
      : await tailscaleHooks().start(port);
  await refreshTailscaleState();
  if (!action.ok) tailscale = { ...tailscale, error: action.message };
}

export async function setTailscaleServe(enabled: boolean): Promise<MobileServerState> {
  settings = { ...settings, tailscaleServe: enabled };
  writeSettings();
  devices?.discardCode();
  await applyTailscaleServe(enabled);
  announce();
  return mobileState();
}

export function publishMobileView(update: MobileViewUpdate): void {
  server?.publish(update);
}

export function answerMobileRequest(response: MobileResponse): void {
  relay?.answer(response);
}

/** The window went. Everything waiting on it gives up rather than holding a phone on a dead line. */
export function mobileWindowGone(): void {
  relay?.failAll("The AI Coding Tool window is not open.");
}

/** Whether closing the window should hide it: a paired phone still needs the renderer's state. */
export function mobileBridgeHolding(): boolean {
  return settings.enabled && server !== null && (devices?.list().length ?? 0) > 0;
}
