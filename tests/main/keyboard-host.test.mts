import assert from "node:assert/strict";
import { test } from "vitest";
import type { ShortcutOverrides } from "../../src/domain/shortcuts.ts";
import { registered, startMainProcess } from "../support/electron-harness.mjs";

test("Wayland with XWayland leaves the global capture key unclaimed before a portal can open", { skip: process.platform !== "linux" }, async (t) => {
  const previousDisplay = process.env.DISPLAY;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  process.env.DISPLAY = ":99";
  process.env.WAYLAND_DISPLAY = "wayland-test";
  process.env.XDG_SESSION_TYPE = "wayland";
  try {
    const main = await startMainProcess(t, "aic-keyboard-wayland-");
    const setShortcuts = registered<(event: unknown, overrides: ShortcutOverrides) => void>(main.listeners, "shortcuts:set");
    setShortcuts(main.trusted, {});

    assert.equal(main.globalShortcuts.size, 0);
    assert.deepEqual(main.sentOn("window:shortcut-refused"), [{
      binding: "Alt+Shift+S",
      reason: "unsupported",
      message: "Global active-window capture is unavailable in this Wayland session because its capture portal cannot identify the active X11/XWayland window. Use an X11 session.",
    }]);
    await main.dispose();
  } finally {
    if (previousDisplay === undefined) Reflect.deleteProperty(process.env, "DISPLAY");
    else process.env.DISPLAY = previousDisplay;
    if (previousWayland === undefined) Reflect.deleteProperty(process.env, "WAYLAND_DISPLAY");
    else process.env.WAYLAND_DISPLAY = previousWayland;
    if (previousSessionType === undefined) Reflect.deleteProperty(process.env, "XDG_SESSION_TYPE");
    else process.env.XDG_SESSION_TYPE = previousSessionType;
  }
});
