import assert from "node:assert/strict";
import test from "node:test";
import { applyRunEvent } from "../dist/main/application/task-workspace.js";
import { ClaudeAgentProvider } from "../dist/main/main/agent/claude-agent-provider.mjs";
import { RunCoordinator } from "../dist/main/main/agent/run-coordinator.mjs";

const base = (taskId, runId) => ({
  type: "start",
  channel: "main",
  taskId,
  runId,
  prompt: "do the work",
  workspaceRoot: "/tmp/project",
  projectless: false,
  computerUse: { status: "unavailable", message: "test" },
  policy: "confirm",
  model: "opus",
  effort: "high",
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

test("Claude subagent events reach correlated renderer state", async () => {
  let closed = false;
  const provider = new ClaudeAgentProvider(() => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", session_id: "session-1" };
      yield { type: "system", subtype: "task_started", task_id: "agent-1", tool_use_id: "parent-tool", subagent_type: "Explore", description: "Inspect the renderer" };
      yield {
        type: "assistant",
        uuid: "child-message",
        parent_tool_use_id: "parent-tool",
        message: { content: [
          { type: "text", text: "Reading the renderer" },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "src/renderer/App.tsx" } },
        ] },
      };
      yield { type: "system", subtype: "task_progress", task_id: "agent-1", subagent_type: "Explore", description: "Inspect the renderer", last_tool_name: "Read", summary: "Renderer inspected", usage: { total_tokens: 321 } };
      yield { type: "system", subtype: "task_notification", task_id: "agent-1", status: "completed", summary: "Renderer inspected" };
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    },
    close() {
      closed = true;
    },
  }));
  const events = [];
  let resolveTerminal;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const coordinator = new RunCoordinator(provider, (event) => {
    events.push(event);
    if (event.type === "run.status" && event.status === "succeeded") resolveTerminal();
  });

  coordinator.start(base("task-v", "run-v"));
  await terminal;

  let state = {
    tasks: [{ id: "task-v", title: "Vertical flow", executionPolicy: "confirm", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 }],
    activeRuns: { "task-v": { taskId: "task-v", runId: "run-v", sequence: 0, status: "running" } },
    runStatuses: { "task-v": "running" },
    approvals: {},
    streamingTails: {},
    backgroundProcesses: {},
    workflows: {},
  };
  for (const event of events) state = applyRunEvent(state, event);

  const subagent = state.tasks[0].subagents[0];
  assert.equal(closed, true);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(state.tasks[0].continuation, { provider: "claude", value: "session-1" });
  assert.deepEqual(
    { id: subagent.id, description: subagent.description, agentType: subagent.agentType, status: subagent.status, lastToolName: subagent.lastToolName, summary: subagent.summary, totalTokens: subagent.totalTokens },
    { id: "agent-1", description: "Inspect the renderer", agentType: "Explore", status: "completed", lastToolName: "Read", summary: "Renderer inspected", totalTokens: 321 },
  );
  assert.deepEqual(subagent.activity.map(({ id, kind, title, text }) => ({ id, kind, title, text })), [
    { id: "child-message:text", kind: "text", title: undefined, text: "Reading the renderer" },
    { id: "read-1", kind: "tool", title: "Read", text: JSON.stringify({ file_path: "src/renderer/App.tsx" }, null, 2) },
  ]);
  assert.equal(state.activeRuns["task-v"], undefined);
});

test("coordinator forwards every provider event with one ordered sequence", async () => {
  const events = [];
  const providerEvents = [
    { type: "assistant", messageId: "message-1", text: "hello" },
    { type: "usage", tokens: 10, limit: 200_000, model: "claude" },
    { type: "compaction-status", compacting: true },
    { type: "compaction", trigger: "manual", preTokens: 10 },
    { type: "tool", intent: { toolId: "tool-1", name: "Read", input: {} } },
    { type: "continuation", continuation: { provider: "claude", value: "session-1" } },
  ];
  const provider = { execute: async (input) => {
    for (const event of providerEvents) input.emit(event);
    return { status: "succeeded" };
  } };
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-events", "run-events"));
  await tick();

  assert.deepEqual(events.slice(2, -1).map((event) => event.type), ["assistant.delta", "context.usage", "context.compaction-status", "context.compacted", "tool.intent", "continuation.updated"]);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.equal(events.at(-1).status, "succeeded");
});

test("coordinator converts a thrown provider error into one failure", async () => {
  const events = [];
  const coordinator = new RunCoordinator({ execute: async () => { throw new Error("provider exploded"); } }, (event) => events.push(event));

  coordinator.start(base("task-throw", "run-throw"));
  await tick();

  assert.deepEqual(statuses(events, "run-throw"), ["running", "failed"]);
  assert.equal(events.at(-1).message, "provider exploded");
});

test("runs for different tasks stay live together and each ends on its own", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-1", "run-1"));
  coordinator.start(base("task-2", "run-2"));
  await tick();
  provider.runs[0].input.emit({ type: "assistant", messageId: "message-1", text: "from one" });
  provider.runs[1].input.emit({ type: "assistant", messageId: "message-2", text: "from two" });
  provider.runs[0].resolve({ status: "succeeded" });
  await tick();
  provider.runs[1].input.emit({ type: "assistant", messageId: "message-2", text: "still going" });
  provider.runs[1].resolve({ status: "succeeded" });
  await tick();

  assert.deepEqual(statuses(events, "run-1"), ["running", "succeeded"]);
  assert.deepEqual(statuses(events, "run-2"), ["running", "succeeded"]);
  assert.equal(events.filter((event) => event.runId === "run-2" && event.type === "assistant.delta").length, 2);
  assert.equal(coordinator.cancel("task-2", "run-2"), false);
});

