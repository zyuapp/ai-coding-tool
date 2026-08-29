import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  isMobileClientMessage,
  MOBILE_PROTOCOL_VERSION,
  type MobileClientMessage,
  type MobileCommand,
  type MobileErrorCode,
  type MobilePairRequest,
  type MobileResumeRequest,
  type MobileServerMessage,
  type MobileView,
  type MobileViewUpdate,
} from "../../contracts/mobile.js";
import {
  MAX_PENDING_SOCKETS,
  MAX_SESSIONS_PER_DEVICE,
  MOBILE_APP_PATH,
  MOBILE_BUFFER_BYTES,
  MOBILE_DEAD_AFTER_MS,
  MOBILE_EVENT_BUFFER,
  MOBILE_PING_INTERVAL_MS,
  type MobileServerStatus,
  type MobileSession,
  type MobileSessionView,
} from "../../domain/mobile.js";
import type { PairingStore } from "./pairing.mjs";

/** Where the phone page talks back. Pairing happens on the same socket, as its first message. */
const SOCKET_PATH = `${MOBILE_APP_PATH}/socket`;

/** How long a socket that has said nothing is given to name itself before it is shown the door. */
const AUTH_DEADLINE_MS = 10_000;
/** How long a dropped session waits to be resumed before its buffer is thrown away. */
const SESSION_GRACE_MS = 5 * 60 * 1_000;
/** Bigger than the longest prompt a phone can hold, and still bounded. */
const MAX_SOCKET_MESSAGE = 2 * 1024 * 1024;
/** How many settled request IDs a device remembers. Comfortably more than a phone's own outbox holds. */
const MAX_HANDLED_REQUESTS = 256;
/** How many of a device's commands may be waiting on the window at once. */
const MAX_COMMANDS_IN_FLIGHT = 64;
/**
 * How long a hung-up socket is given to answer the close handshake. A client that never answers
 * would otherwise keep delivering messages for `ws`'s own half-minute, so it is cut instead.
 */
const CLOSE_GRACE_MS = 250;

/** What the build is called when the page cannot be read. Every phone agrees on it, so none reloads. */
const UNKNOWN_BUILD = "unknown";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * The phone page is only ever the top-level document. Framed, its approval buttons could be
 * overlaid and a tap on Allow stolen, so nothing may frame it.
 */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

/** How a command ended, kept so a resend is answered rather than run a second time. */
type AckOutcome = { ok: true } | { ok: false; message: string };

/** One outbound message, kept as the text it was sent as so replaying it costs nothing. */
type Buffered = { sequence: number; text: string };

type Session = MobileSession & {
  deviceName: string;
  socket: WebSocket | null;
  /** Recent outbound messages, newest last, so a phone that dropped is given only what it missed. */
  buffer: Buffered[];
  /** What {@link buffer} costs, so a long run's patches cannot grow it without bound. */
  bufferBytes: number;
  /**
   * Whether this session's first snapshot is still being fetched. Patches sent before it lands
   * describe a view the phone has never seen and are numbered below what it is still counting from.
   */
  awaitingSnapshot: boolean;
  /** When an offline session stops being worth keeping. Null while a socket is attached. */
  expiresAt: number | null;
};

/** Every server message but the sequence the session stamps on it as it goes out. */
type Unsequenced<T> = T extends unknown ? Omit<T, "sequence"> : never;
type OutboundMessage = Unsequenced<MobileServerMessage>;

export type MobileServerOptions = {
  devices: PairingStore;
  /** The built phone page. Served under {@link MOBILE_APP_PATH}. */
  staticRoot: string;
  port: number;
  /** The origins a page may call from, which move as Tailscale and the LAN bind come and go. */
  allowedOrigins: () => string[];
  snapshot: (sessionId: string) => Promise<MobileView>;
  command: (sessionId: string, command: MobileCommand) => Promise<void>;
  /** Something a phone did changed what settings should say. */
  onChange: () => void;
  /** How long a dropped session is held for its phone. A test shortens it rather than wait five minutes. */
  sessionGraceMs?: number;
};

/**
 * The local server a phone reaches. It serves the phone page, trades pairing codes for tokens, and
 * holds one socket per phone. Nothing here decides anything about the workspace: a command is
 * relayed to the window and acknowledged with what the window said.
 *
 * Sessions outlive their sockets. Every message a session sends is numbered and kept, so a phone
 * that loses the line resumes by naming the last number it saw and is handed the rest, and a phone
 * that fell further behind than the buffer reaches pays for a fresh snapshot instead. What a phone
 * has already run is remembered against its device rather than its session, so falling that far
 * behind still does not run a resent command twice.
 */
