import { applyMobilePatch, emptyMobileView } from "../../application/mobile-projection";
import {
  isMobileCommand,
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
  /** When the user asked, by the phone's clock, so a stop asked long ago is not carried out late. */
  queuedAt: number;
  /** How many times it has been written. One the Mac never answers is given up on rather than sent forever. */
  writes: number;
  /** The running server it was written to, which alone remembers whether it ran it. */
  instance?: string;
};

/** A command the Mac turned down, handed back so the screen that sent it can give the user their words back. */
export type ReturnedCommand = { requestId: string; command: MobileCommand; message: string };

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
  /** The build of the page this phone is running, learnt from the first snapshot it ever reads. */
  build: string | null;
  /** The running server the current session belongs to, once a snapshot has named it. */
  instance: string | null;
  view: MobileView;
  outbox: OutboxEntry[];
  /** The last command the Mac refused, until another is. */
  returned: ReturnedCommand | null;
  /** When the current line opened, by the phone's clock. */
  openedAt: number;
  /** Consecutive failed connections, which is what the backoff counts. */
  attempt: number;
  /** One plain sentence for the user. Never a code, never a stack. */
  notice: string | null;
  /** The view's error the user has already put away. It stays away until the view's error changes. */
  dismissedError: string | null;
};

export type MobileClientEvent =
  | { kind: "opened"; at: number }
  | { kind: "received"; message: MobileServerMessage }
  /** A frame this page could not read, which still took its place in the numbering. */
  | { kind: "skipped"; sequence: number }
  | { kind: "closed" }
  | { kind: "dispatch"; requestId: string; command: MobileCommand; at: number }
  /** Time to write again whatever is still unanswered on a line that is up. */
  | { kind: "remind" }
  /** The moment a resume's replay has had time to land, after which silence means a frame was lost. */
  | { kind: "settled" }
  /**
   * The phone came back: the tab is visible again, or the network is. `stale` says the line it holds
   * has been silent for longer than the Mac's ping interval, which after a sleep means it is dead
   * whatever the socket says.
   */
  | { kind: "wake"; stale?: boolean }
  | { kind: "dismiss-notice" };

export type MobileClientEffect =
  | { kind: "send"; message: MobileClientMessage }
  | { kind: "connect"; delayMs: number }
  | { kind: "disconnect" }
  | { kind: "settle"; delayMs: number }
  /** Null forgets the token, which is what an unauthorised phone must do before it shows a code. */
  | { kind: "store"; credential: MobileCredential | null }
  /** Fetches the page again, which is the only way a phone gets the build the Mac now serves. */
  | { kind: "reload" }
  /** The page and the Mac agree on the build, so a later change of build may reload it again. */
  | { kind: "current" }
  /** What is still owed, kept where a reload or an evicted tab finds it again. */
  | { kind: "keep"; outbox: OutboxEntry[] };

export type MobileClientStep = { state: MobileClientState; effects: MobileClientEffect[] };

/** How long a redial waits, doubling per failure. */
export const MOBILE_RETRY_BASE_MS = 500;
export const MOBILE_RETRY_MAX_MS = 15_000;

/** How long after the line comes back a replayed acknowledgement may still arrive. */
export const MOBILE_SETTLE_MS = 750;

/** How many unacknowledged commands the phone will hold. Past this a new one is refused, not queued. */
export const MOBILE_OUTBOX_LIMIT = 50;

/** How often a live line writes again what is still unanswered. The Mac runs each request once, whatever it is sent. */
export const MOBILE_RESEND_MS = 10_000;

/** How many times a command is written before the phone stops asking. */
export const MOBILE_RESEND_LIMIT = 6;

/** How long a stop or a decision may wait for the line before carrying it out would surprise the user. */
export const MOBILE_STALE_COMMAND_MS = 30_000;

/** Commands that only move what the phone is looking at: only the last one asked for is worth sending. */
const VIEW_COMMANDS = new Set<MobileCommand["type"]>(["task.select", "task.new"]);

/** Commands that act on a run as it stood when asked, and are dropped rather than carried out late. */
const MOMENT_COMMANDS = new Set<MobileCommand["type"]>(["run.cancel", "run.decide"]);

const SCAN_AGAIN = "Scan the QR code on your computer to connect this phone.";