test("a new run for the same task supersedes the previous one", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-1", "run-first"));
  await tick();
  coordinator.start(base("task-1", "run-second"));
  await tick();
  provider.runs[0].input.emit({ type: "assistant", messageId: "late", text: "late output" });
  provider.runs[0].resolve({ status: "succeeded" });
  provider.runs[1].resolve({ status: "succeeded" });
  await tick();

  assert.equal(provider.runs[0].input.abortController.signal.aborted, true);
  assert.equal(events.some((event) => event.runId === "run-first" && event.type === "assistant.delta"), false);
  assert.deepEqual(statuses(events, "run-first"), ["running", "cancelled"]);
  assert.deepEqual(statuses(events, "run-second"), ["running", "succeeded"]);
});

test("steering only reaches the run it names, and delivery is reported against that run", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-a", "run-a"));
  await tick();
  const { input } = provider.runs[0];

  assert.equal(coordinator.steer("task-a", "run-b", "message-1", "later"), false, "a superseded run cannot be steered");
  assert.equal(coordinator.steer("task-b", "run-a", "message-1", "later"), false, "another task's run cannot be steered");
  assert.equal(coordinator.steer("task-a", "run-a", "message-1", "check the tests"), true);
  assert.deepEqual(await input.steering.next(), { messageId: "message-1", prompt: "check the tests" });

  input.emit({ type: "steered", messageId: "message-1" });
  assert.deepEqual(
    events.filter((event) => event.type === "queued.delivered").map((event) => ({ runId: event.runId, messageId: event.messageId })),
    [{ runId: "run-a", messageId: "message-1" }],
  );

  provider.runs[0].resolve({ status: "succeeded" });
  await tick();
  assert.equal(coordinator.steer("task-a", "run-a", "message-2", "too late"), false);
  assert.equal(await input.steering.next(), null, "a finished run stops waiting for more");
});

test("a burst of tails collapses to one leading and one trailing update", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event), { tailIntervalMs: 20 });

  coordinator.start(base("task-t", "run-t"));
  await tick();
  const { emit } = provider.runs[0].input;
  for (const text of ["The", "The first", "The first thing", "The first thing to"]) emit({ type: "assistant-tail", messageId: "message-1", text });

  const leading = events.filter((event) => event.type === "assistant.tail");
  assert.deepEqual(leading.map((event) => event.text), ["The"], "the first tail shows immediately");

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(
    events.filter((event) => event.type === "assistant.tail").map((event) => event.text),
    ["The", "The first thing to"],
    "the newest text still lands once the window closes, so the tail never stalls short",
  );

  provider.runs[0].resolve({ status: "succeeded" });
  await tick();
});

test("a committed block cancels the tail it already contains", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event), { tailIntervalMs: 20 });

  coordinator.start(base("task-c", "run-c"));
  await tick();
  const { emit } = provider.runs[0].input;
  emit({ type: "assistant-tail", messageId: "message-1", text: "Opening" });
  emit({ type: "assistant-tail", messageId: "message-1", text: "Opening line." });
  emit({ type: "assistant", messageId: "message-1", text: "Opening line.\n\n", append: true });
  emit({ type: "assistant-tail", messageId: "message-1", text: "" });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("assistant")).map((event) => [event.type, event.text]),
    [["assistant.tail", "Opening"], ["assistant.delta", "Opening line.\n\n"], ["assistant.tail", ""]],
    "no tail lands after the delta that already carries its text",
  );

  provider.runs[0].resolve({ status: "succeeded" });
  await tick();
});

test("a run that ends mid-stream publishes no further tail", async () => {
  const provider = new FakeProvider();
  const events = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event), { tailIntervalMs: 20 });

  coordinator.start(base("task-e", "run-e"));
  await tick();
  const { emit } = provider.runs[0].input;
  emit({ type: "assistant-tail", messageId: "message-1", text: "Started" });
  emit({ type: "assistant-tail", messageId: "message-1", text: "Started writing" });
  provider.runs[0].resolve({ status: "cancelled" });
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(events.filter((event) => event.type === "assistant.tail").map((event) => event.text), ["Started"]);
  assert.equal(events.at(-1).type, "run.status");
});

test("each run reaches the workspace through a bridge scoped to its own thread", async () => {
  const provider = new FakeProvider();
  const bridges = [];
  const coordinator = new RunCoordinator(provider, () => {}, {
    threads: (taskId) => { bridges.push(taskId); return { taskId }; },
  });

  coordinator.start(base("task-a", "run-a"));
  coordinator.start(base("task-b", "run-b"));
  await tick();

  assert.deepEqual(bridges, ["task-a", "task-b"]);
  assert.deepEqual(provider.runs.map((run) => run.input.threads.taskId), ["task-a", "task-b"]);
});

test("stopping a background process reaches the live run's session, and only that run", async () => {
  const provider = new FakeProvider();
  const coordinator = new RunCoordinator(provider, () => {});

  coordinator.start(base("task-p", "run-p"));
  await tick();
  assert.equal(coordinator.stopProcess("task-p", "run-p", "bash-1"), false, "nothing to stop before the session is live");

  const stopped = [];
  provider.runs[0].input.attach({ stopProcess: async (processId) => { stopped.push(processId); } });
  assert.equal(coordinator.stopProcess("task-p", "run-stale", "bash-1"), false);
  assert.equal(coordinator.stopProcess("task-q", "run-p", "bash-1"), false);
  assert.equal(coordinator.stopProcess("task-p", "run-p", "bash-1"), true);
  await tick();

  assert.deepEqual(stopped, ["bash-1"]);
});
