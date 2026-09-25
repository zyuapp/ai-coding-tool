import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiscoveredComputer } from "../../domain/computers.js";
import { MOBILE_HEALTH_PATH, MOBILE_HEALTH_RESPONSE } from "../mobile/addresses.mjs";
import { findTailscale, parseTailscaleJson } from "../mobile/tailscale.mjs";

const run = promisify(execFile);
const STATUS_TIMEOUT = 10_000;
/** A probe crosses the tailnet once; a peer that takes longer than this is not serving. */
const PROBE_TIMEOUT = 3_000;

/** Whether a peer answers as this app's own bridge. */
export async function servesApp(host: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`https://${host}${MOBILE_HEALTH_PATH}`, { cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT) });
    return response.ok && await response.text() === MOBILE_HEALTH_RESPONSE;
  } catch {
    return false;
  }
}

type Peer = { host: string; name: string; os: string; online: boolean };

function peersOf(status: unknown): Peer[] {
  const peers = (status as { Peer?: Record<string, unknown> } | null)?.Peer;
  if (!peers || typeof peers !== "object") return [];
  return Object.values(peers).flatMap((peer) => {
    const record = peer as Record<string, unknown>;
    const host = typeof record.DNSName === "string" ? record.DNSName.replace(/\.$/, "") : "";
    if (!host) return [];
    return [{ host, name: typeof record.HostName === "string" && record.HostName ? record.HostName : host, os: typeof record.OS === "string" ? record.OS : "", online: record.Online === true }];
  });
}

/**
 * The computers on this tailnet running this app: every peer Tailscale says is online, asked in
 * parallel whether it serves the bridge. A peer that is not, or is off, is not offered.
 */
export async function discoverComputers(options: { probe?: (host: string) => Promise<boolean> } = {}): Promise<DiscoveredComputer[]> {
  const binary = await findTailscale();
  if (!binary) throw new Error("Tailscale is not installed on this computer.");
  const { stdout } = await run(binary, ["status", "--json"], { timeout: STATUS_TIMEOUT, maxBuffer: 4 * 1024 * 1024 });
  const status = parseTailscaleJson(stdout);
  const probe = options.probe ?? servesApp;
  const online = peersOf(status).filter((peer) => peer.online);
  const serving = await Promise.all(online.map(async (peer) => (await probe(peer.host)) ? peer : null));
  return serving.flatMap((peer) => peer ? [{ host: peer.host, name: peer.name, os: peer.os }] : []).sort((left, right) => left.name.localeCompare(right.name));
}
