import assert from "node:assert/strict";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { test } from "vitest";
import { applyRunEvent, type RunTransitionState } from "../../../src/application/task-workspace.ts";
import type { AgentEvent, InternalStartRunCommand, RunEvent } from "../../../src/contracts/ipc.ts";
import type { ThreadBridge, AgentProvider, ProviderEvent, ProviderResult, ProviderRunInput } from "../../../src/main/agent/agent-provider.mts";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { RunCoordinator } from "../../../src/main/agent/run-coordinator.mts";

const base = (taskId: string, runId: string): InternalStartRunCommand => ({
  type: "start",
  channel: "main",
  taskId,
  runId,
  prompt: "do the work",
  workspaceId: "workspace-test",
  workspaceRoot: "/tmp/project",
  projectless: false,
  computerUse: { status: "unavailable", message: "test" },
  policy: "confirm",
  engine: "claude",
  model: "opus",
  effort: "high",
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type PendingRun = {
  input: ProviderRunInput;
  resolve: (result: ProviderResult) => void;
};

class FakeProvider implements AgentProvider {
  runs: PendingRun[] = [];
  stopped: Array<[string, string]> = [];

  execute(input: ProviderRunInput): Promise<ProviderResult> {
    return new Promise((resolve) => this.runs.push({ input, resolve }));
  }

  stopProcess(taskId: string, processId: string) {
    if (!this.runs.some((run) => run.input.taskId === taskId)) return false;
    this.stopped.push([taskId, processId]);
    return true;
  }
}

function statuses(events: AgentEvent[], runId: string) {
  return events
    .filter((event): event is Extract<RunEvent, { type: "run.status" }> => event.type === "run.status" && event.runId === runId)
    .map((event) => event.status);
}

function runEvents(events: AgentEvent[]): RunEvent[] {
  return events.filter((event): event is RunEvent => "runId" in event);
}

function eventsFor(events: AgentEvent[], runId: string): RunEvent[] {
  return runEvents(events).filter((event) => event.runId === runId);
}

test("successful provider run emits correlated, ordered events and one terminal state", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-a", "run-a"));
  await tick();
  provider.runs[0].resolve({ status: "succeeded" });
  await tick();

  assert.deepEqual(statuses(events, "run-a"), ["running", "succeeded"]);
  assert.deepEqual(eventsFor(events, "run-a").map((event) => event.sequence), [1, 2, 3]);
  assert.equal(eventsFor(events, "run-a").filter((event) => event.type === "run.status" && ["succeeded", "failed", "cancelled"].includes(event.status)).length, 1);
});

test("the coordinator carries a manual compaction operation to Codex", async () => {
  const provider = new FakeProvider();
  const coordinator = new RunCoordinator(provider, () => {});
  coordinator.start({
    ...base("task-c", "run-c"),
    prompt: "",
    engine: "codex",
    model: "gpt-5.6-sol",
    continuation: { provider: "codex", value: "thread-1" },
    operation: { type: "compact", preTokens: 125_000 },
  });
  await tick();

  assert.deepEqual(provider.runs[0].input.operation, { type: "compact", preTokens: 125_000 });
  provider.runs[0].resolve({ status: "succeeded" });
});

test("provider failure remains correlated and terminal", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-f", "run-f"));
  await tick();
  provider.runs[0].resolve({ status: "failed", message: "provider failed" });
  await tick();

  assert.deepEqual(statuses(events, "run-f"), ["running", "failed"]);
  const terminal = events.at(-1);
  assert.ok(terminal?.type === "run.status");
  assert.equal(terminal.message, "provider failed");
});

test("late output from a cancelled run cannot reach the replacement run", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
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

  assert.equal(eventsFor(events, "run-old").some((event) => event.type === "assistant.delta"), false);
  assert.deepEqual(statuses(events, "run-old"), ["running", "cancelled"]);
  assert.deepEqual(statuses(events, "run-new"), ["running", "succeeded"]);
});

test("a workflow's report reaches the thread once its run is over", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-w", "run-w"));
  await tick();
  const { input, resolve } = provider.runs[0];
  input.reportWorkflow({ type: "workflow.started", id: "wf-1", name: "review-changes", description: "Review changed files" });
  resolve({ status: "succeeded" });
  await tick();
  input.reportWorkflow({ type: "workflow.finished", id: "wf-1", status: "completed", summary: "Dynamic workflow completed" });

  assert.deepEqual(events.filter((event) => event.type.startsWith("workflow.")), [
    { type: "workflow.started", id: "wf-1", name: "review-changes", description: "Review changed files", taskId: "task-w" },
    { type: "workflow.finished", id: "wf-1", status: "completed", summary: "Dynamic workflow completed", taskId: "task-w" },
  ], "a settled run is no reason to hold back what its workflow is still doing");
  assert.deepEqual(statuses(events, "run-w"), ["running", "succeeded"]);
});

