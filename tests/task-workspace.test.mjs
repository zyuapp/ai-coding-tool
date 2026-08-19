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
    activeRuns: { "task-a": { taskId: "task-a", runId: "run-a", sequence: 0, status: "running" } },
    runStatuses: { "task-a": "running" },
    approvals: {},
    streamingTails: {},
  };
}

test("ignores events for another task and stale sequence numbers", () => {
  const initial = state();
  const otherTask = applyRunEvent(initial, { type: "assistant.delta", taskId: "task-b", runId: "run-b", sequence: 1, messageId: "message-b", text: "wrong" });
  assert.deepEqual(otherTask, initial);

  const updated = applyRunEvent(initial, { type: "assistant.delta", taskId: "task-a", runId: "run-a", sequence: 1, messageId: "message-a", text: "hello" });
  assert.equal(updated.tasks[0].messages[0].text, "hello");
  assert.equal(updated.activeRuns["task-a"].sequence, 1);
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

  assert.equal(finished.tasks[0].subagents[0].status, "completed");
  assert.equal(finished.tasks[0].subagents[0].activity[0].title, "Read");
  const terminal = applyRunEvent(active, { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 3, status: "succeeded" });
  assert.equal(terminal.tasks[0].subagents[0].status, "completed");
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
  assert.equal(awaiting.activeRuns["task-a"].status, "awaiting-approval");

  const finished = applyRunEvent(awaiting, { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 3, status: "cancelled" });
  assert.equal(finished.activeRuns["task-a"], undefined);
  assert.deepEqual(finished.approvals, {});
  assert.equal(finished.runStatuses["task-a"], "stopped");
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

  assert.equal(compacting.activeRuns["task-a"].status, "compacting");
  assert.equal(updated.activeRuns["task-a"].status, "running");
  assert.equal(updated.tasks[0].messages[0].text, "Context auto-compacted: 182,000 → 41,000 tokens.");
  assert.deepEqual(updated.tasks[0].contextUsage, { tokens: 41_000, limit: 200_000, model: "claude-sonnet" });
});

test("terminal runs finalize only working subagents", () => {
  for (const [runStatus, subagentStatus] of [["succeeded", "completed"], ["failed", "failed"], ["cancelled", "stopped"]]) {
    const initial = state();
    initial.tasks[0].subagents = [
      { id: "working", description: "Working", status: "working", startedAt: 1, activity: [] },
      { id: "done", description: "Done", status: "completed", startedAt: 1, finishedAt: 2, activity: [] },
    ];
    const terminal = applyRunEvent(initial, { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 1, status: runStatus });
    assert.equal(terminal.tasks[0].subagents[0].status, subagentStatus);
    assert.equal(typeof terminal.tasks[0].subagents[0].finishedAt, "number");
    assert.equal(terminal.tasks[0].subagents[1].status, "completed");
    assert.equal(terminal.tasks[0].subagents[1].finishedAt, 2);
  }
});

test("only a failure is toned as one; a compaction notice is not", () => {
  const failed = applyRunEvent(state(), { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 1, status: "failed", message: "provider failed" });
  assert.equal(failed.tasks[0].messages.at(-1).tone, "error");

  const compacted = applyRunEvent(state(), { type: "context.compacted", taskId: "task-a", runId: "run-a", sequence: 1, trigger: "auto", preTokens: 120_000, postTokens: 40_000 });
  assert.equal(compacted.tasks[0].messages.at(-1).tone, undefined);
});

test("subagent progress can arrive first and duplicate activity is ignored", () => {
  const progressed = applyRunEvent(state(), {
    type: "subagent.progress", taskId: "task-a", runId: "run-a", sequence: 1,
    id: "agent-1", description: "Inspect", lastToolName: "Read", summary: "Working", totalTokens: 10,
  });
  const activity = { type: "subagent.activity", taskId: "task-a", runId: "run-a", id: "agent-1", activityId: "same", kind: "text", text: "Only once" };
  const once = applyRunEvent(progressed, { ...activity, sequence: 2 });
  const twice = applyRunEvent(once, { ...activity, sequence: 3 });

  assert.equal(twice.tasks[0].subagents[0].status, "working");
  assert.equal(twice.tasks[0].subagents[0].startedAt > 0, true);
  assert.equal(twice.tasks[0].subagents[0].activity.length, 1);
});