const REFUSALS: Record<MobileErrorCode, string | null> = {
  version: "This page is out of date. Reload it to carry on.",
  unauthorized: "This phone is no longer paired. Scan a fresh QR code on your computer.",
  "expired-code": "That pairing code has expired. Scan a fresh QR code on your computer.",
  "rate-limited": "The computer is turning connections away. Trying again shortly.",
  unreadable: null,
  internal: null,
};

export function backoffDelay(attempt: number): number {
  if (attempt <= 1) return MOBILE_RETRY_BASE_MS;
  return Math.min(MOBILE_RETRY_MAX_MS, MOBILE_RETRY_BASE_MS * 2 ** (attempt - 1));
}

export function initialMobileClient(input: { credential: MobileCredential | null; code: string | null; deviceName: string; outbox?: OutboxEntry[] }): MobileClientState {
  const entry: MobileEntry = input.credential ? "ready" : input.code ? "pairing" : "blocked";
  return {
    entry,
    credential: input.credential,
    code: input.code,
    deviceName: input.deviceName,
    connection: "offline",
    sessionId: null,
    lastSequence: 0,
    build: null,
    instance: null,
    view: emptyMobileView(),
    /** What a page that reloaded still owed is sent again; the Mac runs each request once, whatever it is sent. */
    outbox: input.credential ? input.outbox ?? [] : [],
    returned: null,
    openedAt: 0,
    attempt: 0,
    notice: entry === "blocked" ? SCAN_AGAIN : null,
    dismissedError: null,
  };
}

/** Whether a dropped line is worth redialling: a phone with nothing to offer would only be refused again. */
export function shouldReconnect(state: MobileClientState): boolean {
  return state.entry !== "blocked";
}

export function reduceMobileClient(state: MobileClientState, event: MobileClientEvent): MobileClientStep {
  const step = reduceEvent(state, event);
  return step.state.outbox === state.outbox ? step : withEffect(step, { kind: "keep", outbox: step.state.outbox });
}

