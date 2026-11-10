import { app, dialog, shell, type BrowserWindow } from "electron";
import type { ComputerDesktop, RuntimeDesktop } from "../host/runtime-desktop.js";
import type { ComputerLinks } from "./computers/computer-links.mjs" with { "resolution-mode": "import" };
import { computerUsePermissions, requestComputerUsePermission } from "./computer-use-host.js";
import { announceThread, desktopAway, type NoticeHost } from "./desktop-notice.js";
import { setUnreadBadge } from "./dock-menu.js";
import { downloadImage } from "./image-download.js";
import type { KeyboardBridge } from "./keyboard-host.js";
import { openSourceLicenses } from "./license-window.js";
import { mobileBridge } from "./mobile/bridge.js";
import { listInstalledApps, openFolderInApp } from "./open-in-app.js";
import { openInEditor } from "./open-in-editor.js";
import { serviceDesktop, type ServiceDesktopHost } from "./service-desktop.js";
import * as updates from "./updates.js";
import type { UpdateHost } from "./updates.js";
import { updateDesktop } from "./update-desktop.js";
import * as browser from "./browser-host.js";
import * as simulator from "./simulator-host.js";
import { dictationDesktop } from "./dictation-host.js";
import { desktopDictation } from "./desktop-dictation.js";
import * as browserImport from "./browser-import.js";
import { browserDesktop } from "./browser-desktop.js";
import { simulatorDesktop } from "./simulator-desktop.js";

/** What the desktop adds to the services: the window, and everything only a window can do. */
export type RuntimeDesktopHost = Omit<ServiceDesktopHost, "openUrl" | "computerUse"> & {
  window: () => BrowserWindow | null;
  notices: NoticeHost;
  updates: UpdateHost;
  /** The version this launch updated the app to, or null when it is not the first launch since one. */
  launchedUpdate: string | null;
  keyboard: KeyboardBridge;
  restart: () => void;
  computers: () => Promise<ComputerLinks>;
};

/** The other computers, held by the links this process keeps open to them. */
function computerDesktop(host: RuntimeDesktopHost): ComputerDesktop {
  const { events } = host;
  return {
    discoverComputers: async () => (await host.computers()).discover(),
    pairComputer: async (address, name, code) => (await host.computers()).pair(address, name, code),
    forgetComputer: async (id) => (await host.computers()).forget(id),
    reconnectComputer: async (id) => (await host.computers()).reconnect(id),
    renameComputer: async (name) => {
      (await host.computers()).rename(name);
      await mobileBridge.announceName();
    },
    labelComputer: async (id, name) => (await host.computers()).label(id, name),
    sendToComputer: async (id, inputs) => (await host.computers()).send(id, inputs),
    queryComputerThreads: (id, query) => host.reads.read(query, { computer: id }),
    onComputersChanged: (listener) => events.on("computers:changed", ({ name, links }) => listener(name, links)),
    onComputerState: (listener) => events.on("computer:state", ({ id, state }) => listener(id, state)),
    onComputerNotice: (listener) => events.on("computer:notice", ({ id, notice }) => listener(id, notice)),
  };
}

/** The window itself, its keys, the desktop around it, and the phone bridge it keeps awake for. */
function windowDesktop(host: RuntimeDesktopHost) {
  const { events } = host;
  return {
    openFolder: async () => {
      const window = host.window();
      const options = { properties: ["openDirectory", "createDirectory"] as const, title: "Open a project folder" };
      const result = await (window ? dialog.showOpenDialog(window, { ...options, properties: [...options.properties] }) : dialog.showOpenDialog({ ...options, properties: [...options.properties] }));
      if (result.canceled || !result.filePaths[0]) return null;
      return (await host.workspaces().registerProject(result.filePaths[0])).workspace;
    },
    revealWorktree: async (root) => { shell.showItemInFolder(await host.worktrees().ownedPath(root)); },
    restartForComputerUse: () => {
      host.restart();
      app.quit();
    },
    downloadImage: async (source) => {
      const window = host.window();
      if (!window) throw new Error("There is no window to save into.");
      await downloadImage(window, source);
    },
    openSourceLicenses: () => openSourceLicenses(host.window()),
    mobileState: () => mobileBridge.state(),
    setMobileEnabled: (enabled) => mobileBridge.setEnabled(enabled),
    createMobilePairingCode: () => mobileBridge.createPairingCode(),
    revokeMobileDevice: (deviceId) => mobileBridge.revokeDevice(deviceId),
    refreshTailscale: () => mobileBridge.refreshTailscale(),
    onMobileState: (listener) => events.on("mobile:changed", listener),
    onMobileRequest: (listener) => events.on("mobile:request", listener),
    answerMobileRequest: (response) => mobileBridge.answer(response),
    publishMobileView: (update) => mobileBridge.publish(update),
    openFile: async (roots, candidate, line) => {
      const { openableFile } = await import("./path-policy.mjs");
      await openInEditor(await openableFile(roots, candidate), line);
    },
    listApps: () => listInstalledApps(),
    openFolderInApp: async (appId, root) => {
      const { fileInCheckout } = await import("./path-policy.mjs");
      await openFolderInApp(appId, await fileInCheckout(root, "."));
    },
    setCaptureOptions: (options) => host.keyboard.setCaptureOptions(options),
    setShortcuts: (overrides) => {
      host.keyboard.setShortcuts(overrides);
      host.keyboard.claimDesktopShortcut();
    },
    setShortcutCapture: (capturing) => {
      host.keyboard.setCapturing(capturing);
      /** A keystroke the desktop is holding never reaches the window, so settings cannot read it back. */
      if (capturing) host.keyboard.releaseDesktopShortcut();
      else host.keyboard.claimDesktopShortcut();
    },
    closeWindow: () => host.window()?.close(),
    /**
     * A page in the panel holds the keyboard until the window asks for it back. Only a window that is
     * already in front takes it, since focusing one that is not raises it over whatever the user is in.
     */
    focusWindow: () => {
      const window = host.window();
      if (window?.isFocused()) window.webContents.focus();
    },
    /** The phone is told only when the user has stepped away from this computer, where the desktop already says it. */
    announceThread: (notice) => {
      announceThread(host.notices, notice);
      if (desktopAway()) void mobileBridge.notifyPhones(notice);
    },
    setBadgeCount: setUnreadBadge,
  } satisfies Partial<RuntimeDesktop>;
}

/** The runtime's desktop, answered in the process that owns every service it names. */
export function createRuntimeDesktop(host: RuntimeDesktopHost): RuntimeDesktop {
  const services = serviceDesktop({
    ...host,
    openUrl: (url) => shell.openExternal(url),
    computerUse: { permissions: computerUsePermissions, enable: requestComputerUsePermission },
  });
  return {
    ...services,
    ...browserDesktop(browser, browserImport, host.events),
    ...simulatorDesktop(simulator),
    ...dictationDesktop(desktopDictation),
    ...updateDesktop(updates, host),
    ...windowDesktop(host),
    ...computerDesktop(host),
  };
}
