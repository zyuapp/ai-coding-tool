import { COMPUTER_CAPABILITIES, REMOTE_UNSUPPORTED, supportsComputerCommand, supportsComputerQuery, type ComputerCapabilities } from "../../contracts/computer-capabilities.js";
import { isAppCommandType, isWorkspaceViewInput } from "../../contracts/workspace-view-input.js";
import type { AppCommand } from "../../contracts/commands.js";
import { createRemoteWorkspaceReplica } from "../../application/remote-workspace.js";
import { MAX_ATTACHMENT_ENCODED_BYTES } from "../../domain/conversation.js";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { parseWorkspaceJson, stringifyWorkspaceJson } from "../../application/workspace-json.js";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../application/workspace-reducer.js";
import type { WorkspaceState } from "../../application/workspace-state.js";
import type { ThreadNotice } from "../../contracts/ipc.js";
import { COMPUTER_PROTOCOL_VERSION, COMPUTER_TRANSFER_TIMEOUT_MS, COMPUTER_SEND_TOO_LARGE, MAX_COMPUTER_MESSAGE_BYTES, isComputerTransfer, isComputerServerMessage, type ComputerClientMessage, type ComputerQuery, type ComputerServerMessage } from "../../contracts/computers.js";
import { MOBILE_DEAD_AFTER_MS, MOBILE_PING_INTERVAL_MS } from "../../domain/mobile.js";
import type { ComputerStatus } from "../../domain/computers.js";
import { WORKSPACE_SOCKET_PATH } from "../mobile/mobile-server.mjs";

/** How long a dial may sit unanswered before the next try. */
const CONNECT_TIMEOUT_MS = 10_000;
/** How long each failed dial waits before the next, growing to a pause and no further. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 15_000];
/** How long a line the other computer refused waits before asking again, in case what it said has since changed. */
const REFUSED_RETRY_MS = 5 * 60_000;
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
  onCapabilities?: (capabilities: ComputerCapabilities) => void;
  /** A notice that computer raised for this one to put on its desktop. */
  onNotice?: (notice: ThreadNotice) => void;
  /** What that computer calls itself, as the line opens and whenever it changes. */
  onName?: (name: string) => void;
};

/** A request still owed an answer, kept as it was sent so a line that comes back can carry it again. */
type Waiting<T> = { resolve: (value: T) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; requestId: string; payload: string; transferring: boolean };

/** Every request still waiting is refused: the line it was asked on is gone, and its answer with it. */
function refuseWaiting(held: Map<string, Waiting<never>>, message: string) {
  for (const [id, waiting] of [...held]) {
    held.delete(id);
    clearTimeout(waiting.timer);
    waiting.reject(new Error(message));
  }
}

/** The one waiting on an answer, taken off the list as it is answered. */
function claim<T>(held: Map<string, Waiting<T>>, requestId: string): Waiting<T> | null {
  const waiting = held.get(requestId);
  if (!waiting) return null;
  held.delete(requestId);
  clearTimeout(waiting.timer);
  return waiting;
}

/**
 * The server pings every so often, so a line nothing has arrived on for a while is dead even when
 * the network never said so. Bytes on their way count, so a long answer is not mistaken for silence.
 */
function createWatchdog(dead: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heardAt = Date.now();
  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (Date.now() - heardAt >= MOBILE_DEAD_AFTER_MS) dead();
      else arm();
    }, Math.max(0, heardAt + MOBILE_DEAD_AFTER_MS - Date.now()));
    timer.unref?.();
  }
  return {
    get heardAt() { return heardAt; },
    heard() { heardAt = Date.now(); },
    /** Watches a line that has just opened, counting from now. */
    start() { heardAt = Date.now(); arm(); },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * What a line still owes: each request kept as it was sent, settled by its answer or its own
 * deadline, and handed back whole to be carried again when a dropped line returns.
 */
function createOwed(line: { live: () => boolean; deliver: (waiting: Waiting<unknown>) => void }) {
  const results = new Map<string, Waiting<WorkspaceCommandResult>>();
  const answers = new Map<string, Waiting<unknown>>();

  function ask<T>(held: Map<string, Waiting<T>>, message: ComputerClientMessage & { requestId: string }): Promise<T> {
    if (!line.live()) return Promise.reject(new Error(COMPUTER_OFFLINE));
    const payload = requestPayload(message);
    if (payload === null) return Promise.reject(new Error(COMPUTER_SEND_TOO_LARGE));
    const transferring = isComputerTransfer(message);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        held.delete(message.requestId);
        reject(new Error(line.live() ? "That computer did not answer in time." : COMPUTER_OFFLINE));
      }, transferring ? COMPUTER_TRANSFER_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      timer.unref?.();
      const waiting: Waiting<T> = { resolve, reject, timer, requestId: message.requestId, payload, transferring };
      held.set(message.requestId, waiting);
      line.deliver(waiting as Waiting<unknown>);
    });
  }

  return {
    send: (inputs: WorkspaceInput[]) => ask(results, { kind: "input", requestId: randomUUID(), inputs }),
    query: (query: ComputerQuery) => ask(answers, { kind: "query", requestId: randomUUID(), query }),
    receive(message: ComputerServerMessage) {
      if (message.kind === "result") claim(results, message.requestId)?.resolve(message.result);
      if (message.kind !== "answer") return;
      const waiting = claim(answers, message.requestId);
      if (message.ok) waiting?.resolve(message.result);
      else waiting?.reject(new Error(message.message));
    },
    /** In the order each was first asked within its kind. */
    waiting: (): Waiting<unknown>[] => [...results.values(), ...answers.values()] as Waiting<unknown>[],
    refuse(message: string) {
      refuseWaiting(results as Map<string, Waiting<never>>, message);
      refuseWaiting(answers as Map<string, Waiting<never>>, message);
    },
  };
}

