import { useEffect, useMemo, useRef, useState } from "react";
import type { MobileCommand, MobileQuery } from "../../contracts/mobile";
import { createMobileConnection, type MobileConnection } from "./connection";
import { initialMobileClient, type MobileClientState } from "./protocol";
import { deviceName, readCredential, readPairingCode, socketUrl, withoutPairingCode } from "./storage";

/**
 * The connection held for as long as the page is open. The pairing code is taken out of the address
 * before anything else happens, so a reload cannot try to spend a code that is already gone.
 */
export type MobileClient = {
  state: MobileClientState;
  send: (command: MobileCommand) => void;
  query: (query: MobileQuery) => Promise<unknown>;
  dismissNotice: () => void;
};

export function useMobileClient(): MobileClient {
  const start = useMemo(() => {
    const code = readPairingCode(window.location.href);
    const url = socketUrl(window.location.href);
    if (code) window.history.replaceState(null, "", withoutPairingCode(window.location.href));
    return { url, state: initialMobileClient({ credential: readCredential(window.localStorage), code, deviceName: deviceName(navigator.userAgent) }) };
  }, []);
  const [state, setState] = useState(start.state);
  const connection = useRef<MobileConnection | null>(null);

  useEffect(() => {
    const live = createMobileConnection({ url: start.url, initial: start.state, store: window.localStorage, onState: setState });
    connection.current = live;
    return () => {
      connection.current = null;
      live.stop();
    };
  }, [start]);

  /** The three verbs never change identity: a screen that keys an effect on `query` must not re-ask on every frame. */
  const verbs = useMemo(() => ({
    send: (command: MobileCommand) => connection.current?.send(command),
    query: (query: MobileQuery) => connection.current?.query(query) ?? Promise.reject(new Error("Not connected to your computer.")),
    dismissNotice: () => connection.current?.dismissNotice(),
  }), []);

  return useMemo(() => ({ state, ...verbs }), [state, verbs]);
}
