import assert from "node:assert/strict";
import { test } from "vitest";
import { defaultSimulator, hidUsage, isSimulatorInput, screenTurns, SIMULATOR_ORIENTATIONS, simulatorGroups, turned, untilted } from "../../src/domain/simulator.ts";

test("a gesture is held to fractions of the screen, or to points when it says so", () => {
  assert.ok(isSimulatorInput({ kind: "tap", x: 0.5, y: 1 }));
  assert.ok(isSimulatorInput({ kind: "tap", x: 201, y: 437, points: true }));
  assert.ok(!isSimulatorInput({ kind: "tap", x: 201, y: 437 }));
  assert.ok(!isSimulatorInput({ kind: "tap", x: 0.5, y: 0.5, points: false }));
  assert.ok(isSimulatorInput({ kind: "swipe", x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: 300 }));
  assert.ok(!isSimulatorInput({ kind: "swipe", x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: 60_000 }));
  assert.ok(isSimulatorInput({ kind: "touch", phase: "move", x: 0, y: 0 }));
  assert.ok(!isSimulatorInput({ kind: "touch", phase: "hover", x: 0, y: 0 }));
  assert.ok(isSimulatorInput({ kind: "touch", phase: "down", x: 0.4, y: 0.5, x2: 0.6, y2: 0.5 }));
  assert.ok(!isSimulatorInput({ kind: "touch", phase: "down", x: 0.4, y: 0.5, x2: 0.6 }), "a second finger needs both coordinates");
  assert.ok(!isSimulatorInput({ kind: "touch", phase: "down", x: 0.4, y: 0.5, x2: 1.5, y2: 0.5 }));
  assert.ok(isSimulatorInput({ kind: "shortcut", usage: 4 }));
  assert.ok(!isSimulatorInput({ kind: "shortcut", usage: 0 }));
  assert.ok(!isSimulatorInput({ kind: "paste", text: "" }));
  assert.ok(!isSimulatorInput({ kind: "pasteboard", phase: "sync" }));
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
  assert.equal(hidUsage("Home"), 74);
  assert.equal(hidUsage("Numpad1"), 89);
  assert.equal(hidUsage("Numpad9"), 97);
  assert.equal(hidUsage("Numpad0"), 98);
  assert.equal(hidUsage("F13"), undefined);
});

test("the default device is one already running, else the first iPhone", () => {
  const phone = { udid: "a", name: "iPhone 17", runtime: "iOS 26.4", state: "shutdown" as const };
  const pad = { udid: "b", name: "iPad (A16)", runtime: "iOS 26.4", state: "shutdown" as const };
  assert.equal(defaultSimulator([pad, phone])?.udid, "a");
  assert.equal(defaultSimulator([phone, { ...pad, state: "booted" }])?.udid, "b");
  assert.equal(defaultSimulator([]), undefined);
});

test("a touch on the turned picture lands where it is on the device's portrait screen", () => {
  assert.deepEqual(untilted(0.25, 0.75, "portrait"), { x: 0.25, y: 0.75 });
  /** Turned left, the device's top edge is on the left of the picture. */
  assert.deepEqual(untilted(0, 0.5, "landscape-left"), { x: 0.5, y: 0 });
  assert.deepEqual(untilted(1, 0, "landscape-left"), { x: 1, y: 1 });
  assert.deepEqual(untilted(1, 0.5, "landscape-right"), { x: 0.5, y: 0 });
  assert.deepEqual(untilted(0, 1, "landscape-right"), { x: 1, y: 1 });
  assert.deepEqual(untilted(0.25, 0.25, "portrait-upside-down"), { x: 0.75, y: 0.75 });
});

test("rotating steps through the four ways a device is held, both ways round", () => {
  assert.equal(turned("portrait", -1), "landscape-left");
  assert.equal(turned("landscape-left", -1), "portrait-upside-down");
  assert.equal(turned("portrait", 1), "landscape-right");
  assert.equal(turned("landscape-left", 1), "portrait");
  assert.deepEqual(SIMULATOR_ORIENTATIONS.map(screenTurns), [0, 3, 1, 2]);
  assert.ok(isSimulatorInput({ kind: "rotate", orientation: "landscape-left" }));
  assert.ok(!isSimulatorInput({ kind: "rotate", orientation: "sideways" }));
});

test("the picker lists running devices first, the rest under their runtime, and a search names its best match first", () => {
  const devices = [
    { udid: "pro", name: "iPhone 17 Pro", runtime: "iOS 26.4", state: "booted" as const },
    { udid: "17", name: "iPhone 17", runtime: "iOS 26.4", state: "shutdown" as const },
    { udid: "pad", name: "iPad Air 11-inch (M4)", runtime: "iOS 26.4", state: "shutdown" as const },
    { udid: "old", name: "iPhone 16", runtime: "iOS 18.5", state: "booting" as const },
  ];
  assert.deepEqual(simulatorGroups(devices, "").map((group) => [group.label, group.devices.map((device) => device.udid)]), [
    ["Running", ["pro", "old"]],
    ["iOS 26.4", ["17", "pad"]],
  ]);
  const searched = simulatorGroups(devices, "iphone 17");
  assert.deepEqual(searched.map((group) => [group.label, group.devices.map((device) => device.udid)]), [["iOS 26.4", ["17"]], ["Running", ["pro"]]]);
  assert.deepEqual(simulatorGroups(devices, "18.5").map((group) => group.devices.map((device) => device.udid)), [["old"]]);
  assert.deepEqual(simulatorGroups(devices, "pixel"), []);
  assert.equal(defaultSimulator(devices, "pad")?.udid, "pad", "the device last picked wins over one already running");
  assert.equal(defaultSimulator(devices, "gone")?.udid, "pro");
});
