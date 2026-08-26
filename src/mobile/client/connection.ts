import { isMobileServerMessage, type MobileCommand } from "../../contracts/mobile";
import { MOBILE_DEAD_AFTER_MS } from "../../domain/mobile";
import { reduceMobileClient, type MobileClientEffect, type MobileClientEvent, type MobileClientState } from "./protocol";
import { writeCredential, type CredentialStore } from "./storage";

/**
 * The one impure part: a socket, three timers, and the two things a phone does that a desktop does
 * not — sleep and lose its network. Every decision it takes comes from {@link reduceMobileClient};
 * this only performs what that asks for and feeds back what it hears.
 */
export type MobileConnection = {
  send: (command: MobileCommand) => void;
  dismissNotice: () => void;
  stop: () => void;
};

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
  let stopped = false;

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
    else if (effect.kind === "reload") window.location.reload();
    else if (effect.kind === "disconnect") drop();
    else if (effect.kind === "connect") schedule(effect.delayMs);
    else if (effect.kind === "settle") {
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => dispatch({ kind: "settled" }), effect.delayMs);
    }
  }

  /** Closes the line without asking for another: a deliberate hang-up is not a dropped call. */
  function drop() {
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
    if (deadline) clearTimeout(deadline);
    deadline = setTimeout(() => {
      const dead = socket;
      drop();
      if (dead) dispatch({ kind: "closed" });
    }, MOBILE_DEAD_AFTER_MS);
  }

  function open() {
    if (stopped || socket) return;
    const opening = new WebSocket(url);
    socket = opening;
    opening.onopen = () => {
      watch();
      dispatch({ kind: "opened" });
    };
    opening.onmessage = (event) => {
      watch();
      const message = parse(event.data);
      if (message) dispatch({ kind: "received", message });
    };
    opening.onclose = () => {
      if (socket !== opening) return;
      socket = null;
      dispatch({ kind: "closed" });
    };
    opening.onerror = () => opening.close();
  }

  function wake() {
    if (document.visibilityState === "hidden") return;
    dispatch({ kind: "wake" });
  }

  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
  open();

  return {
    send(command) {
      dispatch({ kind: "dispatch", requestId: crypto.randomUUID(), command });
    },
    dismissNotice() {
      dispatch({ kind: "dismiss-notice" });
    },
    stop() {
      stopped = true;
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      for (const timer of [retry, settle, deadline]) if (timer) clearTimeout(timer);
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
