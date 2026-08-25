import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { emptyTailscaleState, type TailscaleState } from "../../domain/mobile.js";

const run = promisify(execFile);

/** Long enough for a cold daemon to answer, short enough that settings never look frozen. */
const TAILSCALE_TIMEOUT = 10_000;
/** Serve provisions a certificate on its first call, which is slow the way any certificate is. */
const TAILSCALE_SERVE_TIMEOUT = 90_000;

/** Where a Mac keeps the command: the app bundle first, then the two package managers. */
const KNOWN_PATHS = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
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

/** The command, or null when this machine has no Tailscale. Remembered, because the answer rarely moves. */
export async function findTailscale(): Promise<string | null> {
  if (cachedBinary && await executable(cachedBinary)) return cachedBinary;
  cachedBinary = null;
  for (const candidate of KNOWN_PATHS) {
    if (await executable(candidate)) {
      cachedBinary = candidate;
      return candidate;
    }
  }
  try {
    const { stdout } = await run("/usr/bin/which", ["tailscale"], { timeout: TAILSCALE_TIMEOUT });
    const found = stdout.trim();
    if (found && await executable(found)) cachedBinary = found;
  } catch {
    // Not on the PATH either, which is simply a machine without Tailscale.
  }
  return cachedBinary;
}

function readable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = (error as { stderr?: string } | null)?.stderr?.trim();
  const text = (stderr || message).split("\n").find((line) => line.trim()) ?? message;
  return text.trim().replace(/^Error:\s*/i, "") || "Tailscale could not be reached.";
}

async function tailscale(binary: string, args: string[], timeout = TAILSCALE_TIMEOUT) {
  const { stdout } = await run(binary, args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
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

/**
 * Never throws: a machine without Tailscale, or one that will not answer, is a state rather than a
 * failure. A name this machine was already known by survives a daemon that would not answer, because
 * the name is what the origin check and the QR are built from and a slow answer is not a rename.
 */
export async function readTailscale(port: number | null, knownName: string | null = null): Promise<TailscaleState> {
  const binary = await findTailscale();
  if (!binary) return { ...emptyTailscaleState(), status: "missing" };
  let status: unknown;
  try {
    status = JSON.parse(await tailscale(binary, ["status", "--json"]));
  } catch (error) {
    return { ...emptyTailscaleState(), status: "logged-out", magicDnsName: knownName, error: readable(error) };
  }
  const self = (status as { Self?: unknown } | null)?.Self;
  const state: TailscaleState = {
    status: backendStatus((status as { BackendState?: unknown }).BackendState),
    magicDnsName: trimDnsName((self as { DNSName?: unknown } | null)?.DNSName) ?? knownName,
    certs: certDomains(status).length > 0,
    serving: false,
    error: null,
  };
  if (state.status !== "ready" || port === null) return state;
  try {
    const config: unknown = JSON.parse(await tailscale(binary, ["serve", "status", "--json"]) || "{}");
    return { ...state, serving: servesPort(config, port) };
  } catch {
    /** No serve config at all is what an unused Tailscale answers, and it is not an error to report. */
    return state;
  }
}

export type TailscaleAction = { ok: true } | { ok: false; message: string };

/** The one failure a user must go elsewhere to fix, so it names where rather than what went wrong. */
export const CERTS_OFF = "This tailnet does not issue HTTPS certificates yet. Turn on HTTPS in the Tailscale admin console, under DNS, then check again.";

/** Puts HTTPS on 443 in front of the local port. Tailscale holds this itself, across restarts of this app. */
export async function startTailscaleServe(port: number): Promise<TailscaleAction> {
  const binary = await findTailscale();
  if (!binary) return { ok: false, message: "Tailscale is not installed on this Mac." };
  const ready = await readTailscale(null);
  if (ready.status === "ready" && !ready.certs) return { ok: false, message: CERTS_OFF };
  try {
    await tailscale(binary, ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`], TAILSCALE_SERVE_TIMEOUT);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: readable(error) };
  }
}

export async function stopTailscaleServe(): Promise<TailscaleAction> {
  const binary = await findTailscale();
  if (!binary) return { ok: true };
  try {
    await tailscale(binary, ["serve", "--https=443", "off"]);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: readable(error) };
  }
}
