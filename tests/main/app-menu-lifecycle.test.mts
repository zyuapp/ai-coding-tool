import assert from "node:assert/strict";
import { test } from "vitest";
import type { ShortcutInvocation } from "../../src/contracts/ipc.js";
import { registered, startMainProcess, waitFor } from "../support/electron-harness.mjs";

type MenuEntry = { label?: string; submenu?: MenuEntry[]; click?: () => void };
type IpcEvent = { sender: unknown };

test("a help-menu command reopens a window and waits until its renderer is listening", async (context) => {
  const main = await startMainProcess(context, "aicodingtool-menu-lifecycle-");
  assert.equal(main.window.menuBarVisible, process.platform !== "linux");
  assert.equal(main.window.menuBarAutoHide, false, "Alt cannot bring back the Linux menu strip");
  const menu = main.applicationMenu() as MenuEntry[] | null;
  const licenses = menu?.flatMap((entry) => entry.submenu ?? []).find((entry) => entry.label === "Open Source Licenses…");
  assert.ok(licenses?.click);

  main.window.destroy();
  licenses.click();
  await waitFor(() => main.windows.length === 1, "replacement app window");
  const reopened = main.windows[0];
  assert.equal(reopened.menuBarVisible, process.platform !== "linux");
  assert.equal(reopened.menuBarAutoHide, false);
  assert.equal(reopened.webContents.sent.filter((entry) => entry.channel === "window:shortcut").length, 0, "the command does not race the renderer subscription");

  const ready = registered<(event: IpcEvent) => void>(main.listeners, "workspace-view:ready");
  ready({ sender: reopened.webContents });
  await waitFor(() => reopened.webContents.sent.some((entry) => entry.channel === "window:shortcut"), "queued menu command");
  assert.deepEqual(
    reopened.webContents.sent.find((entry) => entry.channel === "window:shortcut")?.event,
    { action: "app.open-source-licenses", surface: "any" } satisfies ShortcutInvocation,
  );
});