function reduceEvent(state: MobileClientState, event: MobileClientEvent): MobileClientStep {
  switch (event.kind) {
    case "opened":
      return opened({ ...state, openedAt: event.at });
    case "received":
      return received(state, event.message);
    case "skipped":
      if (event.sequence <= state.lastSequence) return { state, effects: [] };
      if (state.sessionId !== null && event.sequence > state.lastSequence + 1) return resync(state);
      return { state: { ...state, lastSequence: event.sequence }, effects: [] };
    case "closed":
      return closed(state);
    case "dispatch":
      return dispatch(state, event.requestId, event.command, event.at);
    case "remind":
      return state.connection === "live" ? flush(state, state.outbox.filter((item) => item.sent)) : { state, effects: [] };
    /**
     * A replay that has had its moment: anything still unacknowledged is written again. Arriving
     * before the line is live means the window was mistimed, not that there is nothing owed, so it
     * is given another — otherwise a command written once and never acknowledged is stranded.
     */
    case "settled":
      if (state.connection === "live") return flush(state, state.outbox);
      if (state.connection === "offline") return { state, effects: [] };
      return { state, effects: [{ kind: "settle", delayMs: MOBILE_SETTLE_MS }] };
    case "wake": {
      if (!shouldReconnect(state)) return { state, effects: [] };
      if (state.connection === "offline") return { state: { ...state, attempt: 0 }, effects: [{ kind: "connect", delayMs: 0 }] };
      /** A line that has gone quiet is redialled now rather than found dead at the deadline; a resume replays only what was missed. */
      if (!event.stale) return { state, effects: [] };
      const connection: MobileConnectionState = state.lastSequence > 0 ? "resuming" : "connecting";
      return { state: { ...state, attempt: 0, connection }, effects: [{ kind: "disconnect" }, { kind: "connect", delayMs: 0 }] };
    }
    case "dismiss-notice":
      return { state: { ...state, notice: null, dismissedError: state.view.error }, effects: [] };
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

/**
 * A full outbox refuses rather than drops: text the user typed is not thrown away in silence. One the
 * Mac could not read is refused here, since sending it would only be turned away. Waiting for the
 * line, a move between screens replaces the moves just before it, but never one that something
 * asked after it depends on: a new thread a message is sent into stays.
 */
function dispatch(state: MobileClientState, requestId: string, command: MobileCommand, at: number): MobileClientStep {
  if (!isMobileCommand(command)) return { state: { ...state, notice: "That could not be sent to your computer." }, effects: [] };
  const live = state.connection === "live";
  const kept = live || !VIEW_COMMANDS.has(command.type) ? state.outbox : withoutTrailingMoves(state.outbox);
  if (kept.length >= MOBILE_OUTBOX_LIMIT) {
    return { state: { ...state, notice: "Too much is already waiting for your computer. Wait for it to catch up." }, effects: [] };
  }
  const written = live && state.instance ? { instance: state.instance } : {};
  const next = { ...state, outbox: [...kept, { requestId, command, sent: live, queuedAt: at, writes: live ? 1 : 0, ...written }] };
  return { state: next, effects: live ? [{ kind: "send", message: { kind: "command", requestId, command } }] : [] };
}

/** The outbox without the unwritten moves between screens at its end, which a newer move makes moot. */
function withoutTrailingMoves(outbox: OutboxEntry[]): OutboxEntry[] {
  let end = outbox.length;
  while (end > 0 && !outbox[end - 1]!.sent && VIEW_COMMANDS.has(outbox[end - 1]!.command.type)) end -= 1;
  return end === outbox.length ? outbox : outbox.slice(0, end);
}

/**
 * Writes every command owed a send, in the order it was asked, and marks it written. One written as
 * often as the limit allows without an answer is given up on, and the user told.
 */
function flush(state: MobileClientState, owed: OutboxEntry[]): MobileClientStep {
  if (!owed.length) return { state, effects: [] };
  const spent = owed.filter((item) => item.writes >= MOBILE_RESEND_LIMIT);
  const effects = owed.filter((item) => !spent.includes(item)).map((item): MobileClientEffect => ({ kind: "send", message: { kind: "command", requestId: item.requestId, command: item.command } }));
  const stamp = (item: OutboxEntry) => item.instance ?? state.instance ?? undefined;
  const outbox = state.outbox.flatMap((item): OutboxEntry[] => {
    if (spent.includes(item)) return [];
    if (!owed.includes(item)) return [item];
    const instance = stamp(item);
    return [{ ...item, sent: true, writes: item.writes + 1, ...(instance ? { instance } : {}) }];
  });
  return { state: { ...state, outbox, ...(spent.length ? { notice: "Your computer did not answer. Try again." } : {}) }, effects };
}

/**
 * The line is answering again. A line just back writes everything still owed, in the order it was
 * asked, so nothing asked later lands first; a stop or a decision that waited too long is dropped.
 * A line already live writes only what is new.
 */
function live(state: MobileClientState): MobileClientStep {
  const next = { ...state, connection: "live" as const, attempt: 0 };
  if (state.connection === "live") return flush(next, next.outbox.filter((item) => !item.sent));
  const late = next.outbox.filter((item) => MOMENT_COMMANDS.has(item.command.type) && next.openedAt - item.queuedAt > MOBILE_STALE_COMMAND_MS);
  const current = late.length ? { ...next, outbox: next.outbox.filter((item) => !late.includes(item)), notice: "Some taps were not sent: the line was down too long." } : next;
  return flush(current, current.outbox);
}

function received(state: MobileClientState, message: MobileServerMessage): MobileClientStep {
  if (message.kind === "error") return refused(state, message.code, message.message);
  /** A snapshot is the ground truth of a session, so it is read even when its numbering starts over. */
  if (message.kind !== "snapshot" && message.kind !== "paired") {
    if (message.sequence <= state.lastSequence) return { state, effects: [] };
    if (state.sessionId !== null && message.sequence > state.lastSequence + 1) return resync(state);
  }
  const seen = { ...state, lastSequence: message.sequence };
  /** Before the first snapshot there is no view to be live on, so the line is kept as it was and only answered. */
  const settled = (next: MobileClientState): MobileClientStep => (state.sessionId === null ? { state: next, effects: [] } : live(next));
  switch (message.kind) {
    case "paired": {
      const credential: MobileCredential = { token: message.token, deviceId: message.deviceId, deviceName: message.deviceName };
      return { state: { ...seen, credential, code: null, entry: "ready", notice: null }, effects: [{ kind: "store", credential }] };
    }
    /**
     * A snapshot names the build the Mac serves. A page from an older one cannot draw what the Mac
     * now describes, so it fetches itself again rather than carry on showing the wrong screen.
     */
    /** It is still drawn: a reload the page cannot make leaves the user on the newest view, told to reload. */
    case "snapshot": {
      const changed = seen.build !== null && seen.build !== message.build;
      /** A snapshot within the session it already holds comes from the same server, which remembers. */
      const kept = message.sessionId === seen.sessionId ? seen : restarted(seen, message.instance);
      const notice = changed ? REFUSALS.version : kept.outbox === seen.outbox ? null : RESTARTED;
      const step = live(shown({ ...kept, build: message.build, instance: message.instance ?? null, sessionId: message.sessionId, notice }, message.view));
      return withEffect(step, changed ? { kind: "reload" } : { kind: "current" });
    }
    case "patch": {
      const view = applyMobilePatch(seen.view, message.patch);
      return view ? settled(shown(seen, view)) : resync(state);
    }
    case "ack": {
      const asked = seen.outbox.find((item) => item.requestId === message.requestId);
      const outbox = seen.outbox.filter((item) => item !== asked);
      if (message.ok) return settled({ ...seen, outbox });
      const returned = asked ? { requestId: asked.requestId, command: asked.command, message: message.message } : seen.returned;
      return settled({ ...seen, outbox, returned, notice: message.message });
    }
    /** The answer itself is handed to whoever asked by the connection; here it only counts. */
    case "answer":
      return settled(seen);
    case "ping":
      return withEffect(settled(seen), { kind: "send", message: { kind: "pong", at: message.at } });
  }
}

const RESTARTED = "Your computer restarted. Check that your last taps went through.";

/**
 * A new session's server may not be the one a command was written to, and one that is not has
 * forgotten whether it ran it, so sending it again could run it twice. Only a command written to
 * this very server, by name, is sent again; the rest are let go of, and the user told to check.
 */
function restarted(state: MobileClientState, instance: string | undefined): MobileClientState {
  const outbox = state.outbox.filter((item) => item.writes === 0 || (instance !== undefined && item.instance === instance));
  return outbox.length === state.outbox.length ? state : { ...state, outbox };
}

/** Takes the next view; an error the user put away comes back only once the view's error has been something else. */
function shown(state: MobileClientState, view: MobileView): MobileClientState {
  return { ...state, view, dismissedError: view.error === state.view.error ? state.dismissedError : null };
}

/**
 * A gap in the numbering means a frame was lost, and a patch onto a view with a hole in it lies. It
 * counts as a failed line, so a Mac that keeps sending what cannot be read is not redialled in a loop.
 */
function resync(state: MobileClientState): MobileClientStep {
  const attempt = state.attempt + 1;
  return {
    state: { ...state, sessionId: null, lastSequence: 0, connection: "connecting", attempt },
    effects: [{ kind: "disconnect" }, { kind: "connect", delayMs: state.attempt ? backoffDelay(attempt) : 0 }],
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
  /**
   * A phone turned away for a token it no longer holds, but opened from a fresh QR, has the code to
   * pair again: the token was revoked or the Mac forgot it, and the scan is exactly what fixes that.
   */
  if (code === "unauthorized" && state.code) {
    const next: MobileClientState = { ...state, credential: null, entry: "pairing", connection: "offline", sessionId: null, lastSequence: 0, notice: null };
    return { state: next, effects: [{ kind: "store", credential: null }, { kind: "disconnect" }, { kind: "connect", delayMs: 0 }] };
  }
  /**
   * The page is what is out of date, so it fetches itself again. The sentence stays for a reload
   * that is refused, and the line is still tried on the backoff in case the Mac is what changes.
   */
  if (code === "version") {
    const attempt = state.attempt + 1;
    return {
      state: { ...state, connection: "offline", attempt, notice: REFUSALS.version },
      effects: [{ kind: "disconnect" }, { kind: "reload" }, { kind: "connect", delayMs: backoffDelay(attempt) }],
    };
  }
  /** A pairing phone locked out cannot wait it out: its code expires first. The Mac's own words say what to do. */
  const sentence = code === "rate-limited" ? message : REFUSALS[code];
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
