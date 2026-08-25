import { applyMobilePatch, emptyMobileView } from "../../application/mobile-projection";
import {
  MOBILE_PROTOCOL_VERSION,
  type MobileClientMessage,
  type MobileCommand,
  type MobileErrorCode,
  type MobileServerMessage,
  type MobileView,
} from "../../contracts/mobile";
import type { MobileConnectionState } from "../../domain/mobile";

/**
 * The phone's whole behaviour as one reducer: what the socket says, what the user does and what the
 * browser does to a backgrounded tab all arrive as events, and everything the driver must perform —
 * writing a frame, reconnecting, remembering a token — comes back as an effect. Nothing here opens
 * a socket or reads the clock, which is what lets the awkward parts be tested without a browser.
 */

/** What the phone holds after pairing. The token is the only thing that gets it back in. */
export type MobileCredential = {
  token: string;
  deviceId: string;
  deviceName: string;
};

/** Where the phone stands with the Mac, which decides whether a dropped line is worth redialling. */
export type MobileEntry = "pairing" | "ready" | "blocked";

/** A command the user has asked for, kept until the Mac acknowledges it by id. */
export type OutboxEntry = {
  requestId: string;
  command: MobileCommand;
  /** Whether it has been written to a socket. An unwritten one is owed a send the moment there is one. */
  sent: boolean;
};

export type MobileClientState = {
  entry: MobileEntry;
  credential: MobileCredential | null;
  /** The one-time code the page was opened with, until it is spent or refused. */
  code: string | null;
  /** What this phone calls itself when it pairs. */
  deviceName: string;
  connection: MobileConnectionState;
  sessionId: string | null;
  /** The newest sequence this phone has seen, which is what a resume is measured against. */
  lastSequence: number;
  view: MobileView;
  outbox: OutboxEntry[];
  /** Consecutive failed connections, which is what the backoff counts. */
  attempt: number;
  /** One plain sentence for the user. Never a code, never a stack. */
  notice: string | null;
};

export type MobileClientEvent =
  | { kind: "opened" }
  | { kind: "received"; message: MobileServerMessage }
  | { kind: "closed" }
  | { kind: "dispatch"; requestId: string; command: MobileCommand }
  /** The moment a resume's replay has had time to land, after which silence means a frame was lost. */
  | { kind: "settled" }
  /** The phone came back: the tab is visible again, or the network is. */
  | { kind: "wake" }
  | { kind: "dismiss-notice" };

export type MobileClientEffect =
  | { kind: "send"; message: MobileClientMessage }
  | { kind: "connect"; delayMs: number }
  | { kind: "disconnect" }
  | { kind: "settle"; delayMs: number }
  /** Null forgets the token, which is what an unauthorised phone must do before it shows a code. */
  | { kind: "store"; credential: MobileCredential | null };

export type MobileClientStep = { state: MobileClientState; effects: MobileClientEffect[] };

/** How long a redial waits, doubling per failure. */
export const MOBILE_RETRY_BASE_MS = 500;
export const MOBILE_RETRY_MAX_MS = 15_000;

/** How long after the line comes back a replayed acknowledgement may still arrive. */
export const MOBILE_SETTLE_MS = 750;

/** How many unacknowledged commands the phone will hold. Past this a new one is refused, not queued. */
export const MOBILE_OUTBOX_LIMIT = 50;

const SCAN_AGAIN = "Scan the QR code on your Mac to connect this phone.";

const REFUSALS: Record<MobileErrorCode, string | null> = {
  version: "This page is out of date. Reload it to carry on.",
  unauthorized: "This phone is no longer paired. Scan a fresh QR code on your Mac.",
  "expired-code": "That pairing code has expired. Scan a fresh QR code on your Mac.",
  "rate-limited": "The Mac is turning connections away. Trying again shortly.",
  unreadable: null,
  internal: null,
};

