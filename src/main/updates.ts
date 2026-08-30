import { app, dialog, shell, type BrowserWindow } from "electron";
import type { AppUpdater } from "electron-updater";
import { automaticUpdatesAvailable, manualUpdateRecovery } from "./platform-capabilities.js";

const RELEASES_URL = "https://github.com/zyuapp/ai-coding-tool/releases/latest";

export type UpdateHost = {
  /** Read when a dialog is shown rather than when the check starts, so a replaced window still gets it. */
  window: () => BrowserWindow | null;
  /** Told before the app quits to install, so the shutdown is not read as a restart request. */
  onInstall: () => void;
};

let updater: AppUpdater | null = null;
let checking: Promise<void> | null = null;
/** An update the user put off, offered again the next time they ask rather than downloaded twice. */
let downloadedVersion: string | null = null;
/** A failed background check stays in the log; one the user asked for is theirs to hear about. */
let announceFailure = false;
let userChecks = 0;

async function updaterFor(host: UpdateHost) {
  if (updater) return updater;
  const { autoUpdater } = (await import("electron-updater")).default;
  autoUpdater.autoDownload = false;
  autoUpdater.on("error", (error) => {
    console.error("Update error:", error);
    if (announceFailure || userChecks > 0) void reportUpdateFailure(host.window(), error);
  });
  autoUpdater.on("update-available", ({ version }) => void offerDownload(host, version));
  autoUpdater.on("update-downloaded", ({ version }) => {
    downloadedVersion = version;
    void offerInstall(host, version);
  });
  updater = autoUpdater;
  return autoUpdater;
}

export async function checkForUpdates(host: UpdateHost, options: { userRequested?: boolean } = {}) {
  const userRequested = options.userRequested === true;
  if (!app.isPackaged) {
    if (userRequested) await reportSourceCopy(host.window());
    return;
  }
  if (!automaticUpdatesAvailable()) {
    if (userRequested) await reportManualLinuxUpdates(host.window());
    return;
  }
  if (userRequested && downloadedVersion) return offerInstall(host, downloadedVersion);
  if (checking) return checking;
  if (userRequested) userChecks += 1;
  checking = (async () => {
    const result = await (await updaterFor(host)).checkForUpdates();
    if (userRequested && result && !result.isUpdateAvailable) await reportUpToDate(host.window());
  })().finally(() => {
    checking = null;
    if (userRequested) userChecks -= 1;
  });
  return checking;
}

async function offerDownload(host: UpdateHost, version: string) {
  const window = host.window();
  if (!window || window.isDestroyed()) return;
  const result = await dialog.showMessageBox(window, {
    type: "info",
    title: "Update available",
    message: `AI Coding Tool ${version} is available.`,
    detail: "Download it now? You can keep working while it downloads.",
    buttons: ["Download update", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response !== 0) return;
  announceFailure = true;
  const active = updater;
  if (active) await active.downloadUpdate().catch((error) => console.error("Update download failed:", error));
}

async function offerInstall(host: UpdateHost, version: string) {
  const window = host.window();
  if (!window || window.isDestroyed()) return;
  const result = await dialog.showMessageBox(window, {
    type: "info",
    title: "Update ready",
    message: `AI Coding Tool ${version} is ready to install.`,
    detail: "Restart AI Coding Tool to finish the update.",
    buttons: ["Restart and install", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response !== 0) return;
  host.onInstall();
  updater?.quitAndInstall(false, true);
}

async function reportUpToDate(window: BrowserWindow | null) {
  if (!window || window.isDestroyed()) return;
  await dialog.showMessageBox(window, {
    type: "info",
    title: "No update available",
    message: `AI Coding Tool ${app.getVersion()} is the latest version.`,
    buttons: ["OK"],
  });
}

/** A copy run from source has no installer behind it, so the check would fail rather than find nothing. */
async function reportSourceCopy(window: BrowserWindow | null) {
  if (!window || window.isDestroyed()) return;
  await dialog.showMessageBox(window, {
    type: "info",
    title: "Cannot check for updates",
    message: "This copy of AI Coding Tool runs from source.",
    detail: "Only the installed app updates itself.",
    buttons: ["OK"],
  });
}

/** Debian packages are installed and updated by the user's package workflow, not AppImageUpdater. */
async function reportManualLinuxUpdates(window: BrowserWindow | null) {
  if (!window || window.isDestroyed()) return;
  const result = await dialog.showMessageBox(window, {
    type: "info",
    title: "Check for updates manually",
    message: "This Linux package is updated manually.",
    detail: "Download the latest package and install it the same way you installed this one.",
    buttons: ["Open downloads", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) await shell.openExternal(RELEASES_URL);
}

/**
 * An update the installed copy refuses says so and offers the download, rather than stopping in the
 * log. macOS ties a copy's signature to the bundle id it was signed with, so a build that changes
 * that id can only be installed by hand.
 */
export async function reportUpdateFailure(window: BrowserWindow | null, error: Error) {
  if (!window || window.isDestroyed()) return;
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "Update failed",
    message: "AI Coding Tool could not install the update.",
    detail: `${error.message}\n\n${manualUpdateRecovery()}`,
    buttons: ["Open downloads", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) await shell.openExternal(RELEASES_URL);
}