export class MobileServer {
  private readonly sessions = new Map<string, Session>();
  /** Per device: every request ID it has sent, and what came of it. Null while one is in flight. */
  private readonly handled = new Map<string, Map<string, AckOutcome | null>>();
  private http: Server | null = null;
  private sockets: WebSocketServer | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private listening: number | null = null;
  /** What the served page hashes to, read once a server starts because a running one cannot change it. */
  private build = UNKNOWN_BUILD;
  private failure: string | null = null;
  /** Sockets that have connected but not yet said who they are. */
  private pending = 0;

  constructor(private readonly options: MobileServerOptions) {}

  get port(): number | null {
    return this.listening;
  }

  get status(): MobileServerStatus {
    if (this.failure) return "error";
    return this.listening === null ? "off" : "listening";
  }

  get error(): string | null {
    return this.failure;
  }

  sessionViews(): MobileSessionView[] {
    return [...this.sessions.values()].map(({ id, deviceId, deviceName, startedAt, lastSeenAt, sequence, connection }) =>
      ({ id, deviceId, deviceName, startedAt, lastSeenAt, sequence, connection }));
  }

  async start(host: string): Promise<void> {
    if (this.http) return;
    this.failure = null;
    this.build = buildStamp(this.options.staticRoot);
    const server = createServer((request, response) => {
      this.serve(request, response).catch(() => {
        if (!response.headersSent) plain(response, 500, "Something went wrong.");
        response.end();
      });
    });
    server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    this.http = server;
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_SOCKET_MESSAGE });
    try {
      this.listening = await listen(server, host, this.options.port);
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      await this.stop();
      throw error;
    }
    this.heartbeat = setInterval(() => this.tick(), MOBILE_PING_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const session of this.sessions.values()) hangUp(session.socket, 1001, "The bridge was turned off.");
    this.sessions.clear();
    this.handled.clear();
    for (const socket of this.sockets?.clients ?? []) hangUp(socket, 1001, "The bridge was turned off.");
    this.sockets?.close();
    this.sockets = null;
    const server = this.http;
    this.http = null;
    this.listening = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** What every phone should see now. Offline sessions are numbered too, so a resume replays them. */
  publish(update: MobileViewUpdate) {
    for (const session of this.sessions.values()) {
      if (session.awaitingSnapshot) continue;
      this.emit(session, update.kind === "snapshot" ? { kind: "snapshot", sessionId: session.id, build: this.build, view: update.view } : { kind: "patch", patch: update.patch });
    }
  }

  /** A revoked phone loses its session with its token, mid-conversation if that is where it is. */
  dropDevice(deviceId: string) {
    for (const session of [...this.sessions.values()]) {
      if (session.deviceId !== deviceId) continue;
      this.forget(session);
      hangUp(session.socket, 4003, "This phone was unpaired.");
    }
    this.handled.delete(deviceId);
  }

  /**
   * A session the server no longer holds, whose socket may still be delivering messages. What its
   * device has already run is kept: a phone that sleeps past the session's grace wakes with the same
   * outbox, and would otherwise run every command whose acknowledgement it never read a second time.
   */
  private forget(session: Session) {
    this.sessions.delete(session.id);
  }

  private emit(session: Session, message: OutboundMessage) {
    session.sequence += 1;
    const text = JSON.stringify({ ...message, sequence: session.sequence });
    session.buffer.push({ sequence: session.sequence, text });
    session.bufferBytes += text.length;
    while (session.buffer.length > MOBILE_EVENT_BUFFER || (session.bufferBytes > MOBILE_BUFFER_BYTES && session.buffer.length > 1)) {
      const dropped = session.buffer.shift();
      if (!dropped) break;
      session.bufferBytes -= dropped.text.length;
    }
    write(session.socket, text);
  }

  private openSession(deviceId: string, deviceName: string, at: number): Session {
    const session: Session = {
      id: randomUUID(),
      deviceId,
      deviceName,
      startedAt: at,
      lastSeenAt: at,
      sequence: 0,
      connection: "live",
      socket: null,
      buffer: [],
      bufferBytes: 0,
      awaitingSnapshot: true,
      expiresAt: null,
    };
    this.sessions.set(session.id, session);
    if (!this.handled.has(deviceId)) this.handled.set(deviceId, new Map());
    const held = [...this.sessions.values()].filter((entry) => entry.deviceId === deviceId);
    for (const stale of held.slice(0, Math.max(0, held.length - MAX_SESSIONS_PER_DEVICE))) {
      this.forget(stale);
      hangUp(stale.socket, 4002, "This phone connected again.");
    }
    return session;
  }

  /** One socket per session: a phone that opens a second one takes the session, and the first is closed. */
  private attach(session: Session, socket: WebSocket) {
    if (session.socket && session.socket !== socket) hangUp(session.socket, 4002, "This phone connected again.");
    session.socket = socket;
    session.connection = "live";
    session.expiresAt = null;
    session.lastSeenAt = Date.now();
    socket.on("close", () => {
      if (session.socket !== socket) return;
      session.socket = null;
      session.connection = "offline";
      session.expiresAt = Date.now() + (this.options.sessionGraceMs ?? SESSION_GRACE_MS);
      this.options.onChange();
    });
  }

  private async sendSnapshot(session: Session) {
    try {
      const view = await this.options.snapshot(session.id);
      session.awaitingSnapshot = false;
      this.emit(session, { kind: "snapshot", sessionId: session.id, build: this.build, view });
    } catch (error) {
      /**
       * A session with no view to patch is no session. The phone hears why, is hung up on, and
       * redials on its backoff into a fresh session that asks for the view again.
       */
      const message = error instanceof Error ? error.message : String(error);
      this.emit(session, { kind: "error", code: "internal", message });
      this.forget(session);
      hangUp(session.socket, 1011, message);
      this.options.onChange();
    }
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const sockets = this.sockets;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!sockets || url.pathname !== SOCKET_PATH) return refuseUpgrade(socket, "400 Bad Request");
    if (!this.originAllowed(request)) return refuseUpgrade(socket, "403 Forbidden");
    if (this.pending >= MAX_PENDING_SOCKETS) return refuseUpgrade(socket, "503 Service Unavailable");
    sockets.handleUpgrade(request, socket, head, (accepted) => this.accept(accepted, sourceOf(request)));
  }

  /**
   * A page the server itself handed out is the only page allowed to talk back. A request with no
   * origin at all is not one a browser made, and is left to the token to judge.
   */
  private originAllowed(request: IncomingMessage) {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (this.options.allowedOrigins().includes(origin)) return true;
    /**
     * A page from the very host the socket was opened on is our own page, whatever the host is
     * called: a browser cannot forge the Host header, and Tailscale Serve passes the name and scheme
     * it answered on. This is what lets a tailnet phone back in before Tailscale has been asked.
     */
    const host = forwardedHost(request);
    const scheme = forwardedScheme(request);
    return host !== null && origin === `${scheme}://${host}`;
  }

  private accept(socket: WebSocket, source: string) {
    let session: Session | null = null;
    this.pending += 1;
    const named = () => {
      if (this.pending > 0) this.pending -= 1;
      clearTimeout(deadline);
    };
    const deadline = setTimeout(() => { if (!session) hangUp(socket, 4008, "This phone never said who it was."); }, AUTH_DEADLINE_MS);
    deadline.unref?.();
    socket.on("close", () => { if (!session) named(); else clearTimeout(deadline); });
    socket.on("error", () => socket.terminate());
    socket.on("message", (data) => {
      const message = readClientMessage(data);
      if (!message) return refuse(socket, "unreadable", "That message could not be read.");
      if (session) {
        /** A session dropped while its socket lingers — revoked, or the bridge turned off — is over. */
        if (this.sessions.get(session.id) !== session) return;
        session.lastSeenAt = Date.now();
        return this.onSessionMessage(session, message);
      }
      const opened = message.kind === "pair" ? this.onPair(socket, message, source)
        : message.kind === "resume" ? this.onResume(socket, message)
          : null;
      if (!opened) return;
      named();
      session = opened;
      this.options.onChange();
    });
  }

  /**
   * A phone re-sends a command whose ack it never saw, so a request ID its device has already run is
   * answered from what it decided the first time and never reaches the window twice. The memory is
   * the device's rather than the session's, because a phone that falls past the buffer resumes into
   * a fresh session with the same outbox.
   */
  private onSessionMessage(session: Session, message: MobileClientMessage) {
    if (message.kind !== "command") return;
    const { requestId } = message;
    const handled = this.handled.get(session.deviceId);
    if (!handled) return;
    if (handled.has(requestId)) {
      const settled = handled.get(requestId);
      if (settled) this.ack(session, requestId, settled);
      return;
    }
    const inFlight = [...handled.values()].filter((outcome) => outcome === null).length;
    if (inFlight >= MAX_COMMANDS_IN_FLIGHT) {
      return this.ack(session, requestId, { ok: false, message: "This phone has too many commands still waiting on the computer." });
    }
    handled.set(requestId, null);
    this.trim(handled);
    this.options.command(session.id, message.command).then(
      () => this.settle(session, requestId, { ok: true }),
      (error: unknown) => this.settle(session, requestId, { ok: false, message: error instanceof Error ? error.message : String(error) }),
    );
  }

  /** Only a settled request may be forgotten: forgetting one in flight would let a resend run it twice. */
  private trim(handled: Map<string, AckOutcome | null>) {
    for (const [requestId, outcome] of handled) {
      if (handled.size <= MAX_HANDLED_REQUESTS) return;
      if (outcome !== null) handled.delete(requestId);
    }
  }

  private settle(session: Session, requestId: string, outcome: AckOutcome) {
    const handled = this.handled.get(session.deviceId);
    if (handled?.has(requestId)) handled.set(requestId, outcome);
    this.ack(session, requestId, outcome);
  }

  private ack(session: Session, requestId: string, outcome: AckOutcome) {
    this.emit(session, outcome.ok ? { kind: "ack", requestId, ok: true } : { kind: "ack", requestId, ok: false, message: outcome.message });
  }

  private onPair(socket: WebSocket, request: MobilePairRequest, source: string): Session | null {
    if (request.version !== MOBILE_PROTOCOL_VERSION) {
      refuse(socket, "version", "This phone page is a different version from the computer. Reload it.");
      return null;
    }
    /** A code buys a device, so it is not spent on a socket that has already gone. */
    if (socket.readyState !== socket.OPEN) return null;
    const outcome = this.options.devices.redeem(request.code, request.deviceName, source, Date.now());
    if (!outcome.ok) {
      refuse(socket, outcome.code, outcome.message);
      return null;
    }
    const session = this.openSession(outcome.device.id, outcome.device.name, Date.now());
    this.attach(session, socket);
    this.emit(session, { kind: "paired", deviceId: outcome.device.id, deviceName: outcome.device.name, token: outcome.token });
    /** A token nobody received is a device that will never connect, so it is taken back. */
    if (socket.readyState !== socket.OPEN) {
      this.forget(session);
      this.options.devices.revoke(outcome.device.id);
      return null;
    }
    void this.sendSnapshot(session);
    return session;
  }

  /**
   * Device tokens are 256 bits, so guessing one is not a threat worth rate-limiting — and counting
   * unknown tokens against the pairing bucket would let any peer that can reach the port lock the
   * real phone out, since a reverse proxy makes every phone the same source address.
   */
  private onResume(socket: WebSocket, request: MobileResumeRequest): Session | null {
    if (request.version !== MOBILE_PROTOCOL_VERSION) {
      refuse(socket, "version", "This phone page is a different version from the computer. Reload it.");
      return null;
    }
    const now = Date.now();
    const device = this.options.devices.authenticate(request.token);
    if (!device) {
      refuse(socket, "unauthorized", "This phone is not paired with this computer.");
      return null;
    }
    this.options.devices.markSeen(device.id, now);
    const held = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
    if (held && held.deviceId === device.id && resumable(held, request.lastSequence)) {
      this.attach(held, socket);
      for (const entry of held.buffer) if (entry.sequence > request.lastSequence) write(socket, entry.text);
      /** A phone with nothing to catch up on is still owed a frame, or it waits for the next tick to call itself live. */
      this.emit(held, { kind: "ping", at: now });
      return held;
    }
    const session = this.openSession(device.id, device.name, now);
    this.attach(session, socket);
    void this.sendSnapshot(session);
    return session;
  }

  /** Pings what is connected, hangs up on what has gone quiet, and forgets what will not come back. */
  private tick() {
    const now = Date.now();
    let moved = false;
    for (const session of [...this.sessions.values()]) {
      if (session.socket) {
        if (now - session.lastSeenAt > MOBILE_DEAD_AFTER_MS) {
          session.socket.terminate();
          continue;
        }
        this.emit(session, { kind: "ping", at: now });
        continue;
      }
      if (session.expiresAt !== null && now >= session.expiresAt) {
        this.forget(session);
        moved = true;
      }
    }
    if (moved) this.options.onChange();
  }

  private async serve(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET") return plain(response, 405, "Method not allowed");
    /** The socket path is only ever an upgrade; a plain GET on it is not the page. */
    if (url.pathname === SOCKET_PATH) return plain(response, 400, "This address is a WebSocket.");
    if (url.pathname === "/" || url.pathname === MOBILE_APP_PATH) {
      response.writeHead(302, { location: `${MOBILE_APP_PATH}/${url.search}`, ...SECURITY_HEADERS });
      return response.end();
    }
    await this.serveFile(response, url.pathname);
  }

  /**
   * The phone page and its assets. A build that names its assets from the root and one that names
   * them under the app path both resolve, and neither can name anything outside the built folder.
   */
  private async serveFile(response: ServerResponse, pathname: string) {
    const root = path.resolve(this.options.staticRoot);
    const within = pathname.startsWith(`${MOBILE_APP_PATH}/`) ? pathname.slice(MOBILE_APP_PATH.length) : pathname;
    const named = readPath(within);
    if (named === null) return plain(response, 404, "Not found");
    const candidates = [path.resolve(root, `.${named}`)];
    /** Anything without an extension is a route the page draws itself, so the page is what it gets. */
    if (!path.extname(within)) candidates.push(path.join(root, "index.html"));
    for (const candidate of candidates) {
      if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) continue;
      const entry = await stat(candidate).catch(() => null);
      if (!entry?.isFile()) continue;
      response.writeHead(200, {
        "content-type": MIME_TYPES[path.extname(candidate).toLowerCase()] ?? "application/octet-stream",
        "content-length": entry.size,
        "cache-control": path.extname(candidate) === ".html" ? "no-store" : "public, max-age=3600",
        ...SECURITY_HEADERS,
      });
      createReadStream(candidate).pipe(response);
      return;
    }
    plain(response, 404, "Not found");
  }
}

