import assert from "node:assert/strict";
import test from "node:test";
import { RunCoordinator } from "../dist/main/main/agent/run-coordinator.mjs";

const base = (taskId, runId) => ({
  type: "start",
  taskId,
  runId,
  prompt: "do the work",
  workspaceRoot: "/tmp/project",
  projectless: false,
  policy: "confirm",
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeProvider {
  runs = [];

  execute(input) {
    return new Promise((resolve) => this.runs.push({ input, resolve }));
  }
}

function statuses(events, runId) {
  return events.filter((event) => event.runId === runId && event.type === "run.status").map((event) => event.status);
}

test("successful provider run emits correlated, ordered events and one terminal state", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-a", "run-a"));
  await tick();
  provider.runs[0].resolve({ status: "succeeded" });
  await tick();

  assert.deepEqual(statuses(events, "run-a"), ["running", "succeeded"]);
  assert.deepEqual(events.filter((event) => event.runId === "run-a").map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events.filter((event) => event.runId === "run-a" && ["succeeded", "failed", "cancelled"].includes(event.status)).length, 1);
});

test("provider failure remains correlated and terminal", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-f", "run-f"));
  await tick();
  provider.runs[0].resolve({ status: "failed", message: "provider failed" });
  await tick();

  assert.deepEqual(statuses(events, "run-f"), ["running", "failed"]);
  assert.equal(events.at(-1).message, "provider failed");
});

test("late output from a cancelled run cannot reach the replacement run", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-old", "run-old"));
  await tick();
  const oldRun = provider.runs[0];
  assert.equal(coordinator.cancel("task-old", "run-old"), true);
  coordinator.start(base("task-new", "run-new"));
  await tick();
  oldRun.input.emit({ type: "assistant", messageId: "late", text: "late output" });
  oldRun.resolve({ status: "succeeded" });
  provider.runs[1].resolve({ status: "succeeded" });
  await tick();

  assert.equal(events.some((event) => event.runId === "run-old" && event.type === "assistant.delta"), false);
  assert.deepEqual(statuses(events, "run-old"), ["running", "cancelled"]);
  assert.deepEqual(statuses(events, "run-new"), ["running", "succeeded"]);
});

test("approval is scoped to the run and resumes only after its decision", async () => {
  const provider = new FakeProvider();
  const events = [];
  provider.execute = async (input) => {
    const decision = await input.authorize({
      toolId: "tool-1",
      name: "Write",
      input: { file_path: "/tmp/project/file.txt" },
      writePath: "/tmp/project/file.txt",
    });
    return { status: decision === "allow" ? "succeeded" : "failed" };
  };
  const coordinator = new RunCoordinator(provider, (event) => events.push(event), {
    isWritePathInside: () => true,
  });

  coordinator.start(base("task-p", "run-p"));
  await tick();
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  assert.deepEqual(statuses(events, "run-p"), ["running", "awaiting-approval"]);
  assert.equal(coordinator.decideApproval("task-p", "run-p", approval.approvalId, true), true);
  await tick();

  assert.deepEqual(statuses(events, "run-p"), ["running", "awaiting-approval", "running", "succeeded"]);
});

test("cancelling an approval expires it and rejects a late decision", async () => {
  const events = [];
  let decision;
  const provider = {
    execute: async (input) => {
      decision = await input.authorize({ toolId: "tool-2", name: "Edit", input: {}, writePath: "/tmp/project/file.txt" });
      return { status: decision === "allow" ? "succeeded" : "failed" };
    },
  };
  const coordinator = new RunCoordinator(provider, (event) => events.push(event), {
    isWritePathInside: () => true,
  });

  coordinator.start(base("task-c", "run-c"));
  await tick();
  const approval = events.find((event) => event.type === "approval.requested");
  assert.ok(approval);
  assert.equal(coordinator.cancel("task-c", "run-c"), true);
  assert.equal(coordinator.decideApproval("task-c", "run-c", approval.approvalId, true), false);
  await tick();

  assert.equal(decision, "deny");
  assert.deepEqual(statuses(events, "run-c"), ["running", "awaiting-approval", "cancelled"]);
  assert.equal(events.filter((event) => event.runId === "run-c" && ["succeeded", "failed", "cancelled"].includes(event.status)).length, 1);
});

test("write-path policy denies outside paths before creating an approval", async () => {
  const events = [];
  const provider = {
    execute: async (input) => {
      const decision = await input.authorize({ toolId: "tool-3", name: "Write", input: {}, writePath: "/tmp/elsewhere/file.txt" });
      return { status: decision === "deny" ? "failed" : "succeeded", message: "outside path" };
    },
  };
  const coordinator = new RunCoordinator(provider, (event) => events.push(event), {
    isWritePathInside: (root, candidate) => root === "/tmp/project" && candidate.startsWith(`${root}/`),
  });

  coordinator.start(base("task-w", "run-w"));
  await tick();

  assert.equal(events.some((event) => event.type === "approval.requested"), false);
  assert.deepEqual(statuses(events, "run-w"), ["running", "failed"]);
});
