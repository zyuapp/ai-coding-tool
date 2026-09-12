import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { applyWorkspacePatches } from "../../application/workspace-patches.js";
import { parseWorkspaceJson, stringifyWorkspaceJson } from "../../application/workspace-json.js";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../application/workspace-reducer.js";
import type { WorkspaceState } from "../../application/workspace-state.js";
import { COMPUTER_PROTOCOL_VERSION, isComputerServerMessage, type ComputerClientMessage, type ComputerQuery, type ComputerServerMessage } from "../../contracts/computers.js";
import type { ComputerStatus } from "../../domain/computers.js";
import { MOBILE_DEAD_AFTER_MS } from "../../domain/mobile.js";
import { WORKSPACE_SOCKET_PATH } from "../mobile/mobile-server.mjs";

/** How long a dial may sit unanswered before the next try. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long each failed dial waits before the next, growing to a pause and no further. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** How long a request may wait on the other computer. Its runs are its own; only the answer is waited for. */
const REQUEST_TIMEOUT_MS = 30_000;

export const COMPUTER_OFFLINE = "That computer cannot be reached right now.";

/** The socket a host is dialled on: the tailnet name over TLS, or a plain socket to this machine's own loopback. */
export function computerSocketUrl(host: string): string {
  const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host);
  return `${loopback ? "ws" : "wss"}://${host}${WORKSPACE_SOCKET_PATH}`;
}

export type ComputerCredential = { token: string } | { code: string };

export type ComputerClientOptions = {
  host: string;
  /** What this computer calls itself, which is how the other lists it. */
  deviceName: string;
  credential: ComputerCredential;
  /** The socket to dial. The tailnet name over TLS unless a test says otherwise. */
  url?: string;
  onStatus: (status: ComputerStatus, error: string | null) => void;
  /** The token the other computer handed out, which is all that gets this one back in. */
  onPaired: (deviceId: string, deviceName: string, token: string) => void;
  onState: (state: WorkspaceState) => void;
};