/**
 * The build of the page this server hands out, which is what a phone compares its own against. A
 * page it cannot read is one no phone can be holding, so nothing is asked to reload over it.
 */
function buildStamp(staticRoot: string): string {
  try {
    return createHash("sha256").update(readFileSync(path.join(staticRoot, "index.html"))).digest("hex").slice(0, 16);
  } catch {
    return UNKNOWN_BUILD;
  }
}

/** Whether the buffer still reaches back to what the phone says it saw. */
function resumable(session: Session, lastSequence: number) {
  if (lastSequence > session.sequence) return false;
  if (lastSequence === session.sequence) return true;
  const oldest = session.buffer[0];
  return oldest !== undefined && oldest.sequence <= lastSequence + 1;
}

/** A path a browser escaped, or null when it is not one this server could have handed out. */
function readPath(pathname: string) {
  try {
    const decoded = decodeURIComponent(pathname);
    return decoded.includes("\0") ? null : decoded;
  } catch {
    return null;
  }
}

function write(socket: WebSocket | null, text: string) {
  if (socket && socket.readyState === socket.OPEN) socket.send(text);
}

/**
 * Hangs up, and makes sure the hanging up finishes. A close is a handshake a client is free to
 * ignore, and one that does keeps delivering messages until `ws` gives up on it, so the socket is
 * cut shortly after rather than left to a peer's good manners.
 */
