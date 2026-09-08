import assert from "node:assert/strict";
import { test } from "vitest";
import type { ShortcutOverrides } from "../../src/domain/shortcuts.ts";
import { registered, startMainProcess } from "../support/electron-harness.mjs";

test("Wayland with XWayland leaves the global capture key unclaimed before a portal can open", { skip: process.platform !== "linux" }, async (t) => {
  const previousDisplay = process.env.DISPLAY;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  const previousHyprland = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  Reflect.deleteProperty(process.env, "HYPRLAND_INSTANCE_SIGNATURE");
  process.env.DISPLAY = ":99";
  process.env.WAYLAND_DISPLAY = "wayland-test";
  process.env.XDG_SESSION_TYPE = "wayland";
  try {
    const main = await startMainProcess(t, "aic-keyboard-wayland-");
    const setShortcuts = registered<(event: unknown, overrides: ShortcutOverrides) => void>(main.listeners, "shortcuts:set");
    setShortcuts(main.trusted, {});

    assert.equal(main.globalShortcuts.size, 0);
    const refusal = {
      binding: "Alt+Shift+S",
      reason: "unsupported",
      message: "Window capture is not available on this Wayland desktop yet. Supported Linux sessions are Hyprland and X11.",
    };
    assert.deepEqual(main.sentOn("window:shortcut-refused"), [refusal]);

    /** A renderer reload repeats its preferences handshake and must receive its own capability state. */
    setShortcuts(main.trusted, {});
    assert.deepEqual(main.sentOn("window:shortcut-refused"), [refusal, refusal]);
    process.env.HYPRLAND_INSTANCE_SIGNATURE = "hyprland-test";
    setShortcuts(main.trusted, {});
    assert.equal(main.globalShortcuts.size, 1, "Hyprland registers the capture shortcut");
    assert.ok(main.globalShortcuts.has("Alt+Shift+S"));
    await main.dispose();
  } finally {
    if (previousDisplay === undefined) Reflect.deleteProperty(process.env, "DISPLAY");
    else process.env.DISPLAY = previousDisplay;
    if (previousWayland === undefined) Reflect.deleteProperty(process.env, "WAYLAND_DISPLAY");
    else process.env.WAYLAND_DISPLAY = previousWayland;
    if (previousSessionType === undefined) Reflect.deleteProperty(process.env, "XDG_SESSION_TYPE");
    else process.env.XDG_SESSION_TYPE = previousSessionType;
    if (previousHyprland === undefined) Reflect.deleteProperty(process.env, "HYPRLAND_INSTANCE_SIGNATURE");
    else process.env.HYPRLAND_INSTANCE_SIGNATURE = previousHyprland;
  }
});
