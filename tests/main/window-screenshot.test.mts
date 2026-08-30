import assert from "node:assert/strict";
import { test } from "vitest";
import { desktopSourceWindowId, x11ActiveWindowId, x11CaptureFailureMessage, x11WindowProperties, x11WindowSize } from "../../src/main/window-screenshot.ts";

test("X11 active-window IDs are read without treating the root window as an app", () => {
  assert.equal(x11ActiveWindowId("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x4a00007\n"), 0x4a00007);
  assert.equal(x11ActiveWindowId("_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0\n"), null);
  assert.equal(x11ActiveWindowId("_NET_ACTIVE_WINDOW:  not found.\n"), null);
});

test("X11 properties prefer the visible title and application class", () => {
  const properties = x11WindowProperties(17, [
    '_NET_WM_PID(CARDINAL) = 4242',
    '_NET_WM_NAME(UTF8_STRING) = "A project — AI Coding Tool"',
    'WM_NAME(STRING) = "stale title"',
    'WM_CLASS(STRING) = "ai-coding-tool", "AI Coding Tool"',
  ].join("\n"));
  assert.deepEqual(properties, { id: 17, pid: 4242, app: "AI Coding Tool", title: "A project — AI Coding Tool" });
});

test("Electron desktop source IDs match both decimal and hexadecimal X11 IDs", () => {
  assert.equal(desktopSourceWindowId("window:77594631:0"), 77594631);
  assert.equal(desktopSourceWindowId("window:0x4a00007:0"), 0x4a00007);
  assert.equal(desktopSourceWindowId("screen:0:0"), null);
});

test("X11 capture sizes its thumbnails from the active window's device-pixel geometry", () => {
  assert.deepEqual(x11WindowSize("  Width: 1437\n  Height: 911\n"), { width: 1437, height: 911 });
  assert.equal(x11WindowSize("  Width: 0\n  Height: 911\n"), null);
  assert.equal(x11WindowSize("xwininfo: Window id: 0x1\n"), null);
});

test("missing X11 utilities produce an actionable capture failure", () => {
  assert.match(x11CaptureFailureMessage(Object.assign(new Error("spawn xprop ENOENT"), { code: "ENOENT" })), /xprop and xwininfo.*x11-utils.*try again/i);
});
