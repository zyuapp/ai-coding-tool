import assert from "node:assert/strict";
import { test } from "vitest";
import type { ShortcutOverrides } from "../../src/domain/shortcuts.ts";
import { registered, startMainProcess } from "../support/electron-harness.mjs";

test("pure Wayland leaves the global capture key unclaimed and reports why", { skip: process.platform !== "linux" }, async (t) => {
  const previousDisplay = process.env.DISPLAY;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  Reflect.deleteProperty(process.env, "DISPLAY");
  process.env.WAYLAND_DISPLAY = "wayland-test";
  try {
    const main = await startMainProcess(t, "aic-keyboard-wayland-");
    const setShortcuts = registered<(event: unknown, overrides: ShortcutOverrides) => void>(main.listeners, "shortcuts:set");
    setShortcuts(main.trusted, {});

    assert.equal(main.globalShortcuts.size, 0);
    assert.deepEqual(main.sentOn("window:shortcut-refused"), [{
      binding: "Alt+Shift+S",
      reason: "unsupported",
      message: "This Wayland compositor does not expose a safe global active-window capture path. Use an X11 session or XWayland window.",
    }]);
    await main.dispose();
  } finally {
    if (previousDisplay === undefined) Reflect.deleteProperty(process.env, "DISPLAY");
    else process.env.DISPLAY = previousDisplay;
    if (previousWayland === undefined) Reflect.deleteProperty(process.env, "WAYLAND_DISPLAY");
    else process.env.WAYLAND_DISPLAY = previousWayland;
  }
});
