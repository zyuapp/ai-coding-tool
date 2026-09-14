import assert from "node:assert/strict";
import { test } from "vitest";
import { isBrowserControl, isBrowserFrame, MAX_BROWSER_FRAME_BYTES } from "../../src/contracts/browser-control.ts";
import { isComputerClientMessage } from "../../src/contracts/computers.ts";
import { HEADLESS_COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";

test("the paired boundary limits browser geometry, input, and frame payloads", () => {
  const accepted = (input: unknown) => isComputerClientMessage({ kind: "input", requestId: "browser", inputs: [input] });
  assert.ok(accepted({ type: "browser.viewport", tabId: "tab", viewport: { width: 800, height: 600 } }));
  assert.ok(accepted({ type: "browser.viewport", tabId: "tab", viewport: null }));
  for (const width of [0, -1, 2000, 1.5, Infinity, NaN]) assert.equal(accepted({ type: "browser.viewport", tabId: "tab", viewport: { width, height: 600 } }), false);
  const wheel = { kind: "wheel", x: 20, y: 30, deltaX: 0, deltaY: 100, modifiers: 0 };
  assert.ok(isBrowserControl(wheel));
  for (const patch of [{ x: NaN }, { y: -1 }, { deltaY: Infinity }, { modifiers: 16 }]) assert.equal(isBrowserControl({ ...wheel, ...patch }), false);
  assert.equal(isBrowserControl({ kind: "text", text: "x".repeat(16_385) }), false);
  assert.equal(accepted({ type: "browser.control", tabId: "tab", epoch: -1, input: wheel }), false);
  assert.equal(isBrowserFrame({ width: 800, height: 600, epoch: 1, data: "x".repeat(MAX_BROWSER_FRAME_BYTES + 1) }), false);
  assert.equal(isBrowserFrame({ width: 800, height: 600, epoch: 1, data: "<svg>" }), false);
  assert.equal(isComputerClientMessage({ kind: "query", requestId: "frame", query: { kind: "browser-frame", tabId: "" } }), false);
  assert.ok(!HEADLESS_COMPUTER_CAPABILITIES.some((name) => name.startsWith("command:browser.") || name.startsWith("query:browser-frame")));
});
