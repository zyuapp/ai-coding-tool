import { isMobileServerMessage, type MobileCommand, type MobileQuery, type MobileServerMessage } from "../../contracts/mobile";
import { MOBILE_PING_INTERVAL_MS } from "../../domain/mobile";
import { MOBILE_RESEND_MS, reduceMobileClient, type MobileClientEffect, type MobileClientEvent, type MobileClientState } from "./protocol";
import { writeCredential, writeOutbox, type CredentialStore } from "./storage";

/** How long a dial may sit unanswered. A phone whose tunnel is not back yet would otherwise wait on the browser's own minute. */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Silence past this on a line that claims to be open means it is gone: the Mac pings more often
 * than this, so a phone that heard nothing slept through the pings or lost its network under them.
 */
const STALE_AFTER_MS = MOBILE_PING_INTERVAL_MS + 5_000;

/** How long a line asked whether it still carries anything has to answer. */
const PROBE_MS = 5_000;

/** How long a read may wait for its answer before the screen that asked is told. */
const QUERY_TIMEOUT_MS = 10_000;

/**
 * Set once the page has reloaded itself for a new build, so two stale builds cannot chase each
 * other, and cleared once the page and the Mac agree, so the Mac's next update reloads it again.
 */
const RELOADED_KEY = "aicodingtool.mobile.reloaded";

/**
 * The one impure part: a socket, three timers, and the two things a phone does that a desktop does
 * not — sleep and lose its network. Every decision it takes comes from {@link reduceMobileClient};
 * this only performs what that asks for and feeds back what it hears.
 */
export type MobileConnection = {
  send: (command: MobileCommand) => void;
  /**
   * One read, answered by the Mac or refused. A read is never held for a line that is down: the
   * screen that asked shows the refusal and asks again when the user does.
   */
  query: (query: MobileQuery) => Promise<unknown>;
  dismissNotice: () => void;
  stop: () => void;
};

/** What a read is refused with when the line is not there to carry it. */
export const MOBILE_QUERY_OFFLINE = "Not connected to your computer.";

type Asking = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** The browser's word on the network changing under it, where it has one. */
type NetworkInformation = EventTarget & { type?: string };

export type MobileConnectionOptions = {
  url: string;
  initial: MobileClientState;
  store: CredentialStore;
  onState: (state: MobileClientState) => void;
};

/**
 * The reads waiting on the Mac, each answered by its id, refused when the line goes, or given up on
 * after a while: a line can look open and carry nothing, and the screen that asked should hear so.
 */
function createReads() {
  const asking = new Map<string, Asking>();
  return {
    ask(socket: WebSocket, query: MobileQuery): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => {
          asking.delete(requestId);
          reject(new Error("Your computer did not answer in time."));
        }, QUERY_TIMEOUT_MS);
        asking.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ kind: "query", requestId, query }));
      });
    },
    answer(message: Extract<MobileServerMessage, { kind: "answer" }>) {
      const waiting = asking.get(message.requestId);
      if (!waiting) return;
      asking.delete(message.requestId);
      clearTimeout(waiting.timer);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(message.message));
    },
    /** Every read still waiting is refused: the line it was asked on is gone, and its answer with it. */
    refuseAll() {
      for (const [requestId, waiting] of [...asking]) {
        asking.delete(requestId);
        clearTimeout(waiting.timer);
        waiting.reject(new Error(MOBILE_QUERY_OFFLINE));
      }
    },
  };
}

/**
 * What the browser says about the phone coming back: the page shown again, the network changed or
 * returned, or gone altogether. Returns what stops listening.
 */
function listenForReturns(handlers: { shown: () => void; moved: () => void; lost: () => void }) {
  const network = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  document.addEventListener("visibilitychange", handlers.shown);
  window.addEventListener("pageshow", handlers.shown);
  window.addEventListener("online", handlers.moved);
  window.addEventListener("offline", handlers.lost);
  network?.addEventListener("change", handlers.moved);
  return () => {
    document.removeEventListener("visibilitychange", handlers.shown);
    window.removeEventListener("pageshow", handlers.shown);
    window.removeEventListener("online", handlers.moved);
    window.removeEventListener("offline", handlers.lost);
    network?.removeEventListener("change", handlers.moved);
  };
}

