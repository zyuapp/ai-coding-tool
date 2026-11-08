import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultSimulator, hidUsage, isSimulatorInput } from "../../src/domain/simulator.ts";

test("a gesture is held to fractions of the screen, or to points when it says so", () => {
  assert.ok(isSimulatorInput({ kind: "tap", x: 0.5, y: 1 }));
  assert.ok(isSimulatorInput({ kind: "tap", x: 201, y: 437, points: true }));
  assert.ok(!isSimulatorInput({ kind: "tap", x: 201, y: 437 }));
  assert.ok(!isSimulatorInput({ kind: "tap", x: 0.5, y: 0.5, points: false }));
  assert.ok(isSimulatorInput({ kind: "swipe", x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: 300 }));
  assert.ok(!isSimulatorInput({ kind: "swipe", x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: 60_000 }));
  assert.ok(isSimulatorInput({ kind: "touch", phase: "move", x: 0, y: 0 }));
  assert.ok(!isSimulatorInput({ kind: "touch", phase: "hover", x: 0, y: 0 }));
  assert.ok(isSimulatorInput({ kind: "key", usage: 4, down: true }));
  assert.ok(!isSimulatorInput({ kind: "key", usage: 0x100, down: true }));
  assert.ok(!isSimulatorInput({ kind: "type", text: "" }));
  assert.ok(!isSimulatorInput({ kind: "button", button: "volume" }));
});

test("keys map to their HID usage", () => {
  assert.equal(hidUsage("KeyA"), 4);
  assert.equal(hidUsage("KeyZ"), 29);
  assert.equal(hidUsage("Digit1"), 30);
  assert.equal(hidUsage("Digit0"), 39);
  assert.equal(hidUsage("Enter"), 40);
  assert.equal(hidUsage("ShiftLeft"), 225);
  assert.equal(hidUsage("F13"), undefined);
});

test("the default device is one already running, else the first iPhone", () => {
  const phone = { udid: "a", name: "iPhone 17", runtime: "iOS 26.4", state: "shutdown" as const };
  const pad = { udid: "b", name: "iPad (A16)", runtime: "iOS 26.4", state: "shutdown" as const };
  assert.equal(defaultSimulator([pad, phone])?.udid, "a");
  assert.equal(defaultSimulator([phone, { ...pad, state: "booted" }])?.udid, "b");
  assert.equal(defaultSimulator([]), undefined);
});
