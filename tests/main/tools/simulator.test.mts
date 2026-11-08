import assert from "node:assert/strict";
import { test } from "vitest";
import { simulatorTools } from "../../../src/main/tools/simulator.mts";
import type { SimulatorBridge } from "../../../src/main/agent/agent-provider.mts";
import type { SimulatorRead, SimulatorReadResult, SimulatorWrite } from "../../../src/contracts/threads.js";

const device = { udid: "PHONE", name: "iPhone 17", runtime: "iOS 26.4", state: "booted" as const };
const snapshot: SimulatorReadResult = {
  kind: "snapshot",
  snapshot: {
    udid: "PHONE", device: "iPhone 17", application: "Settings", width: 402, height: 874,
    elements: [{ ref: "3.1", role: "Button", label: "General", frame: [16, 380, 370, 52], depth: 1 }],
  },
  shot: { path: "/tmp/s.png", width: 1206, height: 2622 },
};

type FakeBridge = SimulatorBridge & { writes: SimulatorWrite[]; reads: SimulatorRead[] };

function fakeBridge(status: SimulatorReadResult = { kind: "status", device, booted: true }): FakeBridge {
  const writes: SimulatorWrite[] = [];
  const reads: SimulatorRead[] = [];
  return {
    writes,
    reads,
    command: async (write) => { writes.push(write); },
    read: async (read) => { reads.push(read); return read.op === "status" ? status : snapshot; },
  };
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
function call(bridge: SimulatorBridge, name: string, args: Record<string, unknown> = {}, readOnly = false) {
  const tool = simulatorTools(bridge, { readOnly }).find((entry) => entry.name === name);
  assert.ok(tool, `no ${name} tool`);
  return (tool.handler as (args: Record<string, unknown>) => Promise<ToolResult>)(args);
}
const textOf = (result: ToolResult) => result.content.map((block) => block.text).join("");

test("opening waits for the device and answers with its UDID", async () => {
  const bridge = fakeBridge();
  const text = textOf(await call(bridge, "simulator_open", { device: "iPhone 17" }));
  assert.deepEqual(bridge.writes, [{ type: "simulator.open", device: "iPhone 17" }]);
  assert.equal(bridge.reads[0]?.op, "status");
  assert.match(text, /iPhone 17 · iOS 26\.4 is running\. UDID: PHONE/);

  const failed = await call(fakeBridge({ kind: "status", device, booted: false, error: "Unable to boot" }), "simulator_open");
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /could not start: Unable to boot/);
});

test("a read lists elements by ref with their frames, and the screenshot to open", async () => {
  const text = textOf(await call(fakeBridge(), "simulator_read"));
  assert.match(text, /Screenshot saved to \/tmp\/s\.png/);
  assert.match(text, /Settings on iPhone 17 — screen 402x874 points/);
  assert.match(text, /\[3\.1\] Button "General" \(16,380 370x52\)/);
});

test("a tap names a ref or a point in points, and answers with the screen afterwards", async () => {
  const bridge = fakeBridge();
  await call(bridge, "simulator_tap", { ref: "3.1" });
  await call(bridge, "simulator_tap", { x: 201, y: 406 });
  assert.deepEqual(bridge.writes, [
    { type: "simulator.input", input: { kind: "tap-element", ref: "3.1" } },
    { type: "simulator.input", input: { kind: "tap", x: 201, y: 406, points: true } },
  ]);
  assert.deepEqual(bridge.reads.at(-1), { op: "snapshot", screenshot: false });
  assert.equal((await call(bridge, "simulator_tap", { x: 3 })).isError, true);
});

test("typing can press Return, and a coordinator only reads", async () => {
  const bridge = fakeBridge();
  await call(bridge, "simulator_type", { text: "hello", submit: true });
  assert.deepEqual(bridge.writes, [{ type: "simulator.input", input: { kind: "type", text: "hello\n" } }]);
  assert.deepEqual(simulatorTools(bridge, { readOnly: true }).map((tool) => tool.name), ["simulator_read"]);
});

test("rotating names how to hold the device and answers with the screen as the app now draws it", async () => {
  const bridge = fakeBridge();
  await call(bridge, "simulator_rotate", { orientation: "landscape-right" });
  assert.deepEqual(bridge.writes, [{ type: "simulator.input", input: { kind: "rotate", orientation: "landscape-right" } }]);
  assert.deepEqual(bridge.reads.at(-1), { op: "snapshot", screenshot: false });
});
