import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { emptyTailscaleState, type TailscaleState } from "../../domain/mobile.js";
import { BIND_HOST, MOBILE_HEALTH_PATH, MOBILE_HEALTH_RESPONSE, MOBILE_INSTANCE, MOBILE_INSTANCE_HEADER } from "./addresses.mjs";

const run = promisify(execFile);

/** Long enough for a cold daemon to answer, short enough that settings never look frozen. */
const TAILSCALE_TIMEOUT = 10_000;
/** Serve provisions a certificate on its first call, which is slow the way any certificate is. */
const TAILSCALE_SERVE_TIMEOUT = 90_000;
/** The fallback is only a local trip through the tailnet, so a slow answer is not a healthy route. */
const TAILSCALE_HEALTH_TIMEOUT = 3_000;
/** A port on this machine answers at once or not at all. */
const LOCAL_HEALTH_TIMEOUT = 1_500;

/** CLI entry points used when the app's PATH does not contain Tailscale. */
const KNOWN_CLI_PATHS = [
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/tailscale",
];

let cachedBinary: string | null = null;

async function executable(candidate: string) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The PATH result first, followed by known CLI entry points without duplicates. */
export function tailscaleCommandCandidates(onPath: string | null): string[] {
  const candidates: string[] = [];
  if (onPath) candidates.push(onPath);
  for (const candidate of KNOWN_CLI_PATHS) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

/** Searched here rather than by `which`, which not every Linux installs. */
async function tailscaleOnPath(): Promise<string | null> {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "tailscale");
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/** The command, or null when this machine has no Tailscale. Remembered, because the answer rarely moves. */
export async function findTailscale(): Promise<string | null> {
  if (cachedBinary && await executable(cachedBinary)) return cachedBinary;
  cachedBinary = null;
  const onPath = await tailscaleOnPath();
  for (const candidate of tailscaleCommandCandidates(onPath)) {
    if (await executable(candidate)) {
      cachedBinary = candidate;
      return candidate;
    }
  }
  return null;
}

function readable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: string } | null)?.stderr?.trim();
  const text = (stderr || message).split("\n").find((line) => line.trim()) ?? message;
  return text.trim().replace(/^Error:\s*/i, "") || "Tailscale could not be reached.";
}

/** The one refusal a user fixes with a command rather than a setting, so the command is what it says. */
export const OPERATOR_NEEDED = "Tailscale needs permission. Run: sudo tailscale set --operator=$USER";

/** What a failed serve says, with Linux's refusal of a user who is not Tailscale's operator named as such. */
export function serveFailure(error: unknown) {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const said = `${typeof stderr === "string" ? stderr : ""}\n${error instanceof Error ? error.message : String(error)}`;
  return /access denied|--operator/i.test(said) ? OPERATOR_NEEDED : readable(error);
}

/** A stop aborts whatever is still asking, so a slow certificate never holds the app open. */
async function tailscale(binary: string, args: string[], timeout = TAILSCALE_TIMEOUT, signal?: AbortSignal) {
  const { stdout } = await run(binary, args, { timeout, maxBuffer: 4 * 1024 * 1024, ...(signal ? { signal } : {}) });
  return stdout;
}

function within(timeout: number, signal?: AbortSignal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}

/** What Serve is set up to do. No config at all is what an unused Tailscale answers. */
async function serveConfig(binary: string, signal?: AbortSignal): Promise<unknown> {
  return parseTailscaleJson(await tailscale(binary, ["serve", "status", "--json"], TAILSCALE_TIMEOUT, signal) || "{}");
}

/**
 * Whether the tailnet will issue this machine a certificate. A tailnet with HTTPS turned off answers
 * with no domains at all, and `serve --https` against it hangs rather than refusing, so this is
 * checked before serve is ever asked.
 */
function certDomains(status: unknown): string[] {
  const domains = (status as { CertDomains?: unknown } | null)?.CertDomains;
  return Array.isArray(domains) ? domains.filter((domain): domain is string => typeof domain === "string") : [];
}

/** MagicDNS names come back with the root dot the DNS protocol writes; a URL wants it gone. */
function trimDnsName(name: unknown) {
  return typeof name === "string" && name.length > 1 ? name.replace(/\.$/, "") : null;
}

