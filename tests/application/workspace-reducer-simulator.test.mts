import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { SIMULATOR_PANEL } from "../../src/application/workspace-dock.ts";
import type { SimulatorDevice } from "../../src/domain/simulator.ts";
import { dock, effectOf, run, task, workspace } from "./workspace-reducer-fixtures.mts";

const phone: SimulatorDevice = { udid: "PHONE", name: "iPhone 17", runtime: "iOS 26.4", state: "shutdown" };
const pad: SimulatorDevice = { udid: "PAD", name: "iPad Air 11-inch (M4)", runtime: "iOS 26.4", state: "booted" };
const listed = { type: "simulator.listed" as const, availability: { status: "available" as const }, devices: [phone, pad] };

test("opening the panel picks the running device, shows it in the dock in front, and boots nothing already up", () => {
  const opened = reduce(run(workspace(), [listed]), { type: "simulator.open" });

  assert.equal(dock(opened.state).simulatorId, "PAD");
  assert.equal(dock(opened.state).tab, SIMULATOR_PANEL);
  assert.equal(dock(opened.state).open, true);
  assert.deepEqual(opened.effects.filter((effect) => effect.type.startsWith("simulator")), [{ type: "simulator.list" }]);
});

test("a device picked before the list arrives is chosen once it does, and booted", () => {
  const opened = reduce(workspace(), { type: "simulator.open" });
  assert.equal(dock(opened.state).simulatorId, null);
  const arrived = reduce(opened.state, { ...listed, devices: [phone] });

  assert.equal(dock(arrived.state).simulatorId, "PHONE");
  assert.deepEqual(effectOf(arrived, "simulator.boot"), { type: "simulator.boot", udid: "PHONE", followUp: true });
  assert.deepEqual(arrived.state.simulator.booting, ["PHONE"]);

  const booted = reduce(arrived.state, { type: "simulator.booted", udid: "PHONE" });
  assert.equal(booted.state.simulator.devices[0]?.state, "booted");
  assert.deepEqual(booted.state.simulator.booting, []);
});

test("a run opens the panel in its own dock without taking the user's view, and names a device by name", () => {
  const state = run(workspace({ threads: [task("mine"), task("agent")], currentId: "mine" }), [listed]);
  const opened = reduce(state, { type: "simulator.open", taskId: "agent", device: "iphone 17" });

  assert.equal(dock(opened.state, "agent").simulatorId, "PHONE");
  assert.ok(dock(opened.state, "agent").panels.includes(SIMULATOR_PANEL));
  assert.notEqual(dock(opened.state, "agent").tab, SIMULATOR_PANEL);
  assert.equal(dock(opened.state, "mine").simulatorId, null);

  const missing = reduce(state, { type: "simulator.open", taskId: "agent", device: "Pixel" });
  assert.deepEqual(missing.result, { ok: false, message: "No simulator is called Pixel." });
});

test("a run's gesture goes to its own dock's device and marks it driving until that stretch goes idle", () => {
  const state = run(workspace({ threads: [task("agent")], currentId: "agent" }), [listed, { type: "simulator.open", taskId: "agent", device: "PAD" }]);
  const tapped = reduce(state, { type: "simulator.input", taskId: "agent", input: { kind: "tap", x: 0.5, y: 0.5 } });

  assert.deepEqual(effectOf(tapped, "simulator.input"), { type: "simulator.input", udid: "PAD", input: { kind: "tap", x: 0.5, y: 0.5 }, taskId: "agent", seq: 1 });
  assert.deepEqual(tapped.state.simulator.driver, { taskId: "agent", udid: "PAD", seq: 1 });
  const again = reduce(tapped.state, { type: "simulator.input", taskId: "agent", input: { kind: "button", button: "home" } });
  assert.equal(reduce(again.state, { type: "simulator.idle", seq: 1 }).state.simulator.driver?.seq, 2, "an older idle report cannot end newer driving");
  assert.equal(reduce(again.state, { type: "simulator.idle", seq: 2 }).state.simulator.driver, null);
});

test("a gesture on a device still starting is dropped for a person and refused for a run", () => {
  const state = run(workspace({ threads: [task("agent")], currentId: "agent" }), [listed, { type: "simulator.select", udid: "PHONE" }]);
  const touch = { kind: "touch" as const, phase: "down" as const, x: 0.1, y: 0.1 };

  const dropped = reduce(state, { type: "simulator.input", udid: "PHONE", input: touch });
  assert.deepEqual(dropped.effects, []);
  assert.equal(dropped.state, state, "a person's pointer leaves the state alone");

  const refused = reduce(state, { type: "simulator.input", taskId: "agent", input: touch });
  assert.deepEqual(refused.result, { ok: false, message: "The simulator is still starting." });
});

