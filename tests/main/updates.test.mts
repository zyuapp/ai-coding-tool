import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { beforeEach, test, vi } from "vitest";

type MenuItem = { id?: string; label?: string; enabled?: boolean; click?: () => void; submenu?: MenuItem[] };
const stub = vi.hoisted(() => ({
  updater: null as unknown,
  menu: [] as MenuItem[],
  dialogs: [] as Array<{ title: string; detail?: string }>,
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.5.9" },
  shell: { openExternal: async () => {} },
  dialog: { showMessageBox: async (_window: unknown, options: { title: string; detail?: string }) => {
    stub.dialogs.push(options);
    return { response: 1 };
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
});

async function fixture() {
  let resolve!: (value: { isUpdateAvailable: boolean } | null) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<{ isUpdateAvailable: boolean } | null>((yes, no) => { resolve = yes; reject = no; });
  const updater = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(() => pending) });
  stub.updater = updater;
  const { checkForUpdates } = await import("../../src/main/updates.ts");
  const { installAppMenu, setUpdateChecking } = await import("../../src/main/app-menu.ts");
  const host = { window: () => ({ isDestroyed: () => false }) as BrowserWindow, onInstall() {}, onChecking: setUpdateChecking };
  const manual: Promise<void>[] = [];
  installAppMenu({ onCheckForUpdates: () => { manual.push(checkForUpdates(host, { userRequested: true })); }, onOpenSourceLicenses() {} });
  const menu = stub.menu.flatMap((item) => item.submenu ?? []).find((item) => item.id === "app.check-for-updates")!;
  return { updater, resolve, reject, checkForUpdates, host, menu, manual };
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
    const title = outcome === "current" ? "No update available" : outcome === "available" ? "Update available" : "Update check failed";
    assert.deepEqual(stub.dialogs.map((dialog) => dialog.title), [title]);
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