function hangUp(socket: WebSocket | null, code: number, reason: string) {
  if (!socket) return;
  socket.close(code, reason);
  const timer = setTimeout(() => socket.terminate(), CLOSE_GRACE_MS);
  timer.unref?.();
}

/** A refusal is the last thing a socket hears: it carries no session, so it is numbered zero. */
function refuse(socket: WebSocket, code: MobileErrorCode, message: string) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ kind: "error", sequence: 0, code, message }));
  hangUp(socket, 4001, code);
}

function refuseUpgrade(socket: Duplex, status: string) {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function readClientMessage(data: unknown): MobileClientMessage | null {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : String(data);
  const parsed = parseJson(text);
  return isMobileClientMessage(parsed) ? parsed : null;
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
function sourceOf(request: IncomingMessage) {
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
function forwardedHost(request: IncomingMessage): string | null {
  if (!isLoopback(request.socket.remoteAddress ?? "")) return header(request, "host");
  return header(request, "x-forwarded-host") ?? header(request, "host");
}

function forwardedScheme(request: IncomingMessage): string {
  if (!isLoopback(request.socket.remoteAddress ?? "")) return "http";
  return header(request, "x-forwarded-proto") === "https" ? "https" : "http";
}

function plain(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS });
  response.end(text);
}

/** The asked-for port, or whatever the machine offers when something else already holds it. */
function listen(server: Server, host: string, port: number): Promise<number> {
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
