import assert from "node:assert/strict";
import test from "node:test";
import { isAutomationAck, isAutomationRequest, isAutomationResponse, isInternalRunCommand, isRunCommand, isRunEvent } from "../dist/main/contracts/ipc.js";

const command = {
  type: "start",
  channel: "main",
  taskId: "task-1",
  runId: "run-1",
  prompt: "inspect",
  workspaceId: "workspace-1",
  policy: "confirm",
  model: "opus",
};

test("external start commands carry only a workspace ID", () => {
  assert.equal(isRunCommand(command), true);
  assert.equal(isRunCommand({ ...command, workspaceRoot: "/tmp/project" }), false);
  assert.equal(isRunCommand({ ...command, projectless: true }), false);
  assert.equal(isRunCommand({ ...command, computerUse: { status: "setup-required" } }), false);
  assert.equal(isRunCommand({ ...command, cwd: "/tmp/project" }), false);
  assert.equal(isRunCommand({ ...command, sessionId: "claude-session" }), false);
  assert.equal(isRunCommand({ ...command, channel: "background" }), false);
  assert.equal(isRunCommand({ ...command, channel: "side", forkContinuation: true }), false);
  assert.equal(isRunCommand({ ...command, channel: "side", continuation: { provider: "claude", value: "session" }, forkContinuation: true }), true);
});

test("internal worker commands require a resolved root and projectless flag", () => {
  assert.equal(isInternalRunCommand({ ...command, workspaceRoot: "/tmp/project", projectless: false, computerUse: { status: "setup-required" } }), true);
  assert.equal(isInternalRunCommand(command), false);
  assert.equal(isInternalRunCommand({ ...command, workspaceRoot: "/tmp/project" }), false);
});

test("run command guard scopes cancellation and approval", () => {
  assert.equal(isRunCommand({ type: "cancel", taskId: "task-1", runId: "run-1" }), true);
  assert.equal(isRunCommand({ type: "cancel" }), false);
  assert.equal(isRunCommand({ type: "approval", taskId: "task-1", runId: "run-1", approvalId: "approval-1", allow: false }), true);
  assert.equal(isRunCommand({ type: "approval", approvalId: "approval-1", allow: false }), false);
});

test("run event guard validates optional status messages", () => {
  const event = { type: "run.status", taskId: "task-1", runId: "run-1", sequence: 1, status: "failed" };
  assert.equal(isRunEvent({ ...event, message: "failed" }), true);
  assert.equal(isRunEvent({ ...event, message: 42 }), false);
});

test("run event guard accepts the computer-use setup signal", () => {
  assert.equal(isRunEvent({ type: "computer-use.setup-required", taskId: "task-1", runId: "run-1", sequence: 1 }), true);
});

test("run event guard accepts tool intents without a write path", () => {
  assert.equal(isRunEvent({
    type: "tool.intent",
    taskId: "task-1",
    runId: "run-1",
    sequence: 1,
    intent: { toolId: "tool-1", name: "Read", input: {}, writePath: undefined },
  }), true);
});

test("run event guard validates every subagent event", () => {
  const base = { taskId: "task-1", runId: "run-1", sequence: 1, id: "agent-1" };
  const valid = [
    { ...base, type: "subagent.started", description: "Inspect", agentType: "Explore" },
    { ...base, type: "subagent.progress", description: "Inspect", lastToolName: "Read", summary: "Done", totalTokens: 42 },
    { ...base, type: "subagent.activity", activityId: "activity-1", kind: "text", text: "Working" },
    { ...base, type: "subagent.activity", activityId: "activity-2", kind: "tool", title: "Read", text: "{}" },
    { ...base, type: "subagent.finished", status: "completed", summary: "Done" },
    { ...base, type: "subagent.finished", status: "failed", summary: "Failed" },
    { ...base, type: "subagent.finished", status: "stopped", summary: "" },
  ];
  for (const event of valid) assert.equal(isRunEvent(event), true, event.type);

  const invalid = [
    { ...valid[0], description: "" },
    { ...valid[1], totalTokens: -1 },
    { ...valid[1], totalTokens: Number.NaN },
    { ...valid[2], activityId: "" },
    { ...valid[2], kind: "image" },
    { ...valid[3], title: 42 },
    { ...valid[4], status: "working" },
    { ...valid[4], summary: 42 },
  ];
  for (const event of invalid) assert.equal(isRunEvent(event), false, JSON.stringify(event));
});

test("run guards enforce numeric and string boundaries", () => {
  assert.equal(isRunCommand({ ...command, taskId: "x".repeat(256), prompt: "x".repeat(1_000_000) }), true);
  assert.equal(isRunCommand({ ...command, taskId: "x".repeat(257) }), false);
  assert.equal(isRunCommand({ ...command, prompt: "x".repeat(1_000_001) }), false);
  assert.equal(isRunCommand({ ...command, model: "future-model" }), false);
  assert.equal(isRunCommand({ ...command, continuation: { provider: "", value: "session" } }), false);

  const usage = { type: "context.usage", taskId: "task-1", runId: "run-1", sequence: 1, tokens: 0, limit: 1, model: "claude" };
  assert.equal(isRunEvent(usage), true);
  assert.equal(isRunEvent({ ...usage, sequence: 0 }), false);
  assert.equal(isRunEvent({ ...usage, sequence: 1.5 }), false);
  assert.equal(isRunEvent({ ...usage, tokens: -1 }), false);
  assert.equal(isRunEvent({ ...usage, limit: 0 }), false);
});

const automationRequest = { type: "automation.request", requestId: "request-1", taskId: "task-1" };

test("automation requests carry a task and a well-formed payload", () => {
  assert.equal(isAutomationRequest({ ...automationRequest, op: "read" }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "list" }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "delete" }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "save", draft: { prompt: "poll", schedule: "* * * * *" } }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "update", patch: { paused: true } }), true);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "update", patch: {} }), true);

  assert.equal(isAutomationRequest({ ...automationRequest, op: "save" }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "save", draft: { schedule: "* * * * *" } }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "save", draft: { prompt: "poll", schedule: "* * * * *", policy: "root" } }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "update", patch: { paused: "yes" } }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "explode" }), false);
  assert.equal(isAutomationRequest({ type: "automation.request", requestId: "request-1", op: "read" }), false);
  assert.equal(isAutomationRequest({ ...automationRequest, op: "save", draft: { prompt: "", schedule: "* * * * *" } }), false);
});

test("automation responses and acknowledgements are correlated and typed", () => {
  assert.equal(isAutomationResponse({ type: "automation.response", requestId: "request-1", ok: true, result: null }), true);
  assert.equal(isAutomationResponse({ type: "automation.response", requestId: "request-1", ok: false, message: "no automation" }), true);
  assert.equal(isAutomationResponse({ type: "automation.response", requestId: "request-1", ok: false }), false);
  assert.equal(isAutomationResponse({ type: "automation.response", ok: true, result: null }), false);
  assert.equal(isAutomationResponse({ type: "run.status", requestId: "request-1", ok: true }), false);

  assert.equal(isAutomationAck({ automationId: "automation-1", runId: "run-1", started: true }), true);
  assert.equal(isAutomationAck({ automationId: "automation-1", runId: "run-1" }), false);
  assert.equal(isAutomationAck({ automationId: "automation-1", started: false }), false);
});
