import assert from "node:assert/strict";
import { test } from "vitest";
import { automaticUpdatesAvailable, computerUseCapability, linuxDisplayServer, manualUpdateRecovery, needsGlobalShortcutsPortal, windowCaptureCapability, windowFrameOptions } from "../../src/main/platform-capabilities.ts";

test("Linux display capability distinguishes X11, XWayland, native Wayland, and headless sessions", () => {
  assert.equal(linuxDisplayServer({ DISPLAY: ":0" }), "x11");
  assert.equal(linuxDisplayServer({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }), "xwayland");
  assert.equal(linuxDisplayServer({ WAYLAND_DISPLAY: "wayland-0" }), "wayland");
  assert.equal(linuxDisplayServer({ XDG_SESSION_TYPE: "wayland" }), "none", "a login type is not a usable display connection");
});

test("computer use admits X11 and explicit native Wayland, and explains unavailable sessions", () => {
  assert.deepEqual(computerUseCapability("linux", { DISPLAY: ":1" }), { status: "available", display: "x11" });
  const wayland = computerUseCapability("linux", { WAYLAND_DISPLAY: "wayland-1" });
  assert.equal(wayland.status, "unsupported");
  if (wayland.status === "unsupported") assert.match(wayland.message, /opt-in.*CUA_DRIVER_RS_ENABLE_WAYLAND/i);
  assert.deepEqual(computerUseCapability("linux", { WAYLAND_DISPLAY: "wayland-1", CUA_DRIVER_RS_ENABLE_WAYLAND: "1" }), { status: "available", display: "wayland" });
  const headless = computerUseCapability("linux", {});
  assert.equal(headless.status, "unsupported");
  if (headless.status === "unsupported") assert.match(headless.message, /DISPLAY.*WAYLAND_DISPLAY/);
  assert.deepEqual(computerUseCapability("darwin", {}), { status: "available", display: "macos" });
});

test("global capture admits X11 paths but fails closed on native Wayland", () => {
  assert.deepEqual(windowCaptureCapability("linux", { DISPLAY: ":1" }), { status: "available", display: "x11" });
  assert.deepEqual(windowCaptureCapability("linux", { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-1" }), { status: "available", display: "xwayland" });
  const wayland = windowCaptureCapability("linux", { WAYLAND_DISPLAY: "wayland-1" });
  assert.equal(wayland.status, "unsupported");
  if (wayland.status === "unsupported") assert.match(wayland.message, /compositor.*safe global active-window capture/i);
});

test("manual update recovery keeps the macOS location and names the Linux artifact", () => {
  assert.equal(manualUpdateRecovery("darwin"), "Download the new version and replace the app in Applications.");
  assert.equal(manualUpdateRecovery("linux"), "Download the new AppImage and replace the one you run.");
  assert.equal(automaticUpdatesAvailable("darwin", {}), true);
  assert.equal(automaticUpdatesAvailable("linux", { APPIMAGE: "/opt/AI Coding Tool.AppImage" }), true);
  assert.equal(automaticUpdatesAvailable("linux", {}), false);
});

test("desktop chrome keeps macOS inset controls and enables Wayland's shortcut portal", () => {
  assert.deepEqual(windowFrameOptions("darwin"), { titleBarStyle: "hiddenInset" });
  assert.deepEqual(windowFrameOptions("linux"), {});
  assert.equal(needsGlobalShortcutsPortal("linux", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1" }), true);
  assert.equal(needsGlobalShortcutsPortal("linux", { WAYLAND_DISPLAY: "wayland-1" }), false);
  assert.equal(needsGlobalShortcutsPortal("linux", { DISPLAY: ":0" }), false);
  assert.equal(needsGlobalShortcutsPortal("darwin", { WAYLAND_DISPLAY: "wayland-1" }), false);
});
