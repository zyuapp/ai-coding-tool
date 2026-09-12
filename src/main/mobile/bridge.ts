import { powerSaveBlocker } from "electron";
import type { MobileResponse, MobileViewUpdate } from "../../contracts/mobile.js";
import type { MobileServerState } from "../../domain/mobile.js";
import type { DesktopEvents } from "../desktop-events.js";
import type * as MobileHost from "./mobile-host.mjs" with { "resolution-mode": "import" };

/** What the bridge needs from the app: where to raise what a phone sends, and where files live. */
export type MobileBridgeHost = {
  events: DesktopEvents;
  userData: string;
  developmentRoot?: string;
  /** The built phone page. */
  staticRoot: string;
};

let app: MobileBridgeHost | null = null;
let host: typeof MobileHost | null = null;
let awake: number | null = null;
/** A replacement window starts its phone host only after the previous host has stopped. */
let lifecycle: Promise<void> = Promise.resolve();

/** The server lives in an ES module of its own, so `ws` is only loaded when the bridge is wired up. */
async function loaded() {
  if (!host) host = await import("./mobile-host.mjs");
  return host;
}

function publishState(owner: MobileBridgeHost, state: MobileServerState) {
  if (app !== owner) return;
  owner.events.emit("mobile:changed", state);
  keepAwake(state.sessions.length > 0);
}

/**
 * A phone on the line is a user at the keyboard, so the Mac may not sleep out from under it. Every
 * session counts, not only the connected ones: a phone that locks its screen mid-run drops its
 * socket, and letting the Mac sleep then would kill the run that phone is waiting on. A session
 * outlives its socket by five minutes, which is the window this holds the machine awake for.
 *
 * This is idle sleep only. Nothing an application can assert keeps a Mac awake with the lid shut.
 */
function keepAwake(needed: boolean) {
  if (needed === (awake !== null)) return;
  if (needed) {
    awake = powerSaveBlocker.start("prevent-app-suspension");
    return;
  }
  if (awake !== null && powerSaveBlocker.isStarted(awake)) powerSaveBlocker.stop(awake);
  awake = null;
}

export function startMobileBridge(options: MobileBridgeHost) {
  app = options;
  lifecycle = lifecycle.catch(() => undefined).then(async () => {
    if (app !== options) return;
    const mobile = await loaded();
    if (app !== options) return;
    await mobile.startMobileHost({
      userData: options.userData,
      developmentRoot: options.developmentRoot,
      staticRoot: options.staticRoot,
      send: (request) => app === options && options.events.emit("mobile:request", request),
      onState: (state) => publishState(options, state),
    });
  });
  return lifecycle;
}

export function stopMobileBridge() {
  app = null;
  keepAwake(false);
  lifecycle = lifecycle.catch(() => undefined).then(async () => {
    await host?.stopMobileHost();
  });
  return lifecycle;
}

async function readyHost() {
  await lifecycle;
  return loaded();
}

/** The runtime reads and changes the bridge, answers what a phone asked, and pushes what a phone should see. */
export const mobileBridge = {
  state: async () => (await readyHost()).mobileState(),
  setEnabled: async (enabled: boolean) => (await readyHost()).setMobileEnabled(enabled),
  createPairingCode: async () => (await readyHost()).createMobilePairingCode(),
  revokeDevice: async (deviceId: string) => (await readyHost()).revokeMobileDevice(deviceId),
  refreshTailscale: async () => (await readyHost()).refreshTailscale(),
  answer: (response: MobileResponse) => host?.answerMobileRequest(response),
  publish: (update: MobileViewUpdate) => host?.publishMobileView(update),
};