export function backoffDelay(attempt: number): number {
  if (attempt <= 1) return MOBILE_RETRY_BASE_MS;
  return Math.min(MOBILE_RETRY_MAX_MS, MOBILE_RETRY_BASE_MS * 2 ** (attempt - 1));
}

export function initialMobileClient(input: { credential: MobileCredential | null; code: string | null; deviceName: string }): MobileClientState {
  const entry: MobileEntry = input.credential ? "ready" : input.code ? "pairing" : "blocked";
  return {
    entry,
    credential: input.credential,
    code: input.code,
    deviceName: input.deviceName,
    connection: "offline",
    sessionId: null,
    lastSequence: 0,
    view: emptyMobileView(),
    outbox: [],
    attempt: 0,
    notice: entry === "blocked" ? SCAN_AGAIN : null,
  };
}

/** Whether a dropped line is worth redialling: a phone with nothing to offer would only be refused again. */
export function shouldReconnect(state: MobileClientState): boolean {
  return state.entry !== "blocked";
}

export function reduceMobileClient(state: MobileClientState, event: MobileClientEvent): MobileClientStep {
  switch (event.kind) {
    case "opened":
      return opened(state);
    case "received":
      return received(state, event.message);
    case "closed":
      return closed(state);
    case "dispatch":
      return dispatch(state, event.requestId, event.command);
    /**
     * A replay that has had its moment: anything still unacknowledged is written again. Arriving
     * before the line is live means the window was mistimed, not that there is nothing owed, so it
     * is given another — otherwise a command written once and never acknowledged is stranded.
     */
    case "settled":
      if (state.connection === "live") return flush(state, state.outbox);
      if (state.connection === "offline") return { state, effects: [] };
      return { state, effects: [{ kind: "settle", delayMs: MOBILE_SETTLE_MS }] };
    case "wake":
      if (state.connection !== "offline" || !shouldReconnect(state)) return { state, effects: [] };
      return { state: { ...state, attempt: 0 }, effects: [{ kind: "connect", delayMs: 0 }] };
    case "dismiss-notice":
      return { state: { ...state, notice: null }, effects: [] };
  }
}

/** A fresh socket says who it is: the token it already holds, or the code it was opened with. */
function opened(state: MobileClientState): MobileClientStep {
  if (state.credential) {
    const message: MobileClientMessage = {
      kind: "resume",
      version: MOBILE_PROTOCOL_VERSION,
      token: state.credential.token,
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      lastSequence: state.lastSequence,
    };
    const connection: MobileConnectionState = state.lastSequence > 0 ? "resuming" : "connecting";
    return { state: { ...state, connection }, effects: [{ kind: "send", message }, { kind: "settle", delayMs: MOBILE_SETTLE_MS }] };
  }
  if (state.code) {
    const message: MobileClientMessage = { kind: "pair", version: MOBILE_PROTOCOL_VERSION, code: state.code, deviceName: state.deviceName };
    return { state: { ...state, connection: "connecting" }, effects: [{ kind: "send", message }] };
  }
  return { state: { ...state, connection: "offline", entry: "blocked", notice: state.notice ?? SCAN_AGAIN }, effects: [{ kind: "disconnect" }] };
}

function closed(state: MobileClientState): MobileClientStep {
  const attempt = state.attempt + 1;
  const offline = { ...state, connection: "offline" as const, attempt };
  if (!shouldReconnect(state)) return { state: offline, effects: [] };
  return { state: offline, effects: [{ kind: "connect", delayMs: backoffDelay(attempt) }] };
}

/** A full outbox refuses rather than drops: text the user typed is not thrown away in silence. */
function dispatch(state: MobileClientState, requestId: string, command: MobileCommand): MobileClientStep {
  if (state.outbox.length >= MOBILE_OUTBOX_LIMIT) {
    return { state: { ...state, notice: "Too much is already waiting for your Mac. Wait for it to catch up." }, effects: [] };
  }
  const live = state.connection === "live";
  const next = { ...state, outbox: [...state.outbox, { requestId, command, sent: live }] };
  return { state: next, effects: live ? [{ kind: "send", message: { kind: "command", requestId, command } }] : [] };
}

