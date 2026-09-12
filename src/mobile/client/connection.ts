import { isMobileServerMessage, type MobileCommand, type MobileQuery } from "../../contracts/mobile";
import { MOBILE_DEAD_AFTER_MS, MOBILE_PING_INTERVAL_MS } from "../../domain/mobile";
import { reduceMobileClient, type MobileClientEffect, type MobileClientEvent, type MobileClientState } from "./protocol";
import { writeCredential, type CredentialStore } from "./storage";

/** How long a dial may sit unanswered. A phone whose tunnel is not back yet would otherwise wait on the browser's own minute. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Silence past this on a line that claims to be open means the phone slept through the Mac's pings. */
const STALE_AFTER_MS = MOBILE_PING_INTERVAL_MS + 5_000;

/** Set for the page's lifetime once it has reloaded itself for a version refusal, so two stale builds cannot chase each other. */
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

type Asking = { resolve: (result: unknown) => void; reject: (error: Error) => void };

export type MobileConnectionOptions = {
  url: string;
  initial: MobileClientState;
  store: CredentialStore;
  onState: (state: MobileClientState) => void;
};

export function createMobileConnection({ url, initial, store, onState }: MobileConnectionOptions): MobileConnection {
  let state = initial;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let lastHeardAt = Date.now();
  let stopped = false;
  const asking = new Map<string, Asking>();

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
    else if (effect.kind === "reload") reload();
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

  function disarm() {
    if (deadline) clearTimeout(deadline);
    deadline = null;
  }

  /** Every read still waiting is refused: the line it was asked on is gone, and its answer with it. */
  function refuseAll() {
    for (const [requestId, waiting] of [...asking]) {
      asking.delete(requestId);
      waiting.reject(new Error(MOBILE_QUERY_OFFLINE));
    }
  }

  /** Closes the line without asking for another: a deliberate hang-up is not a dropped call. */
  function drop() {
    disarm();
    refuseAll();
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
    arm(MOBILE_DEAD_AFTER_MS);
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
      dispatch({ kind: "opened" });
    };
    opening.onmessage = (event) => {
      watch();
      const message = parse(event.data);
      if (!message) return;
      if (message.kind === "answer") {
        const waiting = asking.get(message.requestId);
        asking.delete(message.requestId);
        if (message.ok) waiting?.resolve(message.result);
        else waiting?.reject(new Error(message.message));
      }
      dispatch({ kind: "received", message });
    };
    opening.onclose = () => {
      if (socket !== opening) return;
      disarm();
      socket = null;
      refuseAll();
      dispatch({ kind: "closed" });
    };
    opening.onerror = () => opening.close();
  }

  function wake() {
    if (document.visibilityState === "hidden") return;
    const stale = socket !== null && Date.now() - lastHeardAt > STALE_AFTER_MS;
    dispatch({ kind: "wake", stale });
  }

  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
  open();

  return {
    send(command) {
      dispatch({ kind: "dispatch", requestId: crypto.randomUUID(), command });
    },
    query(query) {
      return new Promise((resolve, reject) => {
        if (stopped || state.connection !== "live" || socket?.readyState !== WebSocket.OPEN) {
          reject(new Error(MOBILE_QUERY_OFFLINE));
          return;
        }
        const requestId = crypto.randomUUID();
        asking.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ kind: "query", requestId, query }));
      });
    },
    dismissNotice() {
      dispatch({ kind: "dismiss-notice" });
    },
    stop() {
      stopped = true;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      for (const timer of [retry, settle]) if (timer) clearTimeout(timer);
      drop();
    },
  };
}

function parse(data: unknown) {
  if (typeof data !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  return isMobileServerMessage(value) ? value : null;
}
