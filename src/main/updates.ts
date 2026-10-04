import { app, dialog, shell, type BrowserWindow } from "electron";
import type { AppUpdater } from "electron-updater";
import { homedir } from "node:os";
import { NO_APP_UPDATE, type AppUpdate } from "../domain/app-update.js";
import { registerAppImageUpdateRepair } from "./appimage-update.js";
import { automaticUpdatesAvailable, manualUpdateRecovery } from "./platform-capabilities.js";

const RELEASES_URL = "https://github.com/zyuapp/ai-coding-tool/releases/latest";

export type UpdateHost = {
  /** Read when a dialog is shown rather than when the check starts, so a replaced window still gets it. */
  window: () => BrowserWindow | null;
  /** Told before the app quits to install, so the shutdown is not read as a restart request. */
  onInstall: () => void;
  onChecking?: (checking: boolean) => void;
  onState: (update: AppUpdate) => void;
};

let updater: AppUpdater | null = null;
type UpdateCheck = { promise: Promise<void>; userRequested: boolean; pending: boolean };
let checking: UpdateCheck | null = null;
let state: AppUpdate = NO_APP_UPDATE;
/** Until the download call settles, which on macOS is after `update-downloaded` fires. */
let downloading = false;
/** A failed background check stays in the log; one the user asked for is theirs to hear about. */
let announceFailure = false;

async function updaterFor(host: UpdateHost) {
  if (updater) return updater;
  const { autoUpdater } = (await import("electron-updater")).default;
  if (process.platform === "linux" && process.env.APPIMAGE) {
    registerAppImageUpdateRepair(autoUpdater, { appImage: process.env.APPIMAGE, home: homedir(), dataHome: process.env.XDG_DATA_HOME });
  }
  autoUpdater.autoDownload = false;
  autoUpdater.on("error", (error) => {
    console.error("Update error:", error);
    // Check failures are reported by the shared promise, including setup failures
    // that never emit an updater event, and download failures by `downloadUpdate`.
    // Install errors still arrive here.
    if (downloading) return;
    if (!checking?.pending && announceFailure) void reportUpdateFailure(host.window(), error);
  });
  autoUpdater.on("update-available", ({ version }) => {
    /** A check after the download has started finds the same version again. */
    if (state.status === "downloading" || state.status === "ready") return;
    setState(host, { status: "available", version });
    if (checking?.userRequested) void downloadUpdate(host);
  });
  autoUpdater.on("download-progress", ({ percent }) => {
    const whole = Math.min(100, Math.floor(percent));
    if (state.status === "downloading" && whole !== state.percent) setState(host, { ...state, percent: whole });
  });
  autoUpdater.on("update-downloaded", ({ version }) => setState(host, { status: "ready", version }));
  updater = autoUpdater;
  return autoUpdater;
}

function setState(host: UpdateHost, next: AppUpdate) {
  state = next;
  host.onState(next);
}

export function appUpdate() {
  return state;
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
  if (userRequested && state.status === "ready") return offerInstall(host, state.version);
  if (checking) {
    if (userRequested && !checking.userRequested) {
      checking.userRequested = true;
      if (checking.pending) host.onChecking?.(true);
    }
    return checking.promise;
  }
  const check: UpdateCheck = { promise: Promise.resolve(), userRequested, pending: true };
  checking = check;
  if (userRequested) host.onChecking?.(true);
  const finishProgress = () => {
    if (!check.pending) return;
    check.pending = false;
    if (check.userRequested) host.onChecking?.(false);
  };
  check.promise = (async () => {
    try {
      const result = await (await updaterFor(host)).checkForUpdates();
      if (!result) throw new Error("The update service is unavailable. Please try again.");
      finishProgress();
      if (check.userRequested && !result.isUpdateAvailable) await reportUpToDate(host.window());
    } catch (cause) {
      finishProgress();
      if (!check.userRequested) throw cause;
      await reportUpdateFailure(host.window(), cause instanceof Error ? cause : new Error(String(cause)), "check");
    } finally {
      finishProgress();
      checking = null;
    }
  })();
  return check.promise;
}

/** Downloads the update a check found. A failed download offers it again. */
export async function downloadUpdate(host: UpdateHost) {
  if (state.status !== "available" || !updater) return;
  const { version } = state;
  announceFailure = true;
  setState(host, { status: "downloading", version, percent: 0 });
  downloading = true;
  try {
    await updater.downloadUpdate();
  } catch (error) {
    setState(host, { status: "available", version });
    await reportUpdateFailure(host.window(), error instanceof Error ? error : new Error(String(error)));
  } finally {
    downloading = false;
  }
}

export function installUpdate(host: UpdateHost) {
  if (state.status !== "ready") return;
  host.onInstall();
  updater?.quitAndInstall(false, true);
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
  if (result.response === 0) installUpdate(host);
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
export async function reportUpdateFailure(window: BrowserWindow | null, error: Error, phase: "check" | "install" = "install") {
  console.error(`Update ${phase} failed:`, error);
  if (!window || window.isDestroyed()) return;
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: phase === "check" ? "Update check failed" : "Update failed",
    message: phase === "check" ? "AI Coding Tool could not check for updates." : "AI Coding Tool could not install the update.",
    detail: phase === "check" ? "Please try again in a moment." : manualUpdateRecovery(),
    buttons: phase === "check" ? ["OK"] : ["Open downloads", "Later"],
    defaultId: 0,
    cancelId: phase === "check" ? 0 : 1,
  });
  if (phase === "install" && result.response === 0) await shell.openExternal(RELEASES_URL);
}
