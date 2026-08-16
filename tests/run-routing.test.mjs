import assert from "node:assert/strict";
import test from "node:test";
import { acceptRunEvent, failedEventsForTransportLoss, supersedePendingStarts } from "../dist/main/main/run-routing.js";

test("new start supersedes every older pending start and keeps the new one", () => {
  const pending = new Map([["old", { runId: "old" }], ["new", { runId: "new" }], ["older", { runId: "older" }]]);
  const superseded = supersedePendingStarts(pending, "new");
  assert.deepEqual(superseded, [["old", { runId: "old" }], ["older", { runId: "older" }]]);
  assert.deepEqual([...pending.keys()], ["new"]);
});

test("terminal run events close the gate and late events are ignored", () => {
  const state = { lastSequence: 0, terminal: false };
  assert.equal(acceptRunEvent(state, { sequence: 1, type: "run.started" }), true);
  assert.equal(acceptRunEvent(state, { sequence: 2, type: "run.status", status: "failed" }), true);
  assert.deepEqual(state, { lastSequence: 2, terminal: true });
  assert.equal(acceptRunEvent(state, { sequence: 3, type: "assistant.delta" }), false);
  assert.equal(acceptRunEvent(state, { sequence: 2, type: "run.status", status: "failed" }), false);
});

test("transport loss creates correlated failures only for non-terminal runs", () => {
  const events = failedEventsForTransportLoss([
    { taskId: "task-1", runId: "run-1", lastSequence: 3, terminal: false },
    { taskId: "task-2", runId: "run-2", lastSequence: 8, terminal: true },
  ], "Agent process exited with code 1.");

  assert.deepEqual(events, [{
    type: "run.status",
    taskId: "task-1",
    runId: "run-1",
    sequence: 4,
    status: "failed",
    message: "Agent process exited with code 1.",
  }]);
});
