import assert from "node:assert/strict";
import test from "node:test";
import { isInternalRunCommand, isRunCommand, isRunEvent } from "../dist/main/contracts/ipc.js";

const command = {
  type: "start",
  taskId: "task-1",
  runId: "run-1",
  prompt: "inspect",
  workspaceId: "workspace-1",
  policy: "confirm",
};

test("external start commands carry only a workspace ID", () => {
  assert.equal(isRunCommand(command), true);
  assert.equal(isRunCommand({ ...command, workspaceRoot: "/tmp/project" }), false);
  assert.equal(isRunCommand({ ...command, projectless: true }), false);
  assert.equal(isRunCommand({ ...command, cwd: "/tmp/project" }), false);
  assert.equal(isRunCommand({ ...command, sessionId: "claude-session" }), false);
});

test("internal worker commands require a resolved root and projectless flag", () => {
  assert.equal(isInternalRunCommand({ ...command, workspaceRoot: "/tmp/project", projectless: false }), true);
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

test("run event guard accepts tool intents without a write path", () => {
  assert.equal(isRunEvent({
    type: "tool.intent",
    taskId: "task-1",
    runId: "run-1",
    sequence: 1,
    intent: { toolId: "tool-1", name: "Read", input: {}, writePath: undefined },
  }), true);
});