function backendStatus(state: unknown): TailscaleState["status"] {
  return state === "Running" ? "ready" : "logged-out";
}

/** Tailscale can report a startup failure on stdout with a successful exit code. */
export function parseTailscaleJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch (error) {
    const response = output.trim().split("\n").find((line) => line.trim());
    if (response && !response.trimStart().startsWith("{") && !response.trimStart().startsWith("[")) {
      throw new Error(response.trim());
    }
    throw error;
  }
}

/** The instance a health probe reached, or null when what answered is not this app at all. */
async function healthInstance(url: string, signal: AbortSignal, request: typeof fetch): Promise<string | null> {
  try {
    const response = await request(url, { cache: "no-store", signal });
    if (!response.ok || await response.text() !== MOBILE_HEALTH_RESPONSE) return null;
    /** A copy from before the header still answers as this app, just not as this process. */
    return response.headers.get(MOBILE_INSTANCE_HEADER) ?? "";
  } catch {
    return null;
  }
}

/**
 * Proves that HTTPS for the saved tailnet name still terminates at this process, not merely at this
 * app: a dev build beside the installed one answers the same body from a server of its own.
 */
export async function reachesMobileServer(magicDnsName: string, request: typeof fetch = fetch, signal?: AbortSignal): Promise<boolean> {
  const url = `https://${magicDnsName}${MOBILE_HEALTH_PATH}`;
  return await healthInstance(url, within(TAILSCALE_HEALTH_TIMEOUT, signal), request) === MOBILE_INSTANCE;
}

/** Whether another running copy of this app listens on a local port. Nothing answering is no copy at all. */
export async function anotherInstanceListens(port: number, request: typeof fetch = fetch, signal?: AbortSignal): Promise<boolean> {
  const instance = await healthInstance(`http://${BIND_HOST}:${port}${MOBILE_HEALTH_PATH}`, within(LOCAL_HEALTH_TIMEOUT, signal), request);
  return instance !== null && instance !== MOBILE_INSTANCE;
}

/**
 * Whether Serve is pointed at our port. The config names every handler it proxies, so the answer is
 * whether any of them is this server rather than something else the user set up.
 */
export function servesPort(config: unknown, port: number): boolean {
  if (!config || typeof config !== "object") return false;
  const web = (config as { Web?: unknown }).Web;
  if (!web || typeof web !== "object") return false;
  const target = `http://127.0.0.1:${port}`;
  for (const host of Object.values(web as Record<string, unknown>)) {
    const handlers = (host as { Handlers?: unknown } | null)?.Handlers;
    if (!handlers || typeof handlers !== "object") continue;
    for (const handler of Object.values(handlers as Record<string, unknown>)) {
      if ((handler as { Proxy?: unknown } | null)?.Proxy === target) return true;
    }
  }
  return false;
}

/** The local ports Serve hands HTTPS on 443 to, which is where anything dialling this machine's name lands. */
export function servedPorts(config: unknown): number[] {
  const web = (config as { Web?: unknown } | null)?.Web;
  if (!web || typeof web !== "object") return [];
  const ports = new Set<number>();
  for (const [address, host] of Object.entries(web as Record<string, unknown>)) {
    if (!address.endsWith(":443")) continue;
    const handlers = (host as { Handlers?: unknown } | null)?.Handlers;
    if (!handlers || typeof handlers !== "object") continue;
    for (const handler of Object.values(handlers as Record<string, unknown>)) {
      const proxy = (handler as { Proxy?: unknown } | null)?.Proxy;
      const port = typeof proxy === "string" ? /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy)?.[1] : undefined;
      if (port) ports.add(Number(port));
    }
  }
  return [...ports];
}

/**
 * Whether 443 belongs to another running copy of this app: a dev build beside the installed one, or
 * `aic serve` on a data folder of its own. Taking it would hand that copy's paired devices to a server
 * that has never heard of them, so it is left alone. A port that no longer answers is a copy that has
 * gone, and its handler is free to take.
 */
