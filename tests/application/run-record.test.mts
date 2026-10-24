import assert from "node:assert/strict";
import { test } from "vitest";
import { runOf, runsInWorkspace, runStatus, startingThreads, startsOf, threadBusy, threadToBegin, usersTurn } from "../../src/application/run-record.ts";
import type { PendingRun } from "../../src/application/workspace-state.ts";
import { activeRun, PROJECT, task, workspace } from "./workspace-reducer-fixtures.mts";

const start = (id: string, taskId: string | undefined, overrides: Partial<PendingRun> = {}): PendingRun => ({
  id, runId: `run-${id}`, origin: "composer", ...(taskId ? { taskId } : {}), text: "", prompt: "", attachments: [], ...overrides,
});

test("a thread is busy with a run going or a start still resolving, and idle with neither", () => {
  const state = workspace({
    threads: [task("one"), task("two"), task("three")],
    activeRuns: { one: activeRun("one", "run-1") },
    pendingRuns: { p1: start("p1", "two"), p2: start("p2", undefined) },
  });
  assert.equal(threadBusy(state, "one"), true);
  assert.equal(threadBusy(state, "two"), true, "a send on its way counts before its run begins");
  assert.equal(threadBusy(state, "three"), false);
  assert.equal(runOf(state, "one")?.runId, "run-1");
  assert.equal(runOf(state, "two"), undefined);
});

test("a thread's starts are grouped once per set of starts, oldest first, and a new thread's starts belong to none", () => {
  const state = workspace({ pendingRuns: { p1: start("p1", "two"), p2: start("p2", undefined), p3: start("p3", "two", { origin: "automation" }) } });
  assert.deepEqual(startsOf(state, "two").map((pending) => pending.id), ["p1", "p3"]);
  assert.deepEqual(startsOf(state, "one"), []);
  assert.deepEqual([...startingThreads(state).keys()], ["two"]);
  assert.equal(startingThreads(state), startingThreads({ pendingRuns: state.pendingRuns }), "the same starts are not grouped twice");
});

test("the user's turn is a run or start of their own, not a scheduled one", () => {
  const state = workspace({
    activeRuns: { mine: activeRun("mine", "run-1"), tick: activeRun("tick", "run-2", { origin: "automation" }) },
    pendingRuns: { p1: start("p1", "sending"), p2: start("p2", "ticking", { origin: "automation" }) },
  });
  assert.equal(usersTurn(state, "mine"), true);
  assert.equal(usersTurn(state, "sending"), true);
  assert.equal(usersTurn(state, "tick"), false);
  assert.equal(usersTurn(state, "ticking"), false);
  assert.equal(usersTurn(state, "idle"), false);
});

test("a thread shows running while its run is going, else how its last run ended", () => {
  const state = workspace({
    activeRuns: { one: activeRun("one", "run-1") },
    runStatuses: { two: "stopped" },
  });
  assert.equal(runStatus(state, "one"), "running");
  assert.equal(runStatus(state, "two"), "stopped");
  assert.equal(runStatus(state, "three"), "idle");
  assert.equal(runStatus(state, null), "idle", "the draft has no run");
});

test("a resolved start begins only on a thread still there, not filed away, and with no run going", () => {
  const state = workspace({
    threads: [task("free"), task("filed", { archivedAt: 5 }), task("going")],
    activeRuns: { going: activeRun("going", "run-1") },
  });
  assert.equal(threadToBegin(state, "free")?.id, "free");
  assert.equal(threadToBegin(state, "filed"), undefined);
  assert.equal(threadToBegin(state, "going"), undefined);
  assert.equal(threadToBegin(state, "gone"), undefined);
  assert.equal(threadToBegin(state, undefined), undefined);
});

test("a checkout holds a run while any thread standing in it has one going", () => {
  const state = workspace({
    projects: [PROJECT],
    threads: [task("one", { projectId: PROJECT.id }), task("two")],
    activeRuns: { one: activeRun("one", "run-1") },
  });
  assert.equal(runsInWorkspace(state, PROJECT.workspaceId), true);
  assert.equal(runsInWorkspace(state, "elsewhere"), false);
  assert.equal(runsInWorkspace(state, undefined), false);
  assert.equal(runsInWorkspace({ ...state, activeRuns: {} }, PROJECT.workspaceId), false);
});
