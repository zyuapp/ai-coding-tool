import { noComputers } from "../host/no-computers.js";
import type { RuntimeDesktop } from "../host/runtime-desktop.js";
import type * as MobileHost from "./mobile/mobile-host.mjs" with { "resolution-mode": "import" };
import { serviceDesktop, type ServiceDesktopHost } from "./service-desktop.js";

/** What a headless host adds to the services: the phone bridge it runs itself, and a place to say things. */
export type ServeDesktopHost = Omit<ServiceDesktopHost, "openUrl" | "computerUse"> & {
  mobile: () => typeof MobileHost;
  say: (line: string) => void;
};

function needsDesktop(what: string) {
  return async (): Promise<never> => { throw new Error(`${what} needs the desktop app.`); };
}

/** Nothing is drawn here: the window's own effects are dropped, and what only a window can do is refused. */
function headlessDesktop(host: ServeDesktopHost) {
  const { events } = host;
  const nothing = () => {};
  const unsubscribed = () => () => {};
  return {
    openFolder: needsDesktop("Picking a folder"),
    revealWorktree: needsDesktop("Revealing a checkout"),
    restartForComputerUse: nothing,
    downloadImage: needsDesktop("Saving an image"),
    checkForUpdates: nothing,
    openSourceLicenses: needsDesktop("The licenses page"),
    mobileState: async () => host.mobile().mobileState(),
    setMobileEnabled: (enabled) => host.mobile().setMobileEnabled(enabled),
    createMobilePairingCode: () => host.mobile().createMobilePairingCode(),
    revokeMobileDevice: (deviceId) => host.mobile().revokeMobileDevice(deviceId),
    refreshTailscale: () => host.mobile().refreshTailscale(),
    onMobileState: (listener) => events.on("mobile:changed", listener),
    onMobileRequest: (listener) => events.on("mobile:request", listener),
    answerMobileRequest: (response) => host.mobile().answerMobileRequest(response),
    publishMobileView: (update) => host.mobile().publishMobileView(update),
    configureBrowserPermissions: async () => {},
    openBrowserTab: needsDesktop("The browser panel"),
    navigateBrowser: needsDesktop("The browser panel"),
    browserHistory: needsDesktop("The browser panel"),
    reloadBrowser: needsDesktop("The browser panel"),
    closeBrowserTab: async () => {},
    showBrowserTab: async () => {},
    actInBrowser: needsDesktop("The browser panel"),
    readBrowserPage: async () => null,
    inspectBrowserPage: async () => null,
    captureBrowserPage: async () => null,
    clearBrowserData: async () => {},
    onBrowserEvent: unsubscribed,
    findInPage: async () => {},
    stopFindInPage: async () => {},
    focusBrowserTab: async () => {},
    onBrowserFind: unsubscribed,
    openFile: needsDesktop("Opening a file"),
    listApps: async () => [],
    openFolderInApp: needsDesktop("Opening a folder in an application"),
    setCaptureOptions: nothing,
    setShortcuts: nothing,
    setShortcutCapture: nothing,
    closeWindow: nothing,
    focusWindow: nothing,
    announceThread: nothing,
    setBadgeCount: nothing,
  } satisfies Partial<RuntimeDesktop>;
}

/** The runtime's desktop on a machine with no desktop: the services, and refusals for the rest. */
export function createServeDesktop(host: ServeDesktopHost): RuntimeDesktop {
  const services = serviceDesktop({
    ...host,
    openUrl: async (url) => { host.say(`Sign in at ${url}`); },
    computerUse: {
      permissions: async () => ({ accessibility: false, screenRecording: false }),
      enable: async () => ({ accessibility: false, screenRecording: false }),
    },
  });
  return { ...services, ...headlessDesktop(host), ...noComputers };
}