/**
 * One dial, with what to do as it opens, speaks, and closes. `heard` is told whenever bytes arrive,
 * so a long answer still on its way counts as the line being alive before it is whole.
 */
function dial(url: string, handlers: { open: () => void; heard: () => void; message: (message: ComputerServerMessage) => void; close: (code: number, reason: string) => void }) {
  const socket = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
  socket.on("upgrade", (response) => response.socket.on("data", handlers.heard));
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

/** Checks the encoded envelope before sending so an oversized request cannot kill the link. */
function requestPayload(message: ComputerClientMessage): string | null {
  if (message.kind === "input" && message.inputs.some((input) => input.type === "attachments.send" && input.attachments.some((attachment) => attachment.source.replace(/^data:[^,]*,/, "").length > MAX_ATTACHMENT_ENCODED_BYTES))) return null;
  const payload = stringifyWorkspaceJson(message);
  return Buffer.byteLength(payload) > MAX_COMPUTER_MESSAGE_BYTES ? null : payload;
}

/**
 * One line to a paired computer. It dials, pairs or resumes, mirrors the other computer's state as
 * it arrives, and carries inputs there. A dropped line is dialled again on a growing pause, and what
 * was still owed an answer is carried again once it is back: the other computer remembers what it
 * has run by request, so nothing runs twice. A line the other computer refuses outright, as unpaired
 * or unreadable, is left down with the reason and asked again only rarely, or when told to.
 */
export function createComputerClient(options: ComputerClientOptions) {
  let socket: WebSocket | null = null;
  let credential = options.credential;
  let sessionId: string | undefined;
  let lastSequence = 0;
  let displayed: WorkspaceState | null = null;
  let capabilities: ComputerCapabilities;
  const applyUpdate = createRemoteWorkspaceReplica();
  let attempt = 0;
  let stopped = false;
  /** Whether the other computer refused the line, which is not asked again on the usual pause. */
  let refused = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const watchdog = createWatchdog(() => socket?.terminate());
  let status: ComputerStatus = "connecting";
  /** Why the line last went down, kept through the dials that follow until one connects. */
  let lastError: string | null = null;
  const url = options.url ?? computerSocketUrl(options.host);

  function report(next: ComputerStatus, error: string | null = null) {
    status = next;
    options.onStatus(next, error);
  }

  function write(message: ComputerClientMessage) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(stringifyWorkspaceJson(message));
  }

  /** Writes a request, announcing a large one first so the other computer allows for it. */
  function deliver(waiting: Waiting<unknown>) {
    if (waiting.transferring) write({ kind: "transfer", requestId: waiting.requestId });
    if (socket?.readyState === WebSocket.OPEN) socket.send(waiting.payload);
  }

  const owed = createOwed({ live: () => socket?.readyState === WebSocket.OPEN && status === "connected", deliver });

  /** The line answers again: what is waiting is carried again, in the order it was first asked. */
  function connected() {
    attempt = 0;
    lastError = null;
    report("connected");
    for (const waiting of owed.waiting()) deliver(waiting);
  }

  function schedule() {
    if (stopped || retry) return;
    const delay = refused ? REFUSED_RETRY_MS : RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]!;
    attempt += 1;
    retry = setTimeout(() => { retry = null; open(); }, delay);
    retry.unref?.();
  }

  /**
   * A refused line is left down a long while; every other drop is dialled again soon. Requests
   * still waiting outlast a drop, each on its own deadline, unless the other computer refused us.
   */
  function dropped(error: string | null, refusal = false) {
    watchdog.stop();
    const closing = socket;
    socket = null;
    closing?.terminate();
    if (stopped) return;
    if (error) lastError = error;
    if (refusal) {
      owed.refuse(error ?? COMPUTER_OFFLINE);
      refused = true;
      /** A code is spent or wrong for good, so a pairing line is not dialled again at all. */
      if (!("token" in credential)) stopped = true;
    }
    report("offline", lastError);
    schedule();
  }

  function receive(message: ComputerServerMessage) {
    lastSequence = message.sequence;
    watchdog.heard();
    /**
     * A resumed line holding a view already is live on its first word: a resume replays only what
     * changed, and a computer where nothing did sends no state at all. A new line waits for its state.
     */
    if (displayed && sessionId && status !== "connected" && message.kind !== "workspace" && message.kind !== "error") connected();
    if (message.kind === "paired") {
      credential = { token: message.token };
      options.onPaired(message.deviceId, message.deviceName, message.token);
    } else if (message.kind === "workspace") {
      if (message.sessionId) sessionId = message.sessionId;
      try {
        const next = applyUpdate(message.update);
        if (next === "resync") { sessionId = undefined; socket?.terminate(); return; }
        if (!next) return;
        displayed = next;
      } catch {
        dropped("This computer sent workspace data this app cannot read. Updating AI Coding Tool may help.", true);
        return;
      }
      if (status !== "connected") connected();
      options.onState(displayed);
    } else if (message.kind === "result" || message.kind === "answer") {
      owed.receive(message);
    } else if (message.kind === "error") {
      const refusal = message.code === "unauthorized" || message.code === "version" || message.code === "expired-code" || message.code === "rate-limited";
      dropped(message.message, refusal);
    } else if (message.kind === "notice") {
      options.onNotice?.(message.notice);
    } else if (message.kind === "capabilities") {
      capabilities = message.capabilities;
      options.onCapabilities?.(capabilities);
    } else if (message.kind === "name") {
      options.onName?.(message.name);
    } else if (message.kind === "ping") {
      write({ kind: "pong", at: message.at });
    }
  }

  function open() {
    if (stopped || socket) return;
    report("connecting", lastError);
    const dialled: WebSocket = dial(url, {
      heard: () => { if (socket === dialled) watchdog.heard(); },
      open: () => {
        if (socket !== dialled) return;
        capabilities = undefined;
        options.onCapabilities?.(undefined);
        watchdog.start();
        if ("token" in credential) write({ kind: "resume", version: COMPUTER_PROTOCOL_VERSION, token: credential.token, ...(sessionId ? { sessionId } : {}), lastSequence });
        else write({ kind: "pair", version: COMPUTER_PROTOCOL_VERSION, code: credential.code, deviceName: options.deviceName });
      },
      message: (message) => { if (socket === dialled) receive(message); },
      close: (code, said) => { if (socket === dialled) dropped(code === 1000 || !said || said === "unauthorized" ? null : said); },
    });
    socket = dialled;
  }


  open();
  return {
    get status() { return status; },
    get state() { return displayed; },
    send: (inputs: WorkspaceInput[]) => {
      if (inputs.some((input) => !isWorkspaceViewInput(input) || !isAppCommandType(input.type)
        || !supportsComputerCommand(COMPUTER_CAPABILITIES, input as AppCommand)
        || !supportsComputerCommand(capabilities, input as AppCommand))) return Promise.reject(new Error(REMOTE_UNSUPPORTED));
      return owed.send(inputs);
    },
    query: (query: ComputerQuery) => supportsComputerQuery(capabilities, query) ? owed.query(query) : Promise.reject(new Error(REMOTE_UNSUPPORTED)),
    /**
     * Dials now rather than at the end of the pause, and asks a computer that refused the line again.
     * A line that is up is left alone; one that only looks up, after the network moved under it, is
     * cut first so the dial is a real one.
     */
    reconnect() {
      if (stopped || (refused && !("token" in credential))) return;
      refused = false;
      attempt = 0;
      if (retry) clearTimeout(retry);
      retry = null;
      if (socket && (status !== "connected" || Date.now() - watchdog.heardAt < MOBILE_PING_INTERVAL_MS + 5_000)) return;
      if (socket) socket.terminate();
      else open();
    },
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      watchdog.stop();
      const closing = socket;
      socket = null;
      owed.refuse(COMPUTER_OFFLINE);
      closing?.close(1000, "stopped");
    },
  };
}

export type ComputerClient = ReturnType<typeof createComputerClient>;