test("assistant chunks, tool intents, and continuation updates preserve order", () => {
  const first = applyRunEvent(state(), { type: "assistant.delta", taskId: "task-a", runId: "run-a", sequence: 1, messageId: "message-1", text: "one" });
  const second = applyRunEvent(first, { type: "assistant.delta", taskId: "task-a", runId: "run-a", sequence: 2, messageId: "message-1", text: "two" });
  const tool = applyRunEvent(second, { type: "tool.intent", taskId: "task-a", runId: "run-a", sequence: 3, intent: { toolId: "tool-1", name: "Read", input: { file_path: "src/App.tsx" } } });
  const continued = applyRunEvent(tool, { type: "continuation.updated", taskId: "task-a", runId: "run-a", sequence: 4, continuation: { provider: "claude", value: "session-1" } });

  assert.equal(continued.tasks[0].messages[0].text, "one\ntwo");
  assert.equal(continued.tasks[0].messages[1].kind, "tool");
  assert.deepEqual(continued.tasks[0].continuation, { provider: "claude", value: "session-1" });
  assert.equal(continued.tasks[0].continuationStatus, "available");
});

test("streamed Markdown blocks append without injected newlines", () => {
  const first = applyRunEvent(state(), { type: "assistant.delta", taskId: "task-a", runId: "run-a", sequence: 1, messageId: "message-1", text: "## Title\n\n", append: true });
  const second = applyRunEvent(first, { type: "assistant.delta", taskId: "task-a", runId: "run-a", sequence: 2, messageId: "message-1", text: "Paragraph.", append: true });

  assert.equal(second.tasks[0].messages[0].text, "## Title\n\nParagraph.");
});

test("compaction failure and unknown post-token count remain visible", () => {
  const failed = applyRunEvent(state(), { type: "context.compaction-status", taskId: "task-a", runId: "run-a", sequence: 1, compacting: false, error: "Could not compact" });
  const compacted = applyRunEvent(failed, { type: "context.compacted", taskId: "task-a", runId: "run-a", sequence: 2, trigger: "manual", preTokens: 100_000 });

  assert.equal(failed.activeRuns["task-a"].status, "running");
  assert.equal(compacted.tasks[0].messages[0].text, "Could not compact");
  assert.equal(compacted.tasks[0].messages[1].text, "Context manual-compacted at 100,000 tokens.");
});

test("concurrent runs advance independently and finish one at a time", () => {
  const both = {
    ...state(),
    activeRuns: {
      "task-a": { taskId: "task-a", runId: "run-a", sequence: 0, status: "running" },
      "task-b": { taskId: "task-b", runId: "run-b", sequence: 0, status: "running" },
    },
    runStatuses: { "task-a": "running", "task-b": "running" },
  };

  const first = applyRunEvent(both, { type: "assistant.delta", taskId: "task-a", runId: "run-a", sequence: 1, messageId: "message-a", text: "from a" });
  const second = applyRunEvent(first, { type: "assistant.delta", taskId: "task-b", runId: "run-b", sequence: 1, messageId: "message-b", text: "from b" });

  assert.equal(second.tasks[0].messages[0].text, "from a");
  assert.equal(second.tasks[1].messages[0].text, "from b");

  const stopped = applyRunEvent(second, { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 2, status: "succeeded" });
  assert.equal(stopped.activeRuns["task-a"], undefined);
  assert.equal(stopped.runStatuses["task-a"], undefined);
  assert.equal(stopped.activeRuns["task-b"].runId, "run-b");
  assert.equal(stopped.runStatuses["task-b"], "running");

  const stillStreaming = applyRunEvent(stopped, { type: "assistant.delta", taskId: "task-b", runId: "run-b", sequence: 2, messageId: "message-b", text: "still going" });
  assert.equal(stillStreaming.tasks[1].messages[0].text, "from b\nstill going");
});
