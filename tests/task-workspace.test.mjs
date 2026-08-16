import assert from "node:assert/strict";
import test from "node:test";
import { applyRunEvent } from "../dist/main/application/task-workspace.js";

function task(id) {
  return {
    id,
    title: id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
  };
}

function state() {
  return {
    tasks: [task("task-a"), task("task-b")],
    activeRun: { taskId: "task-a", runId: "run-a", sequence: 0, status: "running" },
    lastRunStatus: "running",
    lastRunTaskId: "task-a",
    approvals: {},
    subagents: {},
  };
}

test("ignores events for another task and stale sequence numbers", () => {
  const initial = state();
  const otherTask = applyRunEvent(initial, { type: "assistant.delta", taskId: "task-b", runId: "run-b", sequence: 1, messageId: "message-b", text: "wrong" });
  assert.deepEqual(otherTask, initial);

  const updated = applyRunEvent(initial, { type: "assistant.delta", taskId: "task-a", runId: "run-a", sequence: 1, messageId: "message-a", text: "hello" });
  assert.equal(updated.tasks[0].messages[0].text, "hello");
  assert.equal(updated.activeRun.sequence, 1);
  assert.deepEqual(applyRunEvent(updated, { type: "assistant.delta", taskId: "task-a", runId: "run-a", sequence: 1, messageId: "message-a", text: "late" }), updated);
});

test("collects subagent progress and nested activity", () => {
  const started = applyRunEvent(state(), {
    type: "subagent.started",
    taskId: "task-a",
    runId: "run-a",
    sequence: 1,
    id: "agent-1",
    description: "Inspect the renderer",
    agentType: "Explore",
  });
  const active = applyRunEvent(started, {
    type: "subagent.activity",
    taskId: "task-a",
    runId: "run-a",
    sequence: 2,
    id: "agent-1",
    activityId: "tool-1",
    kind: "tool",
    title: "Read",
    text: "src/renderer/App.tsx",
  });
  const finished = applyRunEvent(active, {
    type: "subagent.finished",
    taskId: "task-a",
    runId: "run-a",
    sequence: 3,
    id: "agent-1",
    status: "completed",
    summary: "Renderer inspected",
  });

  assert.equal(finished.subagents["task-a"][0].status, "completed");
  assert.equal(finished.subagents["task-a"][0].activity[0].title, "Read");
  const terminal = applyRunEvent(active, { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 3, status: "succeeded" });
  assert.equal(terminal.subagents["task-a"][0].status, "completed");
});

test("scopes approvals and expires them on terminal state", () => {
  const requested = applyRunEvent(state(), {
    type: "approval.requested",
    taskId: "task-a",
    runId: "run-a",
    sequence: 1,
    approvalId: "approval-a",
    title: "Write needs approval",
    description: "Review the write.",
    intent: { toolId: "tool-a", name: "Write", input: { file_path: "src/App.tsx" } },
  });
  assert.equal(requested.approvals["run-a"].approvalId, "approval-a");

  const awaiting = applyRunEvent(requested, { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 2, status: "awaiting-approval" });
  assert.equal(awaiting.activeRun.status, "awaiting-approval");

  const finished = applyRunEvent(awaiting, { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 3, status: "cancelled" });
  assert.equal(finished.activeRun, null);
  assert.deepEqual(finished.approvals, {});
  assert.equal(finished.lastRunTaskId, "task-a");
  assert.equal(finished.lastRunStatus, "stopped");
});

test("stores the latest context usage for the active task", () => {
  const updated = applyRunEvent(state(), {
    type: "context.usage",
    taskId: "task-a",
    runId: "run-a",
    sequence: 1,
    tokens: 42_000,
    limit: 200_000,
    model: "claude-sonnet",
  });

  assert.deepEqual(updated.tasks[0].contextUsage, { tokens: 42_000, limit: 200_000, model: "claude-sonnet" });
});

test("records compaction and updates context usage", () => {
  const initial = state();
  initial.tasks[0].contextUsage = { tokens: 182_000, limit: 200_000, model: "claude-sonnet" };
  const compacting = applyRunEvent(initial, {
    type: "context.compaction-status",
    taskId: "task-a",
    runId: "run-a",
    sequence: 1,
    compacting: true,
  });
  const updated = applyRunEvent(compacting, {
    type: "context.compacted",
    taskId: "task-a",
    runId: "run-a",
    sequence: 2,
    trigger: "auto",
    preTokens: 182_000,
    postTokens: 41_000,
  });

  assert.equal(compacting.activeRun.status, "compacting");
  assert.equal(updated.activeRun.status, "running");
  assert.equal(updated.tasks[0].messages[0].text, "Context auto-compacted: 182,000 → 41,000 tokens.");
  assert.deepEqual(updated.tasks[0].contextUsage, { tokens: 41_000, limit: 200_000, model: "claude-sonnet" });
});