test("a failed boot is shown in the panel, and trying again clears it", () => {
  const state = run(workspace(), [listed, { type: "simulator.select", udid: "PHONE" }]);
  const failed = reduce(state, { type: "simulator.failed", udid: "PHONE", message: "Unable to boot" });
  assert.equal(failed.state.simulator.errors.PHONE, "Unable to boot");
  assert.equal(failed.state.actionError, null, "the panel says it, not the workspace banner");

  const retried = reduce(failed.state, { type: "simulator.select", udid: "PHONE" });
  assert.equal(retried.state.simulator.errors.PHONE, undefined);
  assert.deepEqual(effectOf(retried, "simulator.boot"), { type: "simulator.boot", udid: "PHONE", followUp: true });
});

test("an unsupported Mac refuses the panel with its reason", () => {
  const state = run(workspace(), [{ type: "simulator.listed", availability: { status: "unsupported", reason: "Install Xcode to use the simulator." }, devices: [] }]);
  assert.deepEqual(reduce(state, { type: "simulator.open" }).result, { ok: false, message: "Install Xcode to use the simulator." });
});

test("the device picked is remembered for docks that have none, and a turn is kept until the device goes down", () => {
  const picked = reduce(run(workspace(), [listed]), { type: "simulator.select", udid: "PHONE" });
  assert.equal(picked.state.simulatorDevice, "PHONE");
  assert.ok(picked.effects.some((effect) => effect.type === "persist-preferences" && effect.preferences.simulatorDevice === "PHONE"));

  const elsewhere = reduce(run(picked.state, [{ type: "simulator.booted", udid: "PHONE" }, { type: "task.select", taskId: "other" }]), { type: "simulator.open" });
  assert.equal(dock(elsewhere.state).simulatorId, "PHONE", "not the iPad already running");

  const asked = reduce(elsewhere.state, { type: "simulator.input", udid: "PHONE", input: { kind: "rotate", orientation: "landscape-left" } });
  assert.deepEqual(effectOf(asked, "simulator.input"), { type: "simulator.input", udid: "PHONE", input: { kind: "rotate", orientation: "landscape-left" } });
  assert.equal(asked.state.simulator.orientations.PHONE, undefined, "the panel turns once the device has, so a refused turn is never drawn");
  const turnedState = reduce(asked.state, { type: "simulator.turned", udid: "PHONE", orientation: "landscape-left" });
  assert.equal(turnedState.state.simulator.orientations.PHONE, "landscape-left");
  const stillUp = reduce(turnedState.state, { type: "simulator.booted", udid: "PHONE" });
  assert.equal(stillUp.state.simulator.orientations.PHONE, "landscape-left", "a boot that finds it already up leaves it turned");
  const wentDown = reduce(turnedState.state, { ...listed, devices: [{ ...phone, state: "shutdown" }, pad] });
  assert.equal(wentDown.state.simulator.orientations.PHONE, undefined);
});

test("a device is let go once no dock shows it, however its panel closed or moved on", () => {
  const state = run(workspace({ threads: [task("mine"), task("agent")], currentId: "mine" }), [listed, { type: "simulator.open", device: "PAD" }, { type: "simulator.open", taskId: "agent", device: "PAD" }]);
  const released = (transition: ReturnType<typeof reduce>) => transition.effects.filter((effect) => effect.type === "simulator.release");

  const closedOne = reduce(state, { type: "view.close-dock-panel", panel: SIMULATOR_PANEL });
  assert.deepEqual(released(closedOne), [], "the run's dock still shows it");

  const closedBoth = reduce(run(closedOne.state, [{ type: "task.select", taskId: "agent" }]), { type: "view.close-dock-panel", panel: SIMULATOR_PANEL });
  assert.deepEqual(released(closedBoth), [{ type: "simulator.release", udid: "PAD" }]);

  const switched = reduce(run(workspace(), [listed, { type: "simulator.open", device: "PAD" }]), { type: "simulator.select", udid: "PHONE" });
  assert.deepEqual(released(switched), [{ type: "simulator.release", udid: "PAD" }]);
});
