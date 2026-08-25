import { networkInterfaces } from "node:os";
import { addressOrigin, type MobileAddress } from "../../domain/mobile.js";

/** Tailscale's own interface hands out a 100.64/10 address, which is its tailnet rather than this LAN. */
function isTailnetAddress(address: string) {
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

/** Link-local addresses answer only to a neighbour that already knows the machine, so they are not offered. */
function isLinkLocal(address: string) {
  return address.startsWith("169.254.");
}

export function loopbackAddress(port: number): MobileAddress {
  return { kind: "loopback", host: "127.0.0.1", port };
}

/** Tailscale Serve terminates TLS on 443 and proxies to the local port, so the name is all a phone needs. */
export function tailscaleAddress(magicDnsName: string): MobileAddress {
  return { kind: "tailscale-https", host: magicDnsName, port: 443 };
}

type InterfaceRecord = Record<string, Array<{ family: string; address: string; internal: boolean }> | undefined>;

/** The IPv4 addresses of this machine's real network cards, in the order the platform lists them. */
export function lanAddressesFrom(interfaces: InterfaceRecord, port: number): MobileAddress[] {
  const found: MobileAddress[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (isTailnetAddress(entry.address) || isLinkLocal(entry.address)) continue;
      if (found.some((address) => address.host === entry.address)) continue;
      found.push({ kind: "lan", host: entry.address, port });
    }
  }
  return found;
}

export function lanAddresses(port: number): MobileAddress[] {
  return lanAddressesFrom(networkInterfaces() as InterfaceRecord, port);
}

/**
 * Every way a phone can reach the running server. Loopback is always there because it is always the
 * bind; the other two are only there when the user turned them on and the machine can offer them.
 */
export function reachableAddresses(options: { port: number; lanExposed: boolean; magicDnsName: string | null }): MobileAddress[] {
  const addresses: MobileAddress[] = [];
  if (options.magicDnsName) addresses.push(tailscaleAddress(options.magicDnsName));
  if (options.lanExposed) addresses.push(...lanAddresses(options.port));
  addresses.push(loopbackAddress(options.port));
  return addresses;
}

/**
 * The origins a page may call the bridge from: the ones the server itself hands the page out on.
 * `localhost` is spelled out beside the loopback address because a browser resolves it to both.
 */
export function allowedOrigins(addresses: MobileAddress[]): string[] {
  const origins = new Set<string>();
  for (const address of addresses) {
    origins.add(addressOrigin(address));
    if (address.kind === "loopback") origins.add(addressOrigin({ ...address, host: "localhost" }));
  }
  return [...origins];
}

/** Which address the server binds. Loopback unless the user opted into the whole network seeing it. */
export function bindHost(lanExposed: boolean): string {
  return lanExposed ? "0.0.0.0" : "127.0.0.1";
}
