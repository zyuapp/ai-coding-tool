import type { IncomingMessage, Server } from "node:http";
import type { WebSocket } from "ws";
import { isMobileClientMessage, type MobileClientMessage } from "../../contracts/mobile.js";
import { isComputerClientMessage, type ComputerClientMessage } from "../../contracts/computers.js";
import type { PairedDeviceKind } from "../../domain/mobile.js";

/**
 * How the bridge's server reads what arrives: frames into messages, the requests a guard turned
 * away into the IDs they can be refused under, and an HTTP request into who sent it from where.
 */

export type ClientMessage = MobileClientMessage | ComputerClientMessage;

export function readClientMessage(data: unknown, kind: PairedDeviceKind): ClientMessage | null {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : String(data);
  const parsed = parseJson(text);
  if (kind === "computer") return isComputerClientMessage(parsed) ? parsed : null;
  return isMobileClientMessage(parsed) ? parsed : null;
}

/** A paired phone's command or read the guard turned away, by the ID it can be answered under. */
export function rejectedPhoneRequest(data: WebSocket.RawData): { kind: "command" | "query"; requestId: string } | null {
  try {
    const value = JSON.parse(data.toString()) as Record<string, unknown> | null;
    if (!value || (value.kind !== "command" && value.kind !== "query") || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 256) return null;
    return { kind: value.kind, requestId: value.requestId };
  } catch { return null; }
}

/** Only an authenticated socket gets a correlated refusal; no rejected payload reaches the reducer. */
export function rejectedComputerRequest(data: WebSocket.RawData): { kind: "input" | "query"; requestId: string } | null {
  try {
    const value = JSON.parse(data.toString()) as Record<string, unknown> | null;
    if (!value || (value.kind !== "input" && value.kind !== "query") || typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 256) return null;
    return { kind: value.kind, requestId: value.requestId };
  } catch { return null; }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * Only ever used to count wrong pairing codes against one caller. Tailscale Serve proxies from the
 * loopback and names the real peer in the forwarded header, which is trusted only from the loopback:
 * without it every phone on the tailnet would be one bucket, and one stale QR would lock them all out.
 */
export function sourceOf(request: IncomingMessage) {
  const remote = request.socket.remoteAddress ?? "unknown";
  if (!isLoopback(remote)) return remote;
  const forwarded = header(request, "x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || remote;
}

function isLoopback(address: string) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text?.trim() || null;
}

/** The host the page was served on, as the proxy in front of us saw it, else as this server did. */
export function forwardedHost(request: IncomingMessage): string | null {
  if (!isLoopback(request.socket.remoteAddress ?? "")) return header(request, "host");
  return header(request, "x-forwarded-host") ?? header(request, "host");
}

export function forwardedScheme(request: IncomingMessage): string {
  if (!isLoopback(request.socket.remoteAddress ?? "")) return "http";
  return header(request, "x-forwarded-proto") === "https" ? "https" : "http";
}

/** The asked-for port, or whatever the machine offers when something else already holds it. */
export function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let retried = false;
    const done = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && port !== 0 && !retried) {
        retried = true;
        server.listen(0, host);
        return;
      }
      done();
      reject(error);
    };
    const onListening = () => {
      done();
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    };
    server.on("error", onError);
    server.on("listening", onListening);
    server.listen(port, host);
  });
}
