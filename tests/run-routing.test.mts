import assert from "node:assert/strict";
import { test } from "vitest";
import { acceptRunEvent, AUTOMATION_SETTLE_TIMEOUT, failedEventsForTransportLoss, settledWithin, supersedePendingStarts } from "../src/main/run-routing.ts";

test("new start supersedes every older pending start and keeps the new one", () => {
  const pending = new Map([["old", { runId: "old" }], ["new", { runId: "new" }], ["older", { runId: "older" }]]);
  const superseded = supersedePendingStarts(pending, "new");
  assert.deepEqual(superseded, [["old", { runId: "old" }], ["older", { runId: "older" }]]);
  assert.deepEqual([...pending.keys()], ["new"]);
});

test("pending starts can be superseded within one run channel", () => {
  const pending = new Map([
    ["main-old", { channel: "main" }],
    ["side-old", { channel: "side" }],
    ["main-new", { channel: "main" }],
  ]);
  const superseded = supersedePendingStarts(pending, "main-new", (command) => command.channel === "main");
  assert.deepEqual(superseded, [["main-old", { channel: "main" }]]);
  assert.deepEqual([...pending.keys()], ["side-old", "main-new"]);
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

test("a scheduled run that never reports back is called failed instead of holding the schedule", async () => {
  assert.equal(await settledWithin(Promise.resolve("succeeded"), 10_000), "succeeded");
  assert.equal(await settledWithin(Promise.resolve("cancelled"), 10_000), "cancelled");
  assert.ok(AUTOMATION_SETTLE_TIMEOUT >= 60 * 60_000, "the bound is far longer than an honest run");

  const bounded = settledWithin(new Promise(() => {}), 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await bounded, "failed");
});
