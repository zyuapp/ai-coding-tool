import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, test, vi } from "vitest";
import { captureScreenshotContext, SCREENSHOT_CONTEXT_TIMEOUT_MS } from "../../src/main/screenshot-context.ts";
import type { ScreenshotTarget } from "../../src/main/screenshot-context-snapshot.ts";

const mocks = vi.hoisted(() => ({ fork: vi.fn(), trusted: vi.fn() }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: false, getAppPath: () => "/app" }),
    systemPreferences: { isTrustedAccessibilityClient: mocks.trusted },
    utilityProcess: { fork: mocks.fork },
  };
});

class Process extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => { this.emit("exit", 0); return true; });
}

const target: ScreenshotTarget = { platform: "macos", pid: 42, windowId: 24, app: "Editor", title: "Draft" };
let child: Process;
beforeEach(() => {
  child = new Process();
  mocks.fork.mockReset().mockReturnValue(child);
  mocks.trusted.mockReset().mockReturnValue(true);
});
afterEach(() => {
  child.emit("exit", 0);
  vi.useRealTimers();
});

test("missing macOS accessibility permission keeps basic context without prompting or spawning", async () => {
  mocks.trusted.mockReturnValue(false);
  const context = await captureScreenshotContext(target);
  assert.equal(context.app, "Editor");
  assert.deepEqual(context.accessibility, { status: "unavailable", reason: "permission" });
  assert.deepEqual(mocks.trusted.mock.calls, [[false]]);
  assert.equal(mocks.fork.mock.calls.length, 0);
});

test("successful context is captured in a disposable process and preserves the target", async () => {
  const pending = captureScreenshotContext(target);
  assert.deepEqual(child.postMessage.mock.calls, [[target]]);
  child.emit("message", { status: "captured", text: "Document ready", truncated: false });
  const context = await pending;
  assert.equal(context.accessibility.status, "captured");
  assert.equal(child.kill.mock.calls.length, 1);
});

test("a hung native walk is killed at the deadline and concurrent captures do not accumulate workers", async () => {
  vi.useFakeTimers();
  const pending = captureScreenshotContext(target);
  assert.deepEqual((await captureScreenshotContext(target)).accessibility, { status: "unavailable", reason: "busy" });
  await vi.advanceTimersByTimeAsync(SCREENSHOT_CONTEXT_TIMEOUT_MS);
  assert.deepEqual((await pending).accessibility, { status: "unavailable", reason: "timeout" });
  assert.equal(child.kill.mock.calls.length, 1);
  assert.equal(mocks.fork.mock.calls.length, 1);
});

test("Hyprland metadata enables only its own read process's Wayland backend and bypasses macOS permissions", async () => {
  const linux = { ...target, platform: "linux-hyprland" as const, windowId: 0x55aa12345678 };
  const pending = captureScreenshotContext(linux);
  const options = mocks.fork.mock.calls[0][2];
  assert.equal(options.env.CUA_DRIVER_RS_ENABLE_WAYLAND, "1");
  assert.equal(options.env.CUA_WAYLAND_NEST, undefined);
  assert.equal(mocks.trusted.mock.calls.length, 0);
  child.emit("message", { status: "captured", text: "Linux text", truncated: false });
  assert.equal((await pending).platform, "linux-hyprland");
});

test("native startup, exit, and malformed replies degrade without rejecting a capture", async () => {
  mocks.fork.mockImplementationOnce(() => { throw new Error("Missing library"); });
  assert.deepEqual((await captureScreenshotContext(target)).accessibility, { status: "unavailable", reason: "failed" });
  const exited = captureScreenshotContext(target);
  child.emit("exit", 1);
  assert.equal((await exited).accessibility.status, "unavailable");
  const malformed = captureScreenshotContext(target);
  child.emit("message", { status: "captured", text: 17 });
  assert.equal((await malformed).accessibility.status, "unavailable");
});
