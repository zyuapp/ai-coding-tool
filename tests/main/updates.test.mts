import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { AppUpdate } from "../../src/domain/app-update.ts";
import { beforeEach, test, vi } from "vitest";

type MenuItem = { id?: string; label?: string; enabled?: boolean; click?: () => void; submenu?: MenuItem[] };
const stub = vi.hoisted(() => ({
  updater: null as unknown,
  menu: [] as MenuItem[],
  dialogs: [] as Array<{ title: string; detail?: string }>,
  response: 1,
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.5.9" },
  shell: { openExternal: async () => {} },
  dialog: { showMessageBox: async (_window: unknown, options: { title: string; detail?: string }) => {
    stub.dialogs.push(options);
    return { response: stub.response };
  } },
  Menu: {
    buildFromTemplate: (items: MenuItem[]) => items,
    setApplicationMenu: (items: MenuItem[]) => { stub.menu = items; },
    getApplicationMenu: () => ({ getMenuItemById: (id: string) => stub.menu.flatMap((item) => item.submenu ?? []).find((item) => item.id === id) }),
  },
}));
vi.mock("electron-updater", () => ({ default: { get autoUpdater() { return stub.updater; } } }));
vi.mock("../../src/main/platform-capabilities.ts", () => ({ automaticUpdatesAvailable: () => true, manualUpdateRecovery: () => "Open downloads." }));

beforeEach(() => {
  vi.resetModules();
  stub.dialogs = [];
  stub.menu = [];
  stub.response = 1;
});

async function fixture() {
  let resolve!: (value: { isUpdateAvailable: boolean } | null) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<{ isUpdateAvailable: boolean } | null>((yes, no) => { resolve = yes; reject = no; });
  const updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(() => pending),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  });
  stub.updater = updater;
  const { checkForUpdates, confirmInstall, downloadUpdate, installUpdate, startUpdateChecks } = await import("../../src/main/updates.ts");
  const { installAppMenu, setUpdateChecking } = await import("../../src/main/app-menu.ts");
  const states: AppUpdate[] = [];
  const host = { window: () => ({ isDestroyed: () => false }) as BrowserWindow, onInstall: vi.fn(), onChecking: setUpdateChecking, onState: (update: AppUpdate) => { states.push(update); } };
  const manual: Promise<void>[] = [];
  installAppMenu({ onCheckForUpdates: () => { manual.push(checkForUpdates(host, { userRequested: true })); }, onOpenSourceLicenses() {} });
  const menu = stub.menu.flatMap((item) => item.submenu ?? []).find((item) => item.id === "app.check-for-updates")!;
  return { updater, resolve, reject, checkForUpdates, confirmInstall, downloadUpdate, installUpdate, startUpdateChecks, host, states, menu, manual };
}

for (const outcome of ["current", "available", "error", "unavailable"] as const) {
  test(`a manual menu check joins a background check and reports ${outcome} once`, async () => {
    const f = await fixture();
    const background = f.checkForUpdates(f.host);
    await vi.waitFor(() => assert.equal(f.updater.checkForUpdates.mock.calls.length, 1));
    assert.equal(f.menu.label, "Check for Updates…");
    f.menu.click!();
    f.menu.click!();
    assert.equal(f.menu.label, "Checking for Updates…");
    assert.equal(f.menu.enabled, false);
    assert.equal(f.updater.checkForUpdates.mock.calls.length, 1);

    if (outcome === "error") {
      const error = new Error("Network unavailable");
      f.updater.emit("error", error);
      f.reject(error);
    } else {
      if (outcome === "available") f.updater.emit("update-available", { version: "0.5.10" });
      f.resolve(outcome === "unavailable" ? null : { isUpdateAvailable: outcome === "available" });
    }
    await Promise.all([background, ...f.manual]);
    const titles = outcome === "current" ? ["No update available"] : outcome === "available" ? [] : ["Update check failed"];
    assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), titles);
    assert.equal(f.updater.downloadUpdate.mock.calls.length, outcome === "available" ? 1 : 0, "a check the user asked for downloads what it finds");
    assert.equal(f.menu.label, "Check for Updates…");
    assert.equal(f.menu.enabled, true);
  });
}

