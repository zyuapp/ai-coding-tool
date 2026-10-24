import assert from "node:assert/strict";
import { test } from "vitest";
import {
  catchesStart, caughtStartComputer, remoteTurnStop, stopIntentOf, withoutCaughtStart, withoutLapsedStops, withRunAnswered, withStartLanded, withStopAll, withStopsKept, withTurnBegun,
} from "../../src/application/outstanding-stops.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, required, task, workspace } from "./workspace-reducer-fixtures.mts";

const at = 1_800_000_000_000;
const lead = (overrides: Partial<Thread> = {}) => task("lead", { role: "coordinator", title: "Lead", ...overrides });
const leadOf = (state: WorkspaceState) => required(state.threads.find((thread) => thread.id === "lead"));
const studio = (state: WorkspaceState | null): PairedComputer => ({ id: "studio", name: "studio", host: "studio.tail.ts.net", status: "connected", error: null, pairedAt: 1, capabilities: COMPUTER_CAPABILITIES, state });
const far = (overrides: Partial<Thread> = {}) => task("far", { title: "Far", remoteLead: { threadId: "lead", title: "Lead", computer: "This Mac" }, ...overrides });

test("a Stop all covers the runs it cancels, the sessions it hushes, and what it stops or catches elsewhere", () => {
  const state = workspace({
    threads: [lead(), task("one"), task("two")],
    activeRuns: { one: activeRun("one", "run-1") },
    quietStops: ["run-gone"],
    quietSessions: [{ taskId: "two", at: at - 60 * 60_000 }],
  });
  const computer = studio(null);
  const { state: stopped, effects } = withStopAll(state, "lead", {
    cancelled: [{ runId: "run-1" }],
    hushed: ["one"],
    elsewhere: [{ thread: far(), computer, runId: "run-far", processIds: ["wf"] }],
    landing: [{ id: "p1", computer: "studio" }],
  }, at);
  assert.deepEqual(stopped.quietStops, ["run-1"], "a run no longer going is let go of");
  assert.deepEqual(stopped.quietSessions, [{ taskId: "one", at }], "a hush past its answer window is let go of");
  assert.deepEqual(leadOf(stopped).remoteStops, { far: { computer: "studio", runId: "run-far", answer: { at } } });
  assert.deepEqual(leadOf(stopped).caughtStarts, { p1: { computer: "studio" } });
  assert.deepEqual(effects, [{ type: "computer.forward", id: "studio", inputs: [{ type: "run.cancel", taskId: "far" }, { type: "run.stop-process", taskId: "far", processId: "wf" }] }]);
});

test("a run is the stop's until its end answers it", () => {
  const state = workspace({ quietStops: ["run-1"] });
  assert.equal(stopIntentOf(state, { runId: "run-1" }), "stop-all");
  assert.equal(stopIntentOf(state, { runId: "run-1", cancelling: true }), "stop-all", "Stop all's stop is the one it is heard as");
  assert.equal(stopIntentOf(state, { runId: "run-2", cancelling: true }), "user");
  assert.equal(stopIntentOf(state, { runId: "run-2" }), undefined);
  assert.equal(stopIntentOf(withRunAnswered(state, "run-1"), { runId: "run-1" }), undefined);
});

test("only the agent's own turn within the answer window answers a hushed session, and any turn spends it", () => {
  const state = workspace({ quietSessions: [{ taskId: "one", at }] });
  const answering = withTurnBegun(state, "one", true, at + 60_000);
  assert.equal(answering.answersStop, true);
  assert.deepEqual(answering.state.quietSessions, []);
  assert.equal(withTurnBegun(state, "one", false, at).answersStop, false, "a run someone sent picks the thread back up");
  assert.deepEqual(withTurnBegun(state, "one", false, at).state.quietSessions, []);
  assert.equal(withTurnBegun(state, "one", true, at + 3 * 60_000).answersStop, false, "a turn of its own long after the stop");
  const untouched = withTurnBegun(state, "two", true, at);
  assert.equal(untouched.state, state);
  assert.equal(untouched.answersStop, false);
});

