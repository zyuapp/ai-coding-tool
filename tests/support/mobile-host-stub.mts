import { emptyMobileServerState, type MobileServerState } from "../../src/domain/mobile.js";
import type { MobileHostOptions } from "../../src/main/mobile/mobile-host.mjs";

/**
 * Stands in for the phone bridge's server module while the main process boots. The real one shells
 * out to whatever Tailscale the developer's Mac is running, and its import is still in flight when a
 * test tears the module runner down, which is what printed "Could not start the phone bridge".
 */
export function fakeMobileHost() {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const state: MobileServerState = emptyMobileServerState();
  const starts: MobileHostOptions[] = [];
  let stops = 0;
  const host = {
    startMobileHost: async (options: MobileHostOptions) => { starts.push(options); started(); },
    stopMobileHost: async () => { stops += 1; },
    mobileState: () => state,
    setMobileEnabled: async () => state,
    createMobilePairingCode: async () => null,
    revokeMobileDevice: async () => state,
    refreshTailscale: async () => state,
    answerMobileRequest: () => {},
    publishMobileView: () => {},
  };
  return { running, host, starts, stops: () => stops };
}

export type FakeMobileHost = ReturnType<typeof fakeMobileHost>["host"];

/** The names `bridge.ts` reaches for, re-exported from the global the harness parks the stub on. */
export const MOBILE_HOST_MODULE = `const h = globalThis.__aicodingtoolMobileHost; export const ${[
  "startMobileHost",
  "stopMobileHost",
  "mobileState",
  "setMobileEnabled",
  "createMobilePairingCode",
  "revokeMobileDevice",
  "refreshTailscale",
  "answerMobileRequest",
  "publishMobileView",
].map((name) => `${name}=h.${name}`).join(", ")};`;