test("background failures stay quiet and a subsequent manual check can succeed", async () => {
  const f = await fixture();
  const background = f.checkForUpdates(f.host);
  const failed = assert.rejects(background, /Network unavailable/);
  await vi.waitFor(() => assert.equal(f.updater.checkForUpdates.mock.calls.length, 1));
  f.reject(new Error("Network unavailable"));
  await failed;
  assert.equal(stub.dialogs.length, 0);
  f.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false });
  f.menu.click!();
  assert.equal(f.menu.label, "Checking for Updates…");
  await Promise.all(f.manual);
  assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), ["No update available"]);
  assert.equal(f.menu.enabled, true);
});

test("update errors show a short recovery message and keep raw HTTP diagnostics in logs", async () => {
  await fixture();
  const { reportUpdateFailure } = await import("../../src/main/updates.ts");
  const window = { isDestroyed: () => false } as BrowserWindow;
  const error = new Error('Cannot find latest-mac.yml: HttpError: 404\nHeaders: {"x-github-request-id":"request-id"}\n at createHttpError');
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await reportUpdateFailure(window, error, "check");
    await reportUpdateFailure(window, error, "install");
    assert.deepEqual(stub.dialogs.map(({ title, detail }) => ({ title, detail })), [
      { title: "Update check failed", detail: "Please try again in a moment." },
      { title: "Update failed", detail: "Open downloads." },
    ]);
    assert.deepEqual(log.mock.calls, [["Update check failed:", error], ["Update install failed:", error]]);
  } finally {
    log.mockRestore();
  }
});

test("a background check offers the update, and the download reports progress until it is ready to install", async () => {
  const f = await fixture();
  const background = f.checkForUpdates(f.host);
  await vi.waitFor(() => assert.equal(f.updater.checkForUpdates.mock.calls.length, 1));
  f.updater.emit("update-available", { version: "0.5.10" });
  f.resolve({ isUpdateAvailable: true });
  await background;
  assert.deepEqual(f.states, [{ status: "available", version: "0.5.10" }]);
  assert.equal(stub.dialogs.length, 0);
  assert.equal(f.updater.downloadUpdate.mock.calls.length, 0);

  f.installUpdate(f.host);
  assert.equal(f.updater.quitAndInstall.mock.calls.length, 0, "nothing installs before it has downloaded");

  const download = f.downloadUpdate(f.host);
  f.updater.emit("download-progress", { percent: 41.2 });
  f.updater.emit("download-progress", { percent: 41.8 });
  f.updater.emit("update-downloaded", { version: "0.5.10" });
  await download;
  assert.deepEqual(f.states.slice(1), [
    { status: "downloading", version: "0.5.10", percent: 0 },
    { status: "downloading", version: "0.5.10", percent: 41 },
    { status: "ready", version: "0.5.10" },
  ]);

  f.installUpdate(f.host);
  assert.equal(f.host.onInstall.mock.calls.length, 1);
  assert.deepEqual(f.updater.quitAndInstall.mock.calls, [[false, true]]);
});

test("a failed download offers the update again", async () => {
  const f = await fixture();
  const background = f.checkForUpdates(f.host);
  await vi.waitFor(() => assert.equal(f.updater.checkForUpdates.mock.calls.length, 1));
  f.updater.emit("update-available", { version: "0.5.10" });
  f.resolve({ isUpdateAvailable: true });
  await background;
  const error = new Error("Network unavailable");
  f.updater.downloadUpdate.mockImplementationOnce(async () => {
    f.updater.emit("error", error);
    throw error;
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.downloadUpdate(f.host);
  } finally {
    log.mockRestore();
  }
  assert.deepEqual(f.states.at(-1), { status: "available", version: "0.5.10" });
  assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), ["Update failed"], "reported once, by the download");
});