test("a turn on a paired computer is the stop's only from the computer it was sent to, and spends it once it ends", () => {
  const stopping = lead({ remoteStops: { far: { computer: "studio", runId: "run-far" } } });
  const going = remoteTurnStop(stopping, far(), "studio", activeRun("far", "run-far"), false, at);
  assert.equal(going.spent, false);
  assert.equal(going.held(stopping), stopping);
  const ended = remoteTurnStop(stopping, far(), "studio", undefined, true, at);
  assert.deepEqual([ended.stopAll, ended.answered, ended.spent], [true, false, true]);
  assert.equal(ended.held(stopping).remoteStops, undefined);
  assert.equal(remoteTurnStop(stopping, far(), "attic", undefined, true, at).stopAll, false);
  const carriedOn = remoteTurnStop(stopping, far(), "studio", activeRun("far", "run-later"), false, at);
  assert.equal(carriedOn.held(stopping).remoteStops, undefined, "a run of its own first is no longer the stop's");
});

test("the agent's answer elsewhere is the stop's within the answer window, and ends quietly however it ends", () => {
  const stopping = lead({ remoteStops: { far: { computer: "studio", answer: { at } } } });
  const answering = remoteTurnStop(stopping, far(), "studio", activeRun("far", "run-a", { agentInitiated: true }), false, at + 60_000);
  const held = answering.held(stopping);
  assert.deepEqual(held.remoteStops, { far: { computer: "studio", answer: { at, runId: "run-a" } } });
  const answered = remoteTurnStop(held, far(), "studio", undefined, true, at + 90_000);
  assert.deepEqual([answered.stopAll, answered.answered], [true, true]);
  const late = remoteTurnStop(stopping, far(), "studio", activeRun("far", "run-a", { agentInitiated: true }), false, at + 3 * 60_000);
  assert.equal(late.held(stopping).remoteStops, undefined);
});

test("a caught start is caught until it lands, and its end settles it", () => {
  const catching = lead({ caughtStarts: { p1: { computer: "studio" } } });
  assert.equal(catchesStart(catching, "p1"), true);
  assert.equal(caughtStartComputer(catching, "p1"), "studio");
  const landed = withStartLanded(catching, "p1", "far");
  assert.equal(catchesStart(landed, "p1"), false);
  assert.equal(caughtStartComputer(landed, "p1"), "studio");
  assert.equal(withStartLanded({ ...catching, role: undefined }, "p1", "far").caughtStarts, undefined, "one no longer a coordinator hears nothing of it");
  const ended = remoteTurnStop(landed, far({ remoteLead: { threadId: "lead", title: "Lead", computer: "This Mac", proposalId: "p1" } }), "studio", undefined, true, at);
  assert.equal(ended.stopAll, true);
  assert.equal(ended.held(landed).caughtStarts, undefined);
  assert.equal(withoutCaughtStart(catching, "p1").caughtStarts, undefined);
  assert.equal(catchesStart(undefined, "p1"), false);
});

test("what Stop all holds elsewhere survives a restart until its computer says otherwise", () => {
  const holding = lead({ remoteStops: { far: { computer: "studio", runId: "run-far" } }, caughtStarts: { p1: { computer: "studio", threadId: "landed" } } });
  const silent = workspace({ threads: [holding], computers: { ...workspace().computers, paired: [studio(null)] } });
  assert.equal(withStopsKept(silent), silent, "a computer yet to answer since the restart keeps both");
  const answered = { ...silent, computers: { ...silent.computers, paired: [studio(workspace({ threads: [far(), task("landed", { remoteLead: { threadId: "lead", title: "Lead", computer: "This Mac" } })] }))] } };
  assert.equal(withStopsKept(answered), answered, "both still under it there");
  const movedOut = { ...silent, computers: { ...silent.computers, paired: [studio(workspace({ threads: [task("far"), task("landed")] }))] } };
  assert.equal(leadOf(withStopsKept(movedOut)).remoteStops, undefined);
  assert.equal(leadOf(withStopsKept(movedOut)).caughtStarts, undefined);
  const unpaired = { ...silent, computers: { ...silent.computers, paired: [] } };
  assert.equal(leadOf(withStopsKept(unpaired)).remoteStops, undefined);
});

test("a coordinator that is no longer one lets go of what it stopped, but not of what it caught", () => {
  const before = lead({ remoteStops: { far: { computer: "studio" } }, caughtStarts: { p1: { computer: "studio" } } });
  const after = { ...before, role: undefined };
  const state = withoutLapsedStops(workspace({ threads: [after] }), [{ id: "lead", before, after }]);
  assert.equal(leadOf(state).remoteStops, undefined);
  assert.deepEqual(leadOf(state).caughtStarts, { p1: { computer: "studio" } });
});