export async function heldByAnotherInstance(config: unknown, port: number, request: typeof fetch = fetch, signal?: AbortSignal): Promise<boolean> {
  for (const served of servedPorts(config)) {
    if (served !== port && await anotherInstanceListens(served, request, signal)) return true;
  }
  return false;
}

/**
 * Never throws: a machine without Tailscale, or one that will not answer, is a state rather than a
 * failure. A name this machine was already known by survives a daemon that would not answer, because
 * the name is what the origin check and the QR are built from and a slow answer is not a rename.
 */
export async function readTailscale(port: number | null, knownName: string | null = null, signal?: AbortSignal): Promise<TailscaleState> {
  const binary = await findTailscale();
  if (!binary) return { ...emptyTailscaleState(), status: "missing" };
  let status: unknown;
  try {
    /** Without peers, because this is asked once a minute and a large tailnet makes the answer large. */
    status = parseTailscaleJson(await tailscale(binary, ["status", "--json", "--peers=false"], TAILSCALE_TIMEOUT, signal));
  } catch (error) {
    if (port !== null && knownName && await reachesMobileServer(knownName, fetch, signal)) {
      return { status: "ready", magicDnsName: knownName, certs: true, serving: true, error: null };
    }
    return { ...emptyTailscaleState(), status: "unavailable", magicDnsName: knownName, error: readable(error) };
  }
  const self = (status as { Self?: unknown } | null)?.Self;
  const state: TailscaleState = {
    status: backendStatus((status as { BackendState?: unknown } | null)?.BackendState),
    magicDnsName: trimDnsName((self as { DNSName?: unknown } | null)?.DNSName) ?? knownName,
    certs: certDomains(status).length > 0,
    serving: false,
    error: null,
  };
  if (state.status !== "ready" || port === null) return state;
  try {
    return { ...state, serving: servesPort(await serveConfig(binary, signal), port) };
  } catch {
    if (state.magicDnsName && await reachesMobileServer(state.magicDnsName, fetch, signal)) {
      return { ...state, certs: true, serving: true };
    }
    /** No serve config at all is what an unused Tailscale answers, and it is not an error to report. */
    return state;
  }
}

export type TailscaleAction = { ok: true } | { ok: false; message: string };

/** The one failure a user must go elsewhere to fix, so it names where rather than what went wrong. */
export const CERTS_OFF = "This tailnet does not issue HTTPS certificates yet. Turn on HTTPS in the Tailscale admin console, under DNS, then check again.";

/** Said instead of fighting another running copy of this app for the one HTTPS port a name has. */
export const HELD_ELSEWHERE = "Another AI Coding Tool on this computer is using Tailscale. Quit it, then check again.";

/**
 * Puts HTTPS on 443 in front of the local port. Tailscale holds this itself, across restarts of this
 * app. A config that cannot be read is served over, as it always was: only a copy that answers is
 * left alone.
 */
export async function startTailscaleServe(port: number, signal?: AbortSignal): Promise<TailscaleAction> {
  const binary = await findTailscale();
  if (!binary) return { ok: false, message: "Tailscale is not installed on this computer." };
  const ready = await readTailscale(null, null, signal);
  if (ready.status === "ready" && !ready.certs) return { ok: false, message: CERTS_OFF };
  try {
    const config = await serveConfig(binary, signal).catch(() => null);
    if (await heldByAnotherInstance(config, port, fetch, signal)) return { ok: false, message: HELD_ELSEWHERE };
    await tailscale(binary, ["serve", "--bg", "--https=443", `http://${BIND_HOST}:${port}`], TAILSCALE_SERVE_TIMEOUT, signal);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: serveFailure(error) };
  }
}

/** Takes 443 down only while it still points at this port, so another copy's handler is never removed. */
export async function stopTailscaleServe(port: number, signal?: AbortSignal): Promise<TailscaleAction> {
  const binary = await findTailscale();
  if (!binary) return { ok: true };
  try {
    if (!servedPorts(await serveConfig(binary, signal)).includes(port)) return { ok: true };
    await tailscale(binary, ["serve", "--https=443", "off"], TAILSCALE_TIMEOUT, signal);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: serveFailure(error) };
  }
}
