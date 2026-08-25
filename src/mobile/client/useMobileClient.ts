import { useEffect, useMemo, useRef, useState } from "react";
import type { MobileCommand } from "../../contracts/mobile";
import { createMobileConnection, type MobileConnection } from "./connection";
import { initialMobileClient, type MobileClientState } from "./protocol";
import { deviceName, readCredential, readPairingCode, socketUrl, withoutPairingCode } from "./storage";

/**
 * The connection held for as long as the page is open. The pairing code is taken out of the address
 * before anything else happens, so a reload cannot try to spend a code that is already gone.
 */
export function useMobileClient(): { state: MobileClientState; send: (command: MobileCommand) => void; dismissNotice: () => void } {
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

  return useMemo(() => ({
    state,
    send: (command: MobileCommand) => connection.current?.send(command),
    dismissNotice: () => connection.current?.dismissNotice(),
  }), [state]);
}
