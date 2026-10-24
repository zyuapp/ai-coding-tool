import assert from "node:assert/strict";
import { test } from "vitest";
import { coordinatorRoster, type RosterActivity } from "../../src/application/coordination.ts";
import type { PairedComputer } from "../../src/application/computers.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, task, workspace } from "./workspace-reducer-fixtures.mts";

/** A coordinator here with threads under it here and on paired computers, each standing as its computer last said. */

const FAR = { threadId: "lead", title: "Lead", computer: "This Mac" };
const NONE: RosterActivity = { working: new Set(), blocked: new Set(), ranked: new Set() };

function paired(id: string, state: WorkspaceState | null): PairedComputer {
  return { id, name: id, host: `${id}.tail.ts.net`, status: "connected", error: null, pairedAt: 1, state };
}

function coordinating(threads: Thread[], computers: PairedComputer[] = []): WorkspaceState {
  const state = workspace({ threads: [task("lead", { role: "coordinator", title: "Lead" }), ...threads] });
  return { ...state, computers: { ...state.computers, name: "This Mac", paired: computers } };
}

const lead = (state: WorkspaceState) => state.threads[0]!;
const ids = (threads: readonly { thread: Thread }[]) => threads.map(({ thread }) => thread.id);

test("a roster holds the threads here first, then each paired computer's, and only a live coordinator has one", () => {
  const studio = workspace({ threads: [task("far", { remoteLead: FAR }), task("other")] });
  const state = coordinating([task("near", { parentId: "lead" }), task("alone")], [paired("studio", studio)]);
  const roster = coordinatorRoster(state, lead(state), NONE);
  assert.deepEqual(ids(roster.members), ["near", "far"]);
  assert.deepEqual(roster.threads.map((thread) => thread.id), ["near", "far"]);
  assert.deepEqual(roster.members.map((member) => member.computer?.id ?? null), [null, "studio"]);
  assert.deepEqual(coordinatorRoster(state, state.threads[2]!, NONE).members, [], "a thread that coordinates nothing has no roster");
  const filed = { ...state, threads: [{ ...lead(state), role: undefined }, ...state.threads.slice(1)] };
  assert.deepEqual(coordinatorRoster(filed, lead(filed), NONE).members, []);
});

test("a thread here stands as this computer says, one on a paired computer as that computer last said", () => {
  const studio = workspace({
    threads: [task("far", { remoteLead: FAR }), task("asking", { remoteLead: FAR })],
    activeRuns: { far: activeRun("far", "run-far"), asking: activeRun("asking", "run-asking", { status: "awaiting-approval" }) },
  });
  const state = coordinating([task("near", { parentId: "lead" })], [paired("studio", studio)]);
  const idle = coordinatorRoster(state, lead(state), NONE);
  assert.deepEqual(idle.members.map(({ thread, working, blocked, ranked }) => [thread.id, working, blocked, ranked]), [
    ["near", false, false, false],
    ["far", true, false, true],
    ["asking", false, true, true],
  ], "one waiting on an approval is not doing work");
  assert.equal(idle.running, true);
  assert.equal(idle.blocked, true);
  const here = coordinatorRoster(state, lead(state), { working: new Set(["near", "far"]), blocked: new Set(["near"]), ranked: new Set(["near"]) });
  assert.deepEqual(here.members.map(({ thread, working, blocked }) => [thread.id, working, blocked]), [
    ["near", false, true],
    ["far", true, false],
    ["asking", false, true],
  ], "this computer's sets read only its own threads");
});

test("Dismiss on a coordinator's row files away its threads with a verdict, none waiting on an approval", () => {
  const studio = workspace({
    threads: [task("far", { remoteLead: FAR, outcome: "finished" }), task("asking", { remoteLead: FAR, outcome: "failed" })],
    activeRuns: { asking: activeRun("asking", "run-asking", { status: "awaiting-approval" }) },
  });
  const state = coordinating([task("near", { parentId: "lead", outcome: "finished" })], [paired("studio", studio)]);
  const roster = coordinatorRoster(state, lead(state), NONE);
  assert.deepEqual(ids(roster.filed), ["near", "far"]);
  assert.equal(roster.dismissable, true);
  const near = coordinatorRoster(state, lead(state), { ...NONE, blocked: new Set(["near"]) });
  assert.deepEqual(ids(near.filed), ["far"]);
  assert.equal(near.dismissable, true, "the one on the paired computer still has a verdict to file away");
  const quiet = coordinating([task("near", { parentId: "lead" })], [paired("studio", workspace({ threads: [task("far", { remoteLead: FAR })] }))]);
  assert.equal(coordinatorRoster(quiet, lead(quiet), NONE).dismissable, false, "nothing to file away");
  const asked = coordinatorRoster(state, lead(state), { ...NONE, blocked: new Set(["lead"]) });
  assert.equal(asked.dismissable, false, "a row waiting on an approval has nothing to dismiss until it is answered");
});

test("only the paired computers named count", () => {
  const studio = workspace({ threads: [task("far", { remoteLead: FAR, outcome: "finished" })] });
  const laptop = workspace({ threads: [task("lap", { remoteLead: FAR })], activeRuns: { lap: activeRun("lap", "run-lap") } });
  const computers = [paired("studio", studio), paired("laptop", laptop)];
  const state = coordinating([task("near", { parentId: "lead" })], computers);
  assert.deepEqual(ids(coordinatorRoster(state, lead(state), NONE).members), ["near", "far", "lap"]);
  const shown = coordinatorRoster(state, lead(state), NONE, [computers[0]!]);
  assert.deepEqual(ids(shown.members), ["near", "far"]);
  assert.equal(shown.running, false);
  assert.equal(shown.dismissable, true);
  const other = coordinatorRoster(state, lead(state), NONE, [computers[1]!]);
  assert.deepEqual(ids(other.members), ["near", "lap"]);
  assert.equal(other.running, true);
  assert.equal(other.dismissable, false);
});

test("what waits on the user counts the coordinator and every thread under it, wherever each is", () => {
  const decision = (id: string) => ({ id, question: "Which?", options: [{ label: "A" }, { label: "B" }], raisedAt: 1 });
  const studio = workspace({ threads: [task("far", { remoteLead: FAR, decisions: [decision("d-far")] })] });
  const state = coordinating([task("near", { parentId: "lead", decisions: [decision("d-near")] })], [paired("studio", studio)]);
  const withOwn = { ...state, threads: [{ ...lead(state), decisions: [decision("d-lead")] }, ...state.threads.slice(1)] };
  assert.equal(coordinatorRoster(state, lead(state), NONE).waiting.decisions, 2);
  assert.equal(coordinatorRoster(withOwn, lead(withOwn), NONE).waiting.decisions, 3);
});