/** Writes every command still owed a send and marks it written. */
function flush(state: MobileClientState, owed: OutboxEntry[]): MobileClientStep {
  const effects = owed.map((item): MobileClientEffect => ({ kind: "send", message: { kind: "command", requestId: item.requestId, command: item.command } }));
  if (!effects.length) return { state, effects: [] };
  return { state: { ...state, outbox: state.outbox.map((item) => (owed.includes(item) ? { ...item, sent: true } : item)) }, effects };
}

/** The line is answering again: unwritten commands go now, written ones wait for the replay to settle. */
function live(state: MobileClientState): MobileClientStep {
  const next = { ...state, connection: "live" as const, attempt: 0 };
  return flush(next, next.outbox.filter((item) => !item.sent));
}

function received(state: MobileClientState, message: MobileServerMessage): MobileClientStep {
  if (message.kind === "error") return refused(state, message.code, message.message);
  /** A snapshot is the ground truth of a session, so it is read even when its numbering starts over. */
  if (message.kind !== "snapshot" && message.kind !== "paired") {
    if (message.sequence <= state.lastSequence) return { state, effects: [] };
    if (state.sessionId !== null && message.sequence > state.lastSequence + 1) return resync(state);
  }
  const seen = { ...state, lastSequence: message.sequence };
  switch (message.kind) {
    case "paired": {
      const credential: MobileCredential = { token: message.token, deviceId: message.deviceId, deviceName: message.deviceName };
      return { state: { ...seen, credential, code: null, entry: "ready", notice: null }, effects: [{ kind: "store", credential }] };
    }
    case "snapshot": {
      const fresh = { ...seen, sessionId: message.sessionId, view: message.view, notice: null };
      return live(fresh);
    }
    case "patch":
      return live({ ...seen, view: applyMobilePatch(seen.view, message.patch) });
    case "ack": {
      const outbox = seen.outbox.filter((item) => item.requestId !== message.requestId);
      return live({ ...seen, outbox, notice: message.ok ? seen.notice : message.message });
    }
    case "ping":
      return withEffect(live(seen), { kind: "send", message: { kind: "pong", at: message.at } });
  }
}

/** A gap in the numbering means a frame was lost, and a patch onto a view with a hole in it lies. */
function resync(state: MobileClientState): MobileClientStep {
  return {
    state: { ...state, sessionId: null, lastSequence: 0, connection: "connecting" },
    effects: [{ kind: "disconnect" }, { kind: "connect", delayMs: 0 }],
  };
}

function refused(state: MobileClientState, code: MobileErrorCode, message: string): MobileClientStep {
  /**
   * A phone that holds a token is being turned away for something it can wait out, so it keeps the
   * token and redials on the backoff. Being blocked here would leave it dead until a hand reloaded it.
   */
  if (code === "rate-limited" && state.credential) {
    const attempt = state.attempt + 1;
    return {
      state: { ...state, connection: "offline", attempt, notice: REFUSALS["rate-limited"] },
      effects: [{ kind: "disconnect" }, { kind: "connect", delayMs: backoffDelay(attempt) }],
    };
  }
  const sentence = REFUSALS[code];
  if (!sentence) return { state: { ...state, notice: message }, effects: [] };
  const cleared = code === "unauthorized";
  const next: MobileClientState = {
    ...state,
    entry: "blocked",
    notice: sentence,
    connection: "offline",
    ...(cleared ? { credential: null } : {}),
    ...(code === "expired-code" ? { code: null } : {}),
  };
  return { state: next, effects: cleared ? [{ kind: "store", credential: null }, { kind: "disconnect" }] : [{ kind: "disconnect" }] };
}

function withEffect(step: MobileClientStep, effect: MobileClientEffect): MobileClientStep {
  return { state: step.state, effects: [...step.effects, effect] };
}