type Waiting<T> = { resolve: (value: T) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Every request still waiting is refused: the line it was asked on is gone, and its answer with it. */
function refuseWaiting(held: Map<string, Waiting<never>>, message: string) {
  for (const [id, waiting] of [...held]) {
    held.delete(id);
    clearTimeout(waiting.timer);
    waiting.reject(new Error(message));
  }
}

/** One dial, with what to do as it opens, speaks, and closes. */
function dial(url: string, handlers: { open: () => void; message: (message: ComputerServerMessage) => void; close: (code: number, reason: string) => void }) {
  const socket = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
  socket.on("open", handlers.open);
  socket.on("message", (data) => {
    const message = readServerMessage(data);
    if (message) handlers.message(message);
  });
  socket.on("error", () => { /* The close that follows says what is needed. */ });
  socket.on("close", (code, reason) => handlers.close(code, reason.toString()));
  return socket;
}

function readServerMessage(data: unknown): ComputerServerMessage | null {
  try {
    const parsed = parseWorkspaceJson(Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : String(data));
    return isComputerServerMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One line to a paired computer. It dials, pairs or resumes, mirrors the other computer's state as
 * it arrives, and carries inputs there. A dropped line is dialled again on a growing pause; a line
 * the other computer refuses outright, as unpaired or another version, is left down with the reason.
 */
export function createComputerClient(options: ComputerClientOptions) {
  let socket: WebSocket | null = null;
  let credential = options.credential;
  let sessionId: string | undefined;
  let lastSequence = 0;
  let revision = -1;
  let replica: WorkspaceState | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let status: ComputerStatus = "connecting";
  const results = new Map<string, Waiting<WorkspaceCommandResult>>();
  const answers = new Map<string, Waiting<unknown>>();
  const url = options.url ?? computerSocketUrl(options.host);

  function report(next: ComputerStatus, error: string | null = null) {
    status = next;
    options.onStatus(next, error);
  }

  function write(message: ComputerClientMessage) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(stringifyWorkspaceJson(message));
  }

  function watch() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => socket?.terminate(), MOBILE_DEAD_AFTER_MS);
    watchdog.unref?.();
  }

  function refuseAll(message: string) {
    refuseWaiting(results as Map<string, Waiting<never>>, message);
    refuseWaiting(answers as Map<string, Waiting<never>>, message);
  }

  function schedule() {
    if (stopped || retry) return;
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
    attempt += 1;
    retry = setTimeout(() => { retry = null; open(); }, delay);
    retry.unref?.();
  }

  /** A line the other computer will not have back is left down; every other drop is dialled again. */
  function dropped(error: string | null, fatal = false) {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    const closing = socket;
    socket = null;
    refuseAll(error ?? COMPUTER_OFFLINE);
    closing?.terminate();
    if (stopped) return;
    report("offline", error);
    if (fatal) stopped = true;
    else schedule();
  }

  function receive(message: ComputerServerMessage) {
    lastSequence = message.sequence;
    watch();
    if (message.kind === "paired") {
      credential = { token: message.token };
      options.onPaired(message.deviceId, message.deviceName, message.token);
    } else if (message.kind === "workspace") {
      if (message.sessionId) sessionId = message.sessionId;
      const { update } = message;
      if ("state" in update) {
        replica = update.state;
      } else if (replica && update.revision === revision + 1) {
        try {
          replica = applyWorkspacePatches(replica, update.patches);
        } catch {
          sessionId = undefined;
          socket?.terminate();
          return;
        }
      } else if (update.revision <= revision) {
        return;
      } else {
        /** A difference from a state this side never saw: start over on a fresh session. */
        sessionId = undefined;
        socket?.terminate();
        return;
      }
      revision = update.revision;
      attempt = 0;
      if (status !== "connected") report("connected");
      options.onState(replica);
    } else if (message.kind === "result") {
      const waiting = results.get(message.requestId);
      if (!waiting) return;
      results.delete(message.requestId);
      clearTimeout(waiting.timer);
      waiting.resolve(message.result);
    } else if (message.kind === "answer") {
      const waiting = answers.get(message.requestId);
      if (!waiting) return;
      answers.delete(message.requestId);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(message.message));
    } else if (message.kind === "error") {
      const fatal = message.code === "unauthorized" || message.code === "version" || message.code === "expired-code" || message.code === "rate-limited";
      dropped(message.message, fatal);
    } else if (message.kind === "ping") {
      write({ kind: "pong", at: message.at });
    }
  }

  function open() {
    if (stopped || socket) return;
    report("connecting", null);
    const dialled: WebSocket = dial(url, {
      open: () => {
        if (socket !== dialled) return;
        watch();
        if ("token" in credential) write({ kind: "resume", version: COMPUTER_PROTOCOL_VERSION, token: credential.token, ...(sessionId ? { sessionId } : {}), lastSequence });
        else write({ kind: "pair", version: COMPUTER_PROTOCOL_VERSION, code: credential.code, deviceName: options.deviceName });
      },
      message: (message) => { if (socket === dialled) receive(message); },
      close: (code, said) => { if (socket === dialled) dropped(code === 1000 || !said || said === "unauthorized" ? null : said); },
    });
    socket = dialled;
  }

  function ask<T>(held: Map<string, Waiting<T>>, message: ComputerClientMessage & { requestId: string }): Promise<T> {
    if (socket?.readyState !== WebSocket.OPEN || status !== "connected") return Promise.reject(new Error(COMPUTER_OFFLINE));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        held.delete(message.requestId);
        reject(new Error("That computer did not answer in time."));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      held.set(message.requestId, { resolve, reject, timer });
      write(message);
    });
  }

  open();
  return {
    get status() { return status; },
    get state() { return replica; },
    send: (inputs: WorkspaceInput[]) => ask(results, { kind: "input", requestId: randomUUID(), inputs }),
    query: (query: ComputerQuery) => ask(answers, { kind: "query", requestId: randomUUID(), query }),
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      const closing = socket;
      socket = null;
      refuseAll(COMPUTER_OFFLINE);
      closing?.close(1000, "stopped");
    },
  };
}

export type ComputerClient = ReturnType<typeof createComputerClient>;