test("a download that throws before it starts still offers the update again", async () => {
  const f = await fixture();
  const background = f.checkForUpdates(f.host);
  await vi.waitFor(() => assert.equal(f.updater.checkForUpdates.mock.calls.length, 1));
  f.updater.emit("update-available", { version: "0.5.10" });
  f.resolve({ isUpdateAvailable: true });
  await background;
  f.updater.downloadUpdate.mockImplementationOnce(() => { throw new Error("Checksum is missing"); });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.downloadUpdate(f.host);
  } finally {
    log.mockRestore();
  }
  assert.deepEqual(f.states.at(-1), { status: "available", version: "0.5.10" });
  assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), ["Update failed"]);
});

test("a download the menu check started reports its failure while the check is still pending", async () => {
  const f = await fixture();
  const error = new Error("ZIP file not provided");
  f.updater.downloadUpdate.mockImplementationOnce(async () => {
    f.updater.emit("error", error);
    throw error;
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    f.menu.click!();
    await vi.waitFor(() => assert.equal(f.updater.checkForUpdates.mock.calls.length, 1));
    f.updater.emit("update-available", { version: "0.5.10" });
    await vi.waitFor(() => assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), ["Update failed"]));
    f.resolve({ isUpdateAvailable: true });
    await Promise.all(f.manual);
  } finally {
    log.mockRestore();
  }
  assert.deepEqual(f.states.at(-1), { status: "available", version: "0.5.10" });
  assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), ["Update failed"]);
});

test("a macOS failure after the download reports, but before the call settles, is reported once and offers the update again", async () => {
  const f = await fixture();
  const background = f.checkForUpdates(f.host);
  await vi.waitFor(() => assert.equal(f.updater.checkForUpdates.mock.calls.length, 1));
  f.updater.emit("update-available", { version: "0.5.10" });
  f.resolve({ isUpdateAvailable: true });
  await background;
  const error = new Error("Code signature did not pass validation");
  f.updater.downloadUpdate.mockImplementationOnce(async () => {
    f.updater.emit("update-downloaded", { version: "0.5.10" });
    f.updater.emit("error", error);
    f.updater.emit("error", error);
    throw error;
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await f.downloadUpdate(f.host);
  } finally {
    log.mockRestore();
  }
  assert.deepEqual(f.states.at(-1), { status: "available", version: "0.5.10" });
  assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), ["Update failed"]);
});

test("a running app checks again every hour until an update is downloading", async () => {
  vi.useFakeTimers();
  try {
    const f = await fixture();
    f.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false });
    const stop = f.startUpdateChecks(f.host);
    await vi.waitFor(() => assert.equal(f.updater.checkForUpdates.mock.calls.length, 1));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    assert.equal(f.updater.checkForUpdates.mock.calls.length, 2);

    f.updater.checkForUpdates.mockImplementation(async () => {
      f.updater.emit("update-available", { version: "0.5.10" });
      return { isUpdateAvailable: true };
    });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    assert.deepEqual(f.states, [{ status: "available", version: "0.5.10" }]);

    f.updater.downloadUpdate.mockImplementation(() => new Promise(() => {}));
    void f.downloadUpdate(f.host);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    assert.equal(f.updater.checkForUpdates.mock.calls.length, 3, "no check runs while the update downloads");
    stop();
  } finally {
    vi.useRealTimers();
  }
});

test("restarting into a downloaded update asks first", async () => {
  const f = await fixture();
  f.updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true });
  await f.checkForUpdates(f.host);
  f.updater.emit("update-available", { version: "0.5.10" });
  const download = f.downloadUpdate(f.host);
  f.updater.emit("update-downloaded", { version: "0.5.10" });
  await download;

  await f.confirmInstall(f.host);
  assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), ["Update ready"]);
  assert.equal(f.updater.quitAndInstall.mock.calls.length, 0, "Later keeps the app running");

  stub.response = 0;
  await f.confirmInstall(f.host);
  assert.equal(f.host.onInstall.mock.calls.length, 1);
  assert.deepEqual(f.updater.quitAndInstall.mock.calls, [[false, true]]);
});
