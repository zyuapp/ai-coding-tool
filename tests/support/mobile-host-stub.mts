import { emptyMobileServerState, type MobileServerState } from "../../src/domain/mobile.js";

/**
 * Stands in for the phone bridge's server module while the main process boots. The real one shells
 * out to whatever Tailscale the developer's Mac is running, and its import is still in flight when a
 * test tears the module runner down, which is what printed "Could not start the phone bridge".
 */
export function fakeMobileHost() {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const state: MobileServerState = emptyMobileServerState();
  const host = {
    startMobileHost: async () => { started(); },
    stopMobileHost: async () => {},
    mobileState: () => state,
    mobileBridgeHolding: () => false,
    mobileWindowGone: () => {},
    setMobileEnabled: async () => state,
    setMobileLanExposed: async () => state,
    createMobilePairingCode: async () => null,
    revokeMobileDevice: async () => state,
    setTailscaleServe: async () => state,
    refreshTailscale: async () => state,
    answerMobileRequest: () => {},
    publishMobileView: () => {},
  };
  return { running, host };
}

export type FakeMobileHost = ReturnType<typeof fakeMobileHost>["host"];

/** The names `bridge.ts` reaches for, re-exported from the global the harness parks the stub on. */
export const MOBILE_HOST_MODULE = `const h = globalThis.__aicodingtoolMobileHost; export const ${[
  "startMobileHost",
  "stopMobileHost",
  "mobileState",
  "mobileBridgeHolding",
  "mobileWindowGone",
  "setMobileEnabled",
  "setMobileLanExposed",
  "createMobilePairingCode",
  "revokeMobileDevice",
  "setTailscaleServe",
  "refreshTailscale",
  "answerMobileRequest",
  "publishMobileView",
].map((name) => `${name}=h.${name}`).join(", ")};`;
