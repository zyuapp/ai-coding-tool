import { readFileSync, writeFileSync } from "node:fs";
import type { ThreadNotice } from "../../contracts/ipc.js";
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
import { allowedOrigins, BIND_HOST, loopbackAddress, reachableAddresses, tailscaleAddress } from "./addresses.mjs";
import { serveDevelopmentPairing } from "./development.mjs";
import { MobileServer, type WorkspaceHooks } from "./mobile-server.mjs";
import { PairingStore } from "./pairing.mjs";
import { MobileRelay } from "./session-host.mjs";
import { readTailscale, startTailscaleServe, stopTailscaleServe, type TailscaleAction } from "./tailscale.mjs";

export type MobileHostOptions = {
  userData: string;
  /** Present only for source launches; the installed app never serves automatic pairing. */
  developmentRoot?: string;
  /** The built phone page, served to whatever scans the QR. */
  staticRoot: string;
  /** Hands one relayed request to the window. False when there is no window to hand it to. */
  send(request: MobileRequest): boolean;
  /** What settings should now say. Called after anything at all moves. */
  onState(state: MobileServerState): void;
  /** What another computer is handed and may drive. Absent on a host that takes no computers. */
  workspace?: WorkspaceHooks;
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

/** Each is handed a signal a stop aborts, so a slow answer never holds the app open. */
export type TailscaleHooks = {
  read(port: number | null, knownName: string | null, signal?: AbortSignal): Promise<TailscaleState>;
  start(port: number, signal?: AbortSignal): Promise<TailscaleAction>;
  /** Takes Serve down only while it still points at this port. */
  stop(port: number, signal?: AbortSignal): Promise<TailscaleAction>;
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
/**
 * How often Serve is looked at once it works. Tailscale can be reset, reinstalled or signed into
 * another account, or 443 handed to another copy of this app, and nothing tells us when it happens.
 */
const SERVE_CHECK_MS = 60_000;
/** How long to wait before starting a server that would not start, the same way. */
const SERVER_RETRY_MS = [5_000, 15_000, 60_000];

let options: MobileHostOptions | null = null;
let settings: MobileSettings = DEFAULT_SETTINGS;
let devices: PairingStore | null = null;
let relay: MobileRelay | null = null;
let server: MobileServer | null = null;
let tailscale: TailscaleState = emptyTailscaleState();
let starting = false;
let stopping = false;
let failure: string | null = null;
let stopDevelopmentPairing: (() => Promise<void>) | null = null;
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
/** Aborted by every stop, so a turn off or a quit never waits out a slow certificate. */
let tailscaleAbort = new AbortController();
let serverRetry: ReturnType<typeof setTimeout> | null = null;
let serverAttempts = 0;

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

/** The pause before the next try, which stops growing at the last one. */
function backoff(delays: number[], attempt: number) {
  return delays[Math.min(attempt, delays.length - 1)]!;
}

function makeServer() {
  const store = devices;
  const bridge = relay;
  if (!store || !bridge) throw new Error("The phone bridge is not ready.");
  const made: MobileServer = new MobileServer({
    devices: store,
    staticRoot: host().staticRoot,
    port: host().port ?? (host().developmentRoot ? 0 : MOBILE_DEFAULT_PORT),
    allowedOrigins: origins,
    snapshot: (sessionId) => bridge.snapshot(sessionId),
    command: (sessionId, command) => bridge.command(sessionId, command),
    query: (sessionId, query) => bridge.query(sessionId, query),
    onChange: () => {
      if (made === server && made.status === "error") void inTurn(() => recover(made)).catch((error) => console.error("Could not restart the phone bridge:", error));
      announce();
    },
    ...(host().workspace ? { workspace: host().workspace } : {}),
  });
  return made;
}

/** A server that would not start is tried again for as long as phone access stays on. */
async function startServer(localDevelopment = false) {
  if (stopping || server || (!settings.enabled && !localDevelopment)) return;
  starting = true;
  failure = null;
  announce();
  const started = makeServer();
  try {
    await started.start(BIND_HOST);
    server = started;
    cancelServerRetry();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    starting = false;
  }
  announce();
  if (server && settings.enabled) scheduleServe(0);
  else if (!server && settings.enabled && !stopping) scheduleStart();
}

/** A server that lost its port is let go and started again, the way one that never had a port is. */
async function recover(broken: MobileServer) {
  if (server !== broken) return;
  await stopServer({ unserve: false });
  failure = broken.error;
  announce();
  if (settings.enabled && !stopping) scheduleStart();
}

function scheduleStart() {
  if (serverRetry) clearTimeout(serverRetry);
  serverRetry = setTimeout(() => {
    serverRetry = null;
    void inTurn(() => startServer()).catch((error) => console.error("Could not start the phone bridge:", error));
  }, backoff(SERVER_RETRY_MS, serverAttempts));
  serverAttempts += 1;
  serverRetry.unref?.();
}

function cancelServerRetry() {
  if (serverRetry) clearTimeout(serverRetry);
  serverRetry = null;
  serverAttempts = 0;
}

/** Stops whatever Tailscale is still being asked, and hands what comes next a signal of its own. */
function abortTailscale() {
  tailscaleAbort.abort();
  tailscaleAbort = new AbortController();
}

/**
 * Turning phone access off takes Serve down with it, so Tailscale stops answering for a port that no
 * longer listens, but only while Serve still points here: another copy of the app may hold it now.
 * Quitting the app leaves Serve in place: Tailscale keeps the config across restarts, and the server
 * comes back on launch when the user left it on.
 */
async function stopServer(options: { unserve: boolean }) {
  cancelServeRetry();
  cancelServerRetry();
  abortTailscale();
  const running = server;
  const port = running?.port ?? null;
  server = null;
  await running?.stop();
  relay?.failAll("The phone bridge was turned off.");
  if (!options.unserve || port === null) return;
  await inTailscaleTurn(async () => {
    const action = await tailscaleHooks().stop(port, tailscaleAbort.signal);
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
    void inTailscaleTurn(serveIfReady).then(announce, (error) => console.error("Could not check Tailscale:", error));
  }, delayMs);
  tailscaleRetry.unref?.();
}

/**
 * Reads the settings, and starts the server when the user left it on. Tailscale is asked about in
 * the background, because a machine without it must not slow the app's own launch.
 */
export async function startMobileHost(hooks: MobileHostOptions): Promise<void> {
  stopping = false;
  tailscaleAbort = new AbortController();
  options = hooks;
  settings = readSettings();
  tailscale = { ...emptyTailscaleState(), magicDnsName: settings.magicDnsName };
  devices = new PairingStore(path.join(hooks.userData, "mobile-devices.v1.json"));
  relay = new MobileRelay({ send: hooks.send });
  if (hooks.developmentRoot) {
    stopDevelopmentPairing = await serveDevelopmentPairing(hooks.developmentRoot, () => inTurn(async () => {
      await startServer(true);
      const port = server?.port;
      if (port == null || !devices) throw new Error("The desktop mobile bridge is not ready.");
      const code = devices.mint(Date.now());
      announce();
      return pairingOffer(loopbackAddress(port), code);
    }));
  }
  if (settings.enabled) await inTurn(() => startServer());
  else if (!hooks.developmentRoot) void inTailscaleTurn(refreshTailscaleState).then(announce, (error) => console.error("Could not check Tailscale:", error));
}

/** Stopping never waits on Tailscale: whatever it is still being asked is aborted. */
export async function stopMobileHost(): Promise<void> {
  stopping = true;
  cancelServeRetry();
  cancelServerRetry();
  abortTailscale();
  await stopDevelopmentPairing?.();
  stopDevelopmentPairing = null;
  await inTurn(() => stopServer({ unserve: false }));
  await tailscaleWork;
  options = null;
  devices = null;
  relay = null;
  tailscale = emptyTailscaleState();
}

export async function setMobileEnabled(enabled: boolean): Promise<MobileServerState> {
  /** On but not running is a server that failed, which asking again starts rather than shrugs at. */
  if (settings.enabled === enabled && (!enabled || server)) return mobileState();
  if (settings.enabled !== enabled) {
    settings = { ...settings, enabled };
    writeSettings();
  }
  /** The switch answers at once; the server follows behind whatever turn is still running. */
  announce();
  if (enabled) await inTurn(async () => {
    if (server) scheduleServe(0);
    else await startServer();
  });
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
  const { signal } = tailscaleAbort;
  const read = await tailscaleHooks().read(server?.port ?? null, tailscale.magicDnsName, signal);
  /** An answer cut short by a stop says nothing about Tailscale. */
  if (signal.aborted) return tailscale;
  tailscale = read;
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
 * A server that would not start is tried again first, since there is nothing to serve without one.
 */
export async function refreshTailscale(): Promise<MobileServerState> {
  cancelServeRetry();
  if (settings.enabled && !server) {
    await inTurn(() => startServer());
    /** This check is about to serve it, so the one a fresh server schedules would only repeat it. */
    cancelServeRetry();
  }
  await inTailscaleTurn(async () => {
    if (server) await serveIfReady();
    else await refreshTailscaleState();
  });
  announce();
  return mobileState();
}

/**
 * Looks again now rather than at the next check: a machine that slept may wake to a Tailscale that
 * was reset or handed 443 elsewhere meanwhile, and to a server that can start where it could not.
 */
export function recheckMobileHost(): void {
  if (!options || stopping || !settings.enabled) return;
  if (server) {
    cancelServeRetry();
    scheduleServe(0);
  } else if (!starting) {
    void inTurn(() => startServer()).catch((error) => console.error("Could not start the phone bridge:", error));
  }
}

/**
 * Keeps Tailscale Serve in front of the listening server for as long as it listens. A tailnet that
 * is not signed in or issues no certificate is reported as it stands rather than asked and left to
 * hang, and asked again later: Tailscale often comes up after the app does, and the user may install
 * or sign into it with phone access already on. Once served it is still looked at once a minute,
 * and served again the moment it points anywhere else. Whatever goes wrong, the next look is booked.
 */
async function serveIfReady() {
  const listening = server;
  const port = listening?.port ?? null;
  if (stopping || !listening || port === null || !settings.enabled) return;
  let serving = false;
  try {
    serving = await serveListening(listening, port);
  } catch (error) {
    console.error("Could not serve the phone bridge over Tailscale:", error);
  }
  if (stopping || server !== listening || !settings.enabled) return;
  if (serving) tailscaleAttempts = 0;
  else tailscaleAttempts += 1;
  scheduleServe(serving ? SERVE_CHECK_MS : backoff(TAILSCALE_RETRY_MS, tailscaleAttempts - 1));
}

/** Whether Serve now fronts this server, having asked it to when Tailscale is able to. */
async function serveListening(listening: MobileServer, port: number) {
  await refreshTailscaleState();
  if (server !== listening) return false;
  if (tailscale.serving) return true;
  if (tailscale.status !== "ready" || !tailscale.certs) return false;
  const action = await tailscaleHooks().start(port, tailscaleAbort.signal);
  if (server !== listening) return false;
  await refreshTailscaleState();
  if (!action.ok) tailscale = { ...tailscale, error: action.message };
  else devices?.discardCode();
  return tailscale.serving;
}

/** Hands a notice to the computers on the line; with no server up there is no one to hand it to. */
export function noticeComputers(notice: ThreadNotice): void {
  server?.notice(notice);
}

/** Tells the computers on the line what this one now calls itself. */
export function announceComputerName(): void {
  server?.announceName();
}

export function publishMobileView(update: MobileViewUpdate): void {
  server?.publish(update);
}

export function answerMobileRequest(response: MobileResponse): void {
  relay?.answer(response);
}