test("approval is scoped to the run and resumes only after its decision", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
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
  const events: AgentEvent[] = [];
  let decision: Awaited<ReturnType<ProviderRunInput["authorize"]>> | undefined;
  const provider: AgentProvider = {
    execute: async (input: ProviderRunInput) => {
      decision = await input.authorize({ toolId: "tool-2", name: "Edit", input: {}, writePath: "/tmp/project/file.txt" });
      return { status: decision === "allow" ? "succeeded" : "failed" };
    },
    stopProcess: () => false,
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
  assert.equal(eventsFor(events, "run-c").filter((event) => event.type === "run.status" && ["succeeded", "failed", "cancelled"].includes(event.status)).length, 1);
});

test("a scheduled run answers the approval nobody is there to answer, with wording it can act on", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event), { unattendedApprovalMs: 10 });

  coordinator.start({ ...base("task-u", "run-u"), unattended: true });
  await tick();
  const asked = provider.runs[0].input.authorize({ toolId: "tool-u", name: "Bash", input: {} });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const answer = await asked;
  assert.ok(typeof answer === "object");
  assert.match(answer.deny, /scheduled run/);
  assert.deepEqual(statuses(events, "run-u"), ["running", "awaiting-approval", "running"], "the run carries on rather than sitting parked");
});

test("an approval only ever answers itself for a run nobody is watching", async () => {
  const provider = new FakeProvider();
  const coordinator = new RunCoordinator(provider, () => {}, { unattendedApprovalMs: 10 });

  coordinator.start(base("task-a", "run-a"));
  coordinator.start({ ...base("task-s", "run-s"), unattended: true });
  await tick();
  /** A human steering in is present by definition, so their run's questions go back to waiting for them. */
  assert.equal(coordinator.steer("task-s", "run-s", "message-1", "check staging too"), true);

  const answered: string[] = [];
  for (const run of provider.runs) void run.input.authorize({ toolId: "tool-1", name: "Bash", input: {} }).then(() => answered.push(run.input.taskId));
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.deepEqual(answered, [], "a question put to a person waits for that person");
});

test("write-path policy denies outside paths before creating an approval", async () => {
  const events: AgentEvent[] = [];
  const provider: AgentProvider = {
    execute: async (input: ProviderRunInput) => {
      const decision = await input.authorize({ toolId: "tool-3", name: "Write", input: {}, writePath: "/tmp/elsewhere/file.txt" });
      return { status: decision === "deny" ? "failed" : "succeeded", message: "outside path" };
    },
    stopProcess: () => false,
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
  }) as unknown as Query);
  const events: AgentEvent[] = [];
  let resolveTerminal: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  const coordinator = new RunCoordinator(provider, (event) => {
    events.push(event);
    if (event.type === "run.status" && event.status === "succeeded") resolveTerminal?.();
  });

  coordinator.start(base("task-v", "run-v"));
  await terminal;

  let state: RunTransitionState = {
    tasks: [{ id: "task-v", title: "Vertical flow", engine: "claude", executionPolicy: "confirm", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 }],
    activeRuns: { "task-v": {
      taskId: "task-v",
      runId: "run-v",
      sequence: 0,
      status: "running",
      origin: "composer",
      quiet: false,
      notified: false,
      acknowledged: false,
      reportedIssues: [],
      messagesBefore: 0,
      before: { updatedAt: 1 },
    } },
    runStatuses: { "task-v": "running" },
    approvals: {},
    streamingTails: {},
    backgroundProcesses: {},
    workflows: {},
  };
  for (const event of runEvents(events)) state = applyRunEvent(state, event);

  const task = state.tasks[0];
  assert.ok(task);
  const subagent = task.subagents?.[0];
  assert.ok(subagent);
  assert.equal(closed, true);
  assert.deepEqual(runEvents(events).map((event) => event.sequence), runEvents(events).map((_, index) => index + 1));
  assert.deepEqual(task.continuation, { provider: "claude", value: "session-1" });
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
  const events: AgentEvent[] = [];
  const providerEvents: ProviderEvent[] = [
    { type: "assistant", messageId: "message-1", text: "hello" },
    { type: "usage", tokens: 10, limit: 200_000, model: "claude" },
    { type: "compaction-status", compacting: true },
    { type: "compaction", trigger: "manual", preTokens: 10 },
    { type: "tool", intent: { toolId: "tool-1", name: "Read", input: {} } },
    { type: "continuation", continuation: { provider: "claude", value: "session-1" } },
  ];
  const provider: AgentProvider = { execute: async (input: ProviderRunInput) => {
    for (const event of providerEvents) input.emit(event);
    return { status: "succeeded" };
  }, stopProcess: () => false };
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-events", "run-events"));
  await tick();

  assert.deepEqual(events.slice(2, -1).map((event) => event.type), ["assistant.delta", "context.usage", "context.compaction-status", "context.compacted", "tool.intent", "continuation.updated"]);
  assert.deepEqual(runEvents(events).map((event) => event.sequence), runEvents(events).map((_, index) => index + 1));
  const terminal = events.at(-1);
  assert.ok(terminal?.type === "run.status");
  assert.equal(terminal.status, "succeeded");
});

