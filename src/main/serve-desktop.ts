import type { AppBuild } from "../domain/app-update.js";
import { noComputers } from "../host/no-computers.js";
import type { RuntimeDesktop } from "../host/runtime-desktop.js";
import type * as MobileHost from "./mobile/mobile-host.mjs" with { "resolution-mode": "import" };
import { serviceDesktop, type ServiceDesktopHost } from "./service-desktop.js";
import { dictationDesktop, type DictationHost } from "./dictation-host.js";
import { headlessBrowserDesktop } from "./browser-desktop.js";
import { needsDesktop, nothing } from "./headless.js";
import { headlessSimulatorDesktop } from "./simulator-desktop.js";
import { headlessUpdateDesktop } from "./update-desktop.js";
import type { ServeUpdater } from "./serve-updates.js";

/** What a headless host adds to the services: the phone bridge it runs itself, and a place to say things. */
export type ServeDesktopHost = Omit<ServiceDesktopHost, "openUrl" | "computerUse"> & {
  mobile: () => typeof MobileHost;
  say: (line: string) => void;
  /** Transcribes a phone's recordings; there is no microphone to hold here. */
  dictation: DictationHost;
  build: AppBuild | null;
  /** Absent where this server cannot replace its own app. */
  updates: ServeUpdater | null;
  /** The version this start updated the app to, or null when it is not the first since one. */
  launchedUpdate: string | null;
};

/** Nothing is drawn here: the window's own effects are dropped, and what only a window can do is refused. */
function headlessDesktop(host: ServeDesktopHost) {
  const { events } = host;
  return {
    openFolder: needsDesktop("Picking a folder"),
    revealWorktree: needsDesktop("Revealing a checkout"),
    restartForComputerUse: nothing,
    downloadImage: needsDesktop("Saving an image"),
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
    openFile: needsDesktop("Opening a file"),
    listApps: async () => [],
    openFolderInApp: needsDesktop("Opening a folder in an application"),
    setCaptureOptions: nothing,
    setShortcuts: nothing,
    setShortcutCapture: nothing,
    closeWindow: nothing,
    focusWindow: nothing,
    /** A computer with no desktop has nobody at it, so a phone is always told. */
    announceThread: (notice) => {
      host.mobile().noticeComputers(notice);
      void host.mobile().noticePhones(notice);
    },
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
  return {
    ...services,
    ...headlessBrowserDesktop,
    ...headlessSimulatorDesktop,
    ...dictationDesktop(() => host.dictation),
    ...headlessUpdateDesktop(host),
    ...headlessDesktop(host),
    ...noComputers,
  };
}