export function createMobileConnection({ url, initial, store, onState }: MobileConnectionOptions): MobileConnection {
  let state = initial;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let lastHeardAt = Date.now();
  let stopped = false;
  const reads = createReads();
  const reminder = setInterval(() => dispatch({ kind: "remind" }), MOBILE_RESEND_MS);

  function dispatch(event: MobileClientEvent) {
    if (stopped) return;
    const step = reduceMobileClient(state, event);
    state = step.state;
    onState(state);
    for (const effect of step.effects) perform(effect);
  }

  function perform(effect: MobileClientEffect) {
    if (effect.kind === "send") {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(effect.message));
    } else if (effect.kind === "store") writeCredential(store, effect.credential);
    else if (effect.kind === "keep") writeOutbox(store, effect.outbox);
    else if (effect.kind === "reload") reload();
    else if (effect.kind === "current") current();
    else if (effect.kind === "disconnect") drop();
    else if (effect.kind === "connect") schedule(effect.delayMs);
    else if (effect.kind === "settle") {
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => dispatch({ kind: "settled" }), effect.delayMs);
    }
  }

  function reload() {
    try {
      if (window.sessionStorage.getItem(RELOADED_KEY)) return;
      window.sessionStorage.setItem(RELOADED_KEY, "1");
    } catch {
      // Storage refused is no reason not to reload once.
    }
    window.location.reload();
  }

  function current() {
    try {
      window.sessionStorage.removeItem(RELOADED_KEY);
    } catch {
      // A guard that cannot be cleared only means the next build waits for a reload by hand.
    }
  }

  function disarm() {
    if (deadline) clearTimeout(deadline);
    deadline = null;
  }

  /** Closes the line without asking for another: a deliberate hang-up is not a dropped call. */
  function drop() {
    disarm();
    reads.refuseAll();
    const closing = socket;
    socket = null;
    if (!closing) return;
    closing.onopen = null;
    closing.onmessage = null;
    closing.onclose = null;
    closing.onerror = null;
    closing.close();
  }

  function schedule(delayMs: number) {
    if (retry) clearTimeout(retry);
    retry = setTimeout(open, delayMs);
  }

  /** Silence for longer than the server's own ping interval allows means the line is gone. */
  function watch() {
    lastHeardAt = Date.now();
    arm(STALE_AFTER_MS);
  }

  function arm(delayMs: number) {
    disarm();
    deadline = setTimeout(() => {
      const dead = socket;
      drop();
      if (dead) dispatch({ kind: "closed" });
    }, delayMs);
  }

  function open() {
    if (stopped || socket) return;
    const opening = new WebSocket(url);
    socket = opening;
    /** A dial that hangs is cut like a line that went quiet, so a wake can dial afresh. */
    arm(CONNECT_TIMEOUT_MS);
    opening.onopen = () => {
      watch();
      dispatch({ kind: "opened", at: Date.now() });
    };
    opening.onmessage = (event) => {
      watch();
      const { message, sequence } = parse(event.data);
      if (!message) {
        if (sequence !== null) dispatch({ kind: "skipped", sequence });
        return;
      }
      if (message.kind === "answer") reads.answer(message);
      dispatch({ kind: "received", message });
    };
    opening.onclose = () => {
      if (socket !== opening) return;
      disarm();
      socket = null;
      reads.refuseAll();
      dispatch({ kind: "closed" });
    };
    opening.onerror = () => opening.close();
  }

  /**
   * The phone came back to the page. A line silent too long, or no longer open, is redialled now; one
   * that looks fine is asked whether it still carries anything, and cut if it does not answer soon.
   */
  function wake() {
    if (document.visibilityState === "hidden") return;
    const stale = socket !== null && (socket.readyState !== WebSocket.OPEN || Date.now() - lastHeardAt > STALE_AFTER_MS);
    dispatch({ kind: "wake", stale });
    probe();
  }

  function probe() {
    if (socket?.readyState !== WebSocket.OPEN || state.connection !== "live") return;
    socket.send(JSON.stringify({ kind: "ping", at: Date.now() }));
    arm(PROBE_MS);
  }

  /** The network moved: whatever socket is held rode on the old one, so it is redialled now. */
  function moved() {
    if (document.visibilityState === "hidden" && !navigator.onLine) return;
    dispatch({ kind: "wake", stale: socket !== null });
  }

  /** No network at all: the line is down now, whatever the socket has yet to notice. */
  function lost() {
    if (!socket) return;
    drop();
    dispatch({ kind: "closed" });
  }

  const unlisten = listenForReturns({ shown: wake, moved, lost });
  open();

  return {
    send(command) {
      dispatch({ kind: "dispatch", requestId: crypto.randomUUID(), command, at: Date.now() });
    },
    query(query) {
      if (stopped || state.connection !== "live" || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error(MOBILE_QUERY_OFFLINE));
      return reads.ask(socket, query);
    },
    dismissNotice() {
      dispatch({ kind: "dismiss-notice" });
    },
    stop() {
      stopped = true;
      unlisten();
      clearInterval(reminder);
      for (const timer of [retry, settle]) if (timer) clearTimeout(timer);
      drop();
    },
  };
}

/** The frame as a message, or, for one this page cannot read, at least where it sat in the numbering. */
function parse(data: unknown): { message: MobileServerMessage | null; sequence: number | null } {
  if (typeof data !== "string") return { message: null, sequence: null };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { message: null, sequence: null };
  }
  if (isMobileServerMessage(value)) return { message: value, sequence: value.sequence };
  const sequence = (value as { sequence?: unknown } | null)?.sequence;
  return { message: null, sequence: typeof sequence === "number" && Number.isInteger(sequence) && sequence > 0 ? sequence : null };
}
