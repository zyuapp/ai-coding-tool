import { addressOrigin, type MobileAddress } from "../../domain/mobile.js";

/** The server binds only here: a phone reaches it through Tailscale Serve, never over the LAN. */
export const BIND_HOST = "127.0.0.1";

export function loopbackAddress(port: number): MobileAddress {
  return { kind: "loopback", host: BIND_HOST, port };
}

/** Tailscale Serve terminates TLS on 443 and proxies to the local port, so the name is all a phone needs. */
export function tailscaleAddress(magicDnsName: string): MobileAddress {
  return { kind: "tailscale-https", host: magicDnsName, port: 443 };
}

/**
 * Every way a phone can reach the running server. Loopback is always there because it is the bind;
 * the tailnet name is there only while Tailscale is serving it.
 */
export function reachableAddresses(options: { port: number; magicDnsName: string | null }): MobileAddress[] {
  const addresses: MobileAddress[] = [];
  if (options.magicDnsName) addresses.push(tailscaleAddress(options.magicDnsName));
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
