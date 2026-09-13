import { queryDirectories } from "./computer-queries.js";
import { app, dialog, shell, type BrowserWindow } from "electron";
import type { ComputerDesktop, RuntimeDesktop } from "../host/runtime-desktop.js";
import type { ComputerLinks } from "./computers/computer-links.mjs" with { "resolution-mode": "import" };
import { computerUsePermissions, requestComputerUsePermission } from "./computer-use-host.js";
import { announceThread, type NoticeHost } from "./desktop-notice.js";
import { downloadImage } from "./image-download.js";
import type { KeyboardBridge } from "./keyboard-host.js";
import { openSourceLicenses } from "./license-window.js";
import { mobileBridge } from "./mobile/bridge.js";
import { listInstalledApps, openFolderInApp } from "./open-in-app.js";
import { openInEditor } from "./open-in-editor.js";
import { serviceDesktop, type ServiceDesktopHost } from "./service-desktop.js";
import { checkForUpdates, type UpdateHost } from "./updates.js";
import * as browser from "./browser-host.js";

/** What the desktop adds to the services: the window, and everything only a window can do. */
export type RuntimeDesktopHost = Omit<ServiceDesktopHost, "openUrl" | "computerUse"> & {
  window: () => BrowserWindow | null;
  notices: NoticeHost;
  updates: UpdateHost;
  keyboard: KeyboardBridge;
  restart: () => void;
  computers: () => ComputerLinks;
};

/** The other computers, held by the links this process keeps open to them. */
function computerDesktop(host: RuntimeDesktopHost): ComputerDesktop {
  const { events } = host;
  return {
    discoverComputers: () => host.computers().discover(),
    pairComputer: (address, name, code) => host.computers().pair(address, name, code),
    forgetComputer: (id) => host.computers().forget(id),
    renameComputer: async (name) => {
      host.computers().rename(name);
      await mobileBridge.announceName();
    },
    labelComputer: async (id, name) => host.computers().label(id, name),
    sendToComputer: (id, inputs) => host.computers().send(id, inputs),
    onComputersChanged: (listener) => events.on("computers:changed", ({ name, links }) => listener(name, links)),
    onComputerState: (listener) => events.on("computer:state", ({ id, state }) => listener(id, state)),
    onComputerNotice: (listener) => events.on("computer:notice", ({ id, notice }) => listener(id, notice)),
  };
}

/** The browser panel, whose pages live in this process beside the window they are shown in. */
function panelDesktop(host: RuntimeDesktopHost) {
  const { events } = host;
  return {
    configureBrowserPermissions: async (permissions) => browser.configurePermissions(permissions),
    openBrowserTab: async (tabId, url, taskId) => browser.openTab(tabId, url, taskId),
    navigateBrowser: async (tabId, url, taskId) => browser.navigate(tabId, url, taskId),
    browserHistory: async (tabId, delta, taskId) => browser.goHistory(tabId, delta, taskId),
    reloadBrowser: async (tabId, taskId) => browser.reload(tabId, taskId),
    closeBrowserTab: async (tabId) => browser.closeTab(tabId),
    showBrowserTab: async (tabId) => browser.showTab(tabId),
    actInBrowser: (tabId, action, taskId) => browser.act(tabId, action, taskId),
    readBrowserPage: (tabId, textLimit, timeoutMs, taskId) => browser.readPage(tabId, textLimit, timeoutMs, taskId),
    inspectBrowserPage: (tabId, inspection, taskId) => browser.inspectPage(tabId, inspection, taskId),
    captureBrowserPage: (tabId, fullPage, timeoutMs, taskId) => browser.capturePage(tabId, fullPage, timeoutMs, taskId),
    clearBrowserData: () => browser.clearData(),
    onBrowserEvent: (listener) => events.on("browser:event", listener),
    findInPage: async (tabId, query, forward, findNext) => browser.findInPage(tabId, query, { forward, findNext }),
    stopFindInPage: async (tabId) => browser.stopFindInPage(tabId),
    focusBrowserTab: async (tabId) => browser.focusTab(tabId),
    onBrowserFind: (listener) => events.on("browser:find", listener),
  } satisfies Partial<RuntimeDesktop>;
}

/** The window itself, its keys, the desktop around it, and the phone bridge it keeps awake for. */
function windowDesktop(host: RuntimeDesktopHost) {
  const { events } = host;
  return {
    directories: (prefix, computerId) => queryDirectories(prefix, computerId, (id, query) => host.computers().query(id, query)),
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
    checkForUpdates: () => { void checkForUpdates(host.updates, { userRequested: true }).catch((error) => console.error("Update check failed:", error)); },
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
    /** A page in the panel holds the keyboard until the window asks for it back. */
    focusWindow: () => host.window()?.webContents.focus(),
    announceThread: (notice) => announceThread(host.notices, notice),
    setBadgeCount: (count) => app.setBadgeCount(count),
  } satisfies Partial<RuntimeDesktop>;
}

/** The runtime's desktop, answered in the process that owns every service it names. */
export function createRuntimeDesktop(host: RuntimeDesktopHost): RuntimeDesktop {
  const services = serviceDesktop({
    ...host,
    openUrl: (url) => shell.openExternal(url),
    computerUse: { permissions: computerUsePermissions, enable: requestComputerUsePermission },
  });
  return { ...services, ...panelDesktop(host), ...windowDesktop(host), ...computerDesktop(host) };
}
