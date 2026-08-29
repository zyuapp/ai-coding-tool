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
import { allowedOrigins, BIND_HOST, reachableAddresses, tailscaleAddress } from "./addresses.mjs";
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
  /**
   * The port to ask for, {@link MOBILE_DEFAULT_PORT} when absent. A test passes 0 rather than take a
   * well-known port on the developer's machine, which the running app may already be serving on.
   */
  port?: number;
};

export type TailscaleHooks = {
  read(port: number | null, knownName: string | null): Promise<TailscaleState>;
  start(port: number): Promise<TailscaleAction>;
  stop(): Promise<TailscaleAction>;
};

const REAL_TAILSCALE: TailscaleHooks = { read: readTailscale, start: startTailscaleServe, stop: stopTailscaleServe };

/**
 * What the user chose, kept across launches so a paired phone still reaches a Mac that restarted.
 * The tailnet name rides along so a phone that dials in before Tailscale has answered is recognised
 * as one of ours rather than turned away for coming from a name this process has not heard yet.
 */
type MobileSettings = {
  version: 1;
  enabled: boolean;
  magicDnsName: string | null;
};

const DEFAULT_SETTINGS: MobileSettings = { version: 1, enabled: false, magicDnsName: null };

/** How long to wait before asking Tailscale again while it is not yet serving: quick at first, then once a minute. */
const TAILSCALE_RETRY_MS = [5_000, 15_000, 60_000];

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
/**
 * Tailscale is slow to answer and slower to provision a certificate, so it is driven on a chain of
 * its own: the server turn ends the moment the port is up, and a stop never waits behind Serve. The
 * chain is still serial, so a stop's unserve runs after any serve that was in flight.
 */
let tailscaleWork: Promise<unknown> = Promise.resolve();
let tailscaleRetry: ReturnType<typeof setTimeout> | null = null;
let tailscaleAttempts = 0;

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(work, work);
  lifecycle = next.catch(() => undefined);
  return next;
}

function inTailscaleTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = tailscaleWork.then(work, work);
  tailscaleWork = next.catch(() => undefined);
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
      magicDnsName: typeof stored.magicDnsName === "string" && stored.magicDnsName ? stored.magicDnsName : null,
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
  return reachableAddresses({ port, magicDnsName: servedName() });
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
    status: !settings.enabled ? "off" : starting ? "starting" : failure ? "error" : server?.status ?? "off",
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
    port: host().port ?? MOBILE_DEFAULT_PORT,
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
    await started.start(BIND_HOST);
    server = started;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    starting = false;
  }
  announce();
  if (server) scheduleServe(0);
}

/**
 * Turning phone access off takes Serve down with it, so Tailscale stops answering for a port that no
 * longer listens. Quitting the app leaves Serve in place: Tailscale keeps the config across restarts,
 * and the server comes back on launch when the user left it on.
 */
async function stopServer(options: { unserve: boolean }) {
  cancelServeRetry();
  const running = server;
  server = null;
  await running?.stop();
  relay?.failAll("The phone bridge was turned off.");
  if (!options.unserve) return;
  await inTailscaleTurn(async () => {
    if (!tailscale.serving) return;
    const action = await tailscaleHooks().stop();
    await refreshTailscaleState();
    if (!action.ok) tailscale = { ...tailscale, error: action.message };
  });
}

function cancelServeRetry() {
  if (tailscaleRetry) clearTimeout(tailscaleRetry);
  tailscaleRetry = null;
  tailscaleAttempts = 0;
}

/** Asks Tailscale to serve the bridge after a pause, once at a time, and only while there is a bridge to serve. */
function scheduleServe(delayMs: number) {
  if (tailscaleRetry) clearTimeout(tailscaleRetry);
  tailscaleRetry = setTimeout(() => {
    tailscaleRetry = null;
    void inTailscaleTurn(serveIfReady).then(announce);
  }, delayMs);
  tailscaleRetry.unref?.();
}

/**
 * Reads the settings, and starts the server when the user left it on. Tailscale is asked about in
 * the background, because a machine without it must not slow the app's own launch.
 */
export async function startMobileHost(hooks: MobileHostOptions): Promise<void> {
  options = hooks;
  settings = readSettings();
  tailscale = { ...emptyTailscaleState(), magicDnsName: settings.magicDnsName };
  devices = new PairingStore(path.join(hooks.userData, "mobile-devices.v1.json"));
  relay = new MobileRelay({ send: hooks.send });
  if (settings.enabled) await inTurn(startServer);
  else void inTailscaleTurn(refreshTailscaleState).then(announce);
}

export async function stopMobileHost(): Promise<void> {
  /** Not written back: this only stops a start still queued behind the stop from taking effect. */
  settings = { ...settings, enabled: false };
  await inTurn(() => stopServer({ unserve: false }));
  await tailscaleWork;
  options = null;
  devices = null;
  relay = null;
  tailscale = emptyTailscaleState();
}

export async function setMobileEnabled(enabled: boolean): Promise<MobileServerState> {
  if (settings.enabled === enabled) return mobileState();
  settings = { ...settings, enabled };
  writeSettings();
  /** The switch answers at once; the server follows behind whatever turn is still running. */
  announce();
  if (enabled) await inTurn(startServer);
  else {
    await inTurn(() => stopServer({ unserve: true }));
    devices?.discardCode();
    failure = null;
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
  if (tailscale.magicDnsName && tailscale.magicDnsName !== settings.magicDnsName) {
    settings = { ...settings, magicDnsName: tailscale.magicDnsName };
    writeSettings();
  }
  return tailscale;
}

function tailscaleHooks(): TailscaleHooks {
  return options?.tailscale ?? REAL_TAILSCALE;
}

/**
 * Asks Tailscale again, and finishes the setup if it now can: a user who installs or signs into
 * Tailscale after turning phone access on presses "Check again" and is served without another switch.
 */
export async function refreshTailscale(): Promise<MobileServerState> {
  cancelServeRetry();
  await inTailscaleTurn(async () => {
    if (server) await serveIfReady();
    else await refreshTailscaleState();
  });
  announce();
  return mobileState();
}

/**
 * Puts Tailscale Serve in front of the listening server whenever Tailscale is able to. A tailnet that
 * is not signed in or issues no certificate is reported as it stands rather than asked and left to
 * hang, and asked again later: Tailscale often comes up after the app does, and the user may install
 * or sign into it with phone access already on.
 */
async function serveIfReady() {
  const listening = server;
  const port = listening?.port ?? null;
  if (!listening || port === null || !settings.enabled) return;
  await refreshTailscaleState();
  if (server !== listening) return;
  if (tailscale.serving) {
    tailscaleAttempts = 0;
    return;
  }
  if (tailscale.status === "ready" && tailscale.certs) {
    const action = await tailscaleHooks().start(port);
    if (server !== listening) return;
    await refreshTailscaleState();
    if (!action.ok) tailscale = { ...tailscale, error: action.message };
    else devices?.discardCode();
    if (tailscale.serving) {
      tailscaleAttempts = 0;
      return;
    }
  }
  const delay = TAILSCALE_RETRY_MS[Math.min(tailscaleAttempts, TAILSCALE_RETRY_MS.length - 1)]!;
  tailscaleAttempts += 1;
  scheduleServe(delay);
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