test("coordinator converts a thrown provider error into one failure", async () => {
  const events: AgentEvent[] = [];
  const coordinator = new RunCoordinator({ execute: async () => { throw new Error("provider exploded"); }, stopProcess: () => false }, (event) => events.push(event));

  coordinator.start(base("task-throw", "run-throw"));
  await tick();

  assert.deepEqual(statuses(events, "run-throw"), ["running", "failed"]);
  const terminal = events.at(-1);
  assert.ok(terminal?.type === "run.status");
  assert.equal(terminal.message, "provider exploded");
});

test("runs for different tasks stay live together and each ends on its own", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
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
  assert.equal(eventsFor(events, "run-2").filter((event) => event.type === "assistant.delta").length, 2);
  assert.equal(coordinator.cancel("task-2", "run-2"), false);
});

test("a new run for the same task supersedes the previous one", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
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
  assert.equal(eventsFor(events, "run-first").some((event) => event.type === "assistant.delta"), false);
  assert.deepEqual(statuses(events, "run-first"), ["running", "cancelled"]);
  assert.deepEqual(statuses(events, "run-second"), ["running", "succeeded"]);
});

test("steering only reaches the run it names, and delivery is reported against that run", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
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
  const events: AgentEvent[] = [];
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
  const events: AgentEvent[] = [];
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
    events.filter((event): event is Extract<RunEvent, { type: "assistant.delta" | "assistant.tail" }> => event.type === "assistant.delta" || event.type === "assistant.tail").map((event) => [event.type, event.text]),
    [["assistant.tail", "Opening"], ["assistant.delta", "Opening line.\n\n"], ["assistant.tail", ""]],
    "no tail lands after the delta that already carries its text",
  );

  provider.runs[0].resolve({ status: "succeeded" });
  await tick();
});

test("a run that ends mid-stream publishes no further tail", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
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
  assert.equal(events.at(-1)?.type, "run.status");
});

test("each run reaches the workspace through a bridge scoped to its own thread", async () => {
  const provider = new FakeProvider();
  const bridges: string[] = [];
  const coordinator = new RunCoordinator(provider, () => {}, {
    threads: (taskId) => { bridges.push(taskId); return { taskId } as unknown as ThreadBridge; },
  });

  coordinator.start(base("task-a", "run-a"));
  coordinator.start(base("task-b", "run-b"));
  await tick();

  assert.deepEqual(bridges, ["task-a", "task-b"]);
  assert.deepEqual(provider.runs.map((run) => (run.input.threads as ThreadBridge & { taskId: string }).taskId), ["task-a", "task-b"]);
});

test("stopping a background process reaches the thread's session, with or without a run", async () => {
  const provider = new FakeProvider();
  const coordinator = new RunCoordinator(provider, () => {});

  assert.equal(coordinator.stopProcess("task-p", "bash-1"), false, "nothing to stop before the session is live");

  coordinator.start(base("task-p", "run-p"));
  await tick();
  assert.equal(coordinator.stopProcess("task-p", "bash-1"), true);
  provider.runs[0].resolve({ status: "succeeded" });
  await tick();
  assert.equal(coordinator.stopProcess("task-p", "wf-1"), true, "a workflow outlives its run and is still stoppable");

  assert.deepEqual(provider.stopped, [["task-p", "bash-1"], ["task-p", "wf-1"]]);
});

test("a turn the agent starts itself is given a run of its own", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-u", "run-u"));
  await tick();
  assert.equal(provider.runs[0].input.beginAgentTurn(), null, "the thread already has a run of its own");

  provider.runs[0].resolve({ status: "succeeded" });
  await tick();
  const agentTurn = provider.runs[0].input.beginAgentTurn();
  assert.ok(agentTurn);
  agentTurn.emit({ type: "assistant", messageId: "m-1", text: "The workflow finished." });
  agentTurn.end({ status: "succeeded" });

  const opened = events.find((event) => event.type === "run.started" && event.runId !== "run-u");
  assert.ok(opened?.type === "run.started");
  assert.equal(opened.agentInitiated, true);
  const own = eventsFor(events, opened.runId);
  assert.deepEqual(own.map((event) => event.type), ["run.started", "run.status", "assistant.delta", "run.status"]);
  assert.deepEqual(own.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(statuses(events, opened.runId), ["running", "succeeded"]);
});

test("a turn the agent starts itself can be steered into, and hands what it is sent on", async () => {
  const provider = new FakeProvider();
  const events: AgentEvent[] = [];
  const coordinator = new RunCoordinator(provider, (event) => events.push(event));

  coordinator.start(base("task-v", "run-v"));
  await tick();
  provider.runs[0].resolve({ status: "succeeded" });
  await tick();

  const agentTurn = provider.runs[0].input.beginAgentTurn();
  assert.ok(agentTurn);
  const opened = events.find((event) => event.type === "run.started" && event.runId !== "run-v");
  assert.ok(opened?.type === "run.started");
  assert.equal(coordinator.steer("task-v", opened.runId, "message-1", "stop and read this"), true);
  assert.deepEqual(await agentTurn.steering.next(), { messageId: "message-1", prompt: "stop and read this" });

  agentTurn.end({ status: "succeeded" });
  assert.equal(await agentTurn.steering.next(), null, "a turn that is over stops waiting for more");
});
