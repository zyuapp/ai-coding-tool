import assert from "node:assert/strict";
import test from "node:test";
import { reduce, WORKSPACE_ERRORS } from "../dist/main/application/workspace-reducer.js";
import { deriveView, emptyWorkspaceState } from "../dist/main/application/workspace-state.js";
import { threadSummaries } from "../dist/main/application/thread-projection.js";

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

function workspace(overrides = {}) {
  return { ...emptyWorkspaceState(), ...overrides };
}

/** Drives a command and the events its effects would produce, the way the renderer does. */
function run(state, inputs) {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

test("a composer send waits for its workspace, then starts the run and clears the draft", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  assert.deepEqual(sending.effects, [{ type: "resolve-run-workspace", pendingId: Object.keys(sending.state.pendingRuns)[0], picker: false }]);
  assert.equal(sending.state.tasks.length, 0, "no task exists until the workspace resolves");

  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const [effect] = started.effects;
  assert.equal(effect.type, "start-run");
  assert.equal(effect.command.prompt, "Inspect the app");
  assert.equal(effect.command.workspaceId, "projectless");
  assert.equal(started.state.tasks[0].messages[0].text, "Inspect the app");
  assert.equal(started.state.activeRuns[effect.command.taskId].runId, effect.command.runId);
  assert.deepEqual(started.state.prompts, {});
  assert.deepEqual(started.state.pendingRuns, {});
});

test("the chosen effort sticks to the task and rides along with its runs", () => {
  const drafted = run(workspace(), [
    { type: "task.set-effort", effort: "max" },
    { type: "view.set-prompt", prompt: "Inspect the app" },
  ]);
  assert.equal(drafted.draftEffort, "max");

  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(started.effects[0].command.effort, "max");
  assert.equal(started.state.tasks[0].effort, "max");

  const lowered = reduce(started.state, { type: "task.set-effort", effort: "low" });
  assert.equal(lowered.state.tasks[0].effort, "low");
});

test("a second send is ignored while the first is still resolving", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect" }]);
  const first = reduce(drafted, { type: "task.send", attachments: [] });
  const second = reduce(first.state, { type: "task.send", attachments: [] });

  assert.deepEqual(second.effects, []);
  assert.equal(Object.keys(second.state.pendingRuns).length, 1);
});

test("a run whose folder is never reopened reports why and keeps nothing pending", () => {
  const drafted = run(workspace({ projects: [{ id: "project-1", root: "/project" }] }), [
    { type: "task.new", projectId: "project-1" },
    { type: "view.set-prompt", prompt: "Continue" },
  ]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  assert.deepEqual(sending.effects, [{ type: "resolve-run-workspace", pendingId: sending.effects[0].pendingId, picker: true, root: "/project" }]);

  const failed = reduce(sending.state, { type: "run.unresolved", pendingId: sending.effects[0].pendingId, message: "Choose the same project folder to continue this task." });
  assert.match(failed.state.actionError, /Choose the same project folder/);
  assert.deepEqual(failed.state.pendingRuns, {});
});

test("a scheduled run declines when the task is archived, gone, or already running", () => {
  const fire = { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2 };
  const declined = [
    workspace({ tasks: [] }),
    workspace({ tasks: [task("task-a", { archivedAt: 5 })] }),
    workspace({ tasks: [task("task-a")], activeRuns: { "task-a": { taskId: "task-a", runId: "other", sequence: 0, status: "running" } } }),
  ];
  for (const state of declined) {
    assert.deepEqual(reduce(state, { type: "automation.fired", fire }).effects, [
      { type: "automation.ack", ack: { automationId: "automation-1", runId: "run-1", started: false } },
    ]);
  }
});

test("a scheduled run starts with its own framing and acknowledges the tick", () => {
  const state = workspace({ tasks: [task("task-a")] });
  const fire = { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2, policy: "autonomous" };
  const pending = reduce(state, { type: "automation.fired", fire });
  const started = reduce(pending.state, { type: "run.resolved", pendingId: pending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  const [start, acknowledged] = started.effects;
  assert.equal(start.command.runId, "run-1");
  assert.equal(start.command.policy, "autonomous");
  assert.match(start.command.prompt, /automated run #2/);
  assert.deepEqual(acknowledged, { type: "automation.ack", ack: { automationId: "automation-1", runId: "run-1", started: true } });
  assert.equal(started.state.tasks[0].messages[0].detail, "Automation run #2");
});

test("archiving a task retires its automation and cancels a run still going", () => {
  const state = workspace({
    tasks: [task("task-a"), task("task-b")],
    automations: [{ taskId: "task-a" }, { taskId: "task-b" }],
    activeRuns: { "task-b": { taskId: "task-b", runId: "run-b", sequence: 0, status: "running" } },
  });

  const archived = reduce(state, { type: "task.archive", taskId: "task-a" });
  assert.deepEqual(archived.effects, [{ type: "automation.delete", taskId: "task-a" }]);
  assert.ok(archived.state.tasks[0].archivedAt);

  const running = reduce(state, { type: "task.archive", taskId: "task-b" });
  assert.deepEqual(running.effects, [
    { type: "automation.delete", taskId: "task-b" },
    { type: "send-run-command", command: { type: "cancel", taskId: "task-b", runId: "run-b" } },
  ]);
  assert.ok(running.state.tasks[1].archivedAt);
});

test("restoring an archived task returns it to the sidebar and leaves its automation retired", () => {
  const archived = reduce(workspace({ tasks: [task("task-a")], automations: [{ taskId: "task-a" }] }), { type: "task.archive", taskId: "task-a" });
  const restored = reduce(archived.state, { type: "task.restore", taskId: "task-a" });

  assert.equal(restored.state.tasks[0].archivedAt, undefined);
  assert.deepEqual(restored.effects, []);
  assert.deepEqual(deriveView(restored.state).orderedTasks.map((item) => item.id), ["task-a"]);
  assert.equal(reduce(restored.state, { type: "task.restore", taskId: "task-a" }).state, restored.state);
});

test("clearing the archive deletes every archived task at once", () => {
  const state = workspace({ tasks: [task("kept"), task("archived-a", { archivedAt: 5 }), task("archived-b", { archivedAt: 6 })], currentId: "archived-a" });
  const cleared = reduce(state, { type: "task.clear-archive" });

  assert.deepEqual(cleared.state.tasks.map((item) => item.id), ["kept"]);
  assert.equal(cleared.state.currentId, null);
  assert.equal(reduce(cleared.state, { type: "task.clear-archive" }).state, cleared.state);
});

test("a load drops archived tasks past the retention window and keeps the rest", () => {
  const day = 86_400_000;
  const loaded = reduce(workspace(), {
    type: "store.loaded",
    data: {
      version: 2,
      projects: [],
      lastFolder: null,
      tasks: [
        task("kept"),
        task("recent", { archivedAt: Date.now() - 4 * day }),
        task("expired", { archivedAt: Date.now() - 6 * day }),
      ],
    },
  });

  assert.deepEqual(loaded.state.tasks.map((item) => item.id), ["kept", "recent"]);
  assert.deepEqual(deriveView(loaded.state).archivedTasks.map((item) => item.id), ["recent"]);
});

test("changed files from a superseded run never overwrite the snapshot", () => {
  const state = workspace({ tasks: [task("task-a")], lastRunIds: { "task-a": "run-2" } });
  const stale = reduce(state, { type: "environment.updated", workspaceId: "workspace-1", taskId: "task-a", runId: "run-1", result: { status: "available", files: ["stale"], branch: "old", additions: 0, deletions: 0 } });
  assert.equal(stale.state, state);

  const current = reduce(state, { type: "environment.updated", workspaceId: "workspace-1", taskId: "task-a", runId: "run-2", result: { status: "available", files: ["fresh"], branch: "main", additions: 1, deletions: 0 } });
  assert.deepEqual(current.state.tasks[0].lastChangeSnapshot.files, ["fresh"]);
});

test("a run that settles out of focus flags the task and refreshes its project", () => {
  const state = workspace({
    tasks: [task("task-a", { projectId: "project-1" })],
    projects: [{ id: "project-1", root: "/project", workspaceId: "workspace-1" }],
    activeRuns: { "task-a": { taskId: "task-a", runId: "run-1", sequence: 0, status: "running" } },
    focused: false,
    currentId: "task-a",
  });

  const settled = reduce(state, { type: "run.event", event: { type: "run.status", taskId: "task-a", runId: "run-1", sequence: 1, status: "succeeded" } });
  assert.equal(settled.state.tasks[0].attention, "finished");
  assert.deepEqual(settled.effects, [{ type: "refresh-environment", workspaceId: "workspace-1", taskId: "task-a", runId: "run-1" }]);

  const focused = reduce(settled.state, { type: "view.set-focused", focused: true });
  assert.equal(focused.state.tasks[0].attention, undefined);
});

test("a side chat forks the source thread once, then continues on its own branch", () => {
  const source = task("main-task", { executionPolicy: "autonomous", continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "What does this do?" },
  ]);
  assert.equal(deriveView(opened).sideChats[0].title, "Chat 1");

  const sending = reduce(opened, { type: "task.send", taskId: "chat-1" });
  const forked = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const first = forked.effects[0].command;
  assert.equal(first.channel, "side");
  assert.equal(first.policy, "autonomous", "the chat starts from the source thread's policy");
  assert.equal(first.forkContinuation, true);
  assert.deepEqual(first.continuation, { provider: "claude", value: "main-session" });
  assert.equal(deriveView(forked.state).sideChats[0].prompt, "");
  assert.equal(deriveView(forked.state).sideChats[0].task.messages[0].text, "What does this do?");

  const branched = run(forked.state, [
    { type: "run.event", event: { type: "continuation.updated", taskId: "chat-1", runId: first.runId, sequence: 1, continuation: { provider: "claude", value: "side-session" } } },
    { type: "run.event", event: { type: "run.status", taskId: "chat-1", runId: first.runId, sequence: 2, status: "succeeded" } },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "Follow up" },
  ]);
  const resending = reduce(branched, { type: "task.send", taskId: "chat-1" });
  const second = reduce(resending.state, { type: "run.resolved", pendingId: resending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).effects[0].command;

  assert.deepEqual(second.continuation, { provider: "claude", value: "side-session" });
  assert.equal("forkContinuation" in second, false);
  assert.deepEqual(branched.tasks.find((task) => task.id === "main-task").continuation, { provider: "claude", value: "main-session" }, "the main thread never moves");
});

test("a side chat snapshots the source settings at creation, then owns them", () => {
  const source = task("main-task", {
    executionPolicy: "confirm",
    model: "opus",
    effort: "high",
    continuation: { provider: "claude", value: "main-session" },
    continuationStatus: "available",
  });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [{ type: "side-chat.open", chatId: "chat-1" }]);
  assert.equal(deriveView(opened).sideChats[0].task.executionPolicy, "confirm");
  assert.equal(deriveView(opened).sideChats[0].task.model, "opus");
  assert.equal(deriveView(opened).sideChats[0].task.effort, "high");

  const retuned = run(opened, [
    { type: "task.set-policy", taskId: "chat-1", policy: "autonomous" },
    { type: "task.set-model", taskId: "chat-1", model: "haiku" },
    { type: "task.set-effort", taskId: "chat-1", effort: "low" },
    { type: "task.set-policy", taskId: "main-task", policy: "allow-edits" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "Fix the typo" },
  ]);
  assert.equal(retuned.tasks.find((task) => task.id === "main-task").executionPolicy, "allow-edits", "the main thread keeps its own policy");

  const sending = reduce(retuned, { type: "task.send", taskId: "chat-1" });
  const command = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).effects[0].command;
  assert.equal(command.policy, "autonomous");
  assert.equal(command.model, "haiku");
  assert.equal(command.effort, "low");
});

test("a side chat is a thread in every way but being saved or listed", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "Read the reducer" },
  ]);
  const sending = reduce(opened, { type: "task.send", taskId: "chat-1", attachments: [{ path: "/tmp/shot.png", labels: ["here"] }] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const { runId } = started.effects[0].command;
  assert.match(started.effects[0].command.prompt, /shot\.png/, "a side chat sends its attachments");
  assert.deepEqual(started.effects.filter((effect) => effect.type === "suggest-title"), [], "a side chat keeps the name the dock gave it");

  const queued = reduce(started.state, { type: "task.send", taskId: "chat-1", text: "And the state file" });
  assert.deepEqual(queued.state.queuedMessages["chat-1"].map((message) => message.text), ["And the state file"], "queueing reaches a side chat");
  const steered = reduce(queued.state, { type: "task.steer-queued", taskId: "chat-1", messageId: queued.state.queuedMessages["chat-1"][0].id });
  assert.equal(steered.effects[0].command.type, "steer");

  const view = deriveView(steered.state);
  assert.deepEqual(view.tasks.map((item) => item.id), ["main-task"], "the chat is never listed beside real threads");
  assert.deepEqual(view.orderedTasks.map((item) => item.id), ["main-task"]);
  assert.deepEqual(threadSummaries(steered.state, { scope: { kind: "all" } }, 2).map((thread) => thread.id), ["main-task"], "and an agent never sees it");

  const closed = reduce(steered.state, { type: "side-chat.close", chatId: "chat-1" }).state;
  assert.deepEqual(closed.tasks.map((item) => item.id), ["main-task"], "closing takes the thread with it");
  assert.equal(closed.queuedMessages["chat-1"], undefined);
  assert.equal(closed.prompts["chat-1"], undefined);
  assert.equal(deriveView(closed).sideChats.length, 0);
});

test("closing a side chat retires anything scheduled against it", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "automations.changed", automations: [
      { id: "automation-1", taskId: "chat-1", schedule: "0 8 * * *", prompt: "Check the deploy", paused: false, createdAt: 1, updatedAt: 1, runCount: 0, nextRunAt: 2 },
      { id: "automation-2", taskId: "main-task", schedule: "0 9 * * *", prompt: "Daily report", paused: false, createdAt: 1, updatedAt: 1, runCount: 0, nextRunAt: 2 },
    ] },
  ]);

  const closed = reduce(opened, { type: "side-chat.close", chatId: "chat-1" });
  assert.deepEqual(closed.effects.filter((effect) => effect.type === "automation.delete"), [{ type: "automation.delete", taskId: "chat-1" }]);
  assert.deepEqual(closed.state.automations.map((automation) => automation.taskId), ["main-task"]);
});

test("a side chat cannot run without a source thread to fork", () => {
  const opened = run(workspace({ tasks: [task("main-task")], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "Ask" },
  ]);
  assert.deepEqual(reduce(opened, { type: "task.send", taskId: "chat-1" }).effects, []);
});

test("closing a side chat cancels its run, and switching tasks closes every chat", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source, task("other")], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "Ask" },
  ]);
  const sending = reduce(opened, { type: "task.send", taskId: "chat-1" });
  const running = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).state;
  const runId = running.activeRuns["chat-1"].runId;

  const closed = reduce(running, { type: "side-chat.close", chatId: "chat-1" });
  assert.deepEqual(closed.effects, [{ type: "send-run-command", command: { type: "cancel", taskId: "chat-1", runId } }]);
  assert.deepEqual(closed.state.sideChats, []);
  assert.equal(closed.state.activeRuns["chat-1"], undefined);

  const switched = reduce(running, { type: "task.select", taskId: "other" });
  assert.deepEqual(switched.state.sideChats, []);
  assert.equal(switched.effects.at(-1).command.type, "cancel");
  assert.equal(switched.state.sideChatSequence, 0);
});

test("the session panel choice is persisted and survives the store loading", () => {
  const restored = run(workspace(), [{ type: "preferences.loaded", preferences: { sessionPanelOpen: true } }]);
  assert.equal(restored.sessionPanelOpen, true);

  const closed = reduce(restored, { type: "view.set-session-panel-open", open: false });
  assert.deepEqual(closed.effects, [{ type: "persist-preferences", preferences: { sessionPanelOpen: false, browserTabs: [], browserOrigins: [] } }]);
  assert.equal(closed.state.sessionPanelOpen, false);

  assert.deepEqual(reduce(closed.state, { type: "view.set-session-panel-open", open: false }).effects, [], "an unchanged choice writes nothing");

  const loaded = reduce(restored, { type: "store.loaded", data: { tasks: [], projects: [], lastFolder: null } });
  assert.equal(loaded.state.sessionPanelOpen, true);
});

/** A task mid-run, which is the only state in which a message can be queued or steered. */
function running(taskId = "task-a", runId = "run-a", overrides = {}) {
  return workspace({
    tasks: [task(taskId)],
    currentId: taskId,
    activeRuns: { [taskId]: { taskId, runId, sequence: 0, status: "running" } },
    runStatuses: { [taskId]: "running" },
    ...overrides,
  });
}

function queueMessage(state, text, steer = false) {
  return run(state, [{ type: "view.set-prompt", prompt: text }, { type: "task.send", attachments: [], ...(steer ? { steer } : {}) }]);
}

test("a message typed during a run is queued rather than starting a second run", () => {
  const queued = reduce(run(running(), [{ type: "view.set-prompt", prompt: "Also run the tests" }]), { type: "task.send", attachments: [] });

  assert.deepEqual(queued.effects, [], "queueing waits for the run instead of resolving a workspace");
  assert.equal(queued.state.queuedMessages["task-a"].length, 1);
  assert.equal(queued.state.queuedMessages["task-a"][0].text, "Also run the tests");
  assert.deepEqual(queued.state.prompts, {}, "the draft clears so the composer is ready for the next one");
  assert.deepEqual(queued.state.pendingRuns, {});
});

test("steering hands a queued message to the run it was queued against, and delivery threads it", () => {
  const queued = queueMessage(running(), "Check the tests too");
  const [message] = queued.queuedMessages["task-a"];
  const steered = reduce(queued, { type: "task.steer-queued", messageId: message.id });

  assert.deepEqual(steered.effects, [{
    type: "send-run-command",
    command: { type: "steer", taskId: "task-a", runId: "run-a", messageId: message.id, prompt: "Check the tests too" },
  }]);
  assert.equal(steered.state.queuedMessages["task-a"][0].steering, true);
  assert.deepEqual(reduce(steered.state, { type: "task.steer-queued", messageId: message.id }).effects, [], "steering twice sends one command");
  assert.deepEqual(reduce(steered.state, { type: "task.drop-queued", messageId: message.id }).state.queuedMessages["task-a"].length, 1, "a steered message can no longer be dropped");

  const delivered = reduce(steered.state, {
    type: "run.event",
    event: { type: "queued.delivered", taskId: "task-a", runId: "run-a", sequence: 1, messageId: message.id },
  });
  assert.deepEqual(delivered.state.queuedMessages, {});
  assert.equal(delivered.state.tasks[0].messages.at(-1).text, "Check the tests too");
});

test("command-enter queues the message and steers it in one go", () => {
  const steered = reduce(run(running(), [{ type: "view.set-prompt", prompt: "Stop reading that file" }]), { type: "task.send", attachments: [], steer: true });
  const [message] = steered.state.queuedMessages["task-a"];

  assert.equal(message.steering, true);
  assert.deepEqual(steered.effects, [{
    type: "send-run-command",
    command: { type: "steer", taskId: "task-a", runId: "run-a", messageId: message.id, prompt: "Stop reading that file" },
  }]);
});

test("a finished run drains its queue one message at a time, each getting its own run", () => {
  const queued = queueMessage(queueMessage(running(), "Run the tests"), "Then update the README");

  /** Settles the run the task has going and starts whatever the queue hands on next. */
  const drain = (state, runId) => {
    const finished = reduce(state, {
      type: "run.event",
      event: { type: "run.status", taskId: "task-a", runId, sequence: 1, status: "succeeded" },
    });
    const [resolve] = finished.effects.filter((effect) => effect.type === "resolve-run-workspace");
    assert.ok(resolve, "the drained queue asks for its workspace the way a send does");
    assert.equal(finished.state.queuedMessages["task-a"].length, 2 - Number(runId !== "run-a"), "a message stays queued until its own run starts");
    return reduce(finished.state, { type: "run.resolved", pendingId: resolve.pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  };

  const first = drain(queued, "run-a");
  assert.equal(first.effects[0].command.prompt, "Run the tests", "the second message is not spoken for by the first");
  assert.equal(first.state.tasks[0].messages.at(-1).text, "Run the tests");
  assert.deepEqual(first.state.queuedMessages["task-a"].map((message) => message.text), ["Then update the README"], "the rest waits for this run to finish");

  const second = drain(first.state, first.effects[0].command.runId);
  assert.equal(second.effects[0].command.prompt, "Then update the README");
  assert.equal(second.state.tasks[0].messages.at(-1).text, "Then update the README");
  assert.deepEqual(second.state.queuedMessages, {});
});

test("stopping a run hands the queue back to the composer instead of speaking for the user", () => {
  const queued = queueMessage(running(), "Run the tests");
  const cancelled = reduce(queued, {
    type: "run.event",
    event: { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 1, status: "cancelled" },
  });

  assert.deepEqual(cancelled.effects, []);
  assert.deepEqual(cancelled.state.queuedMessages, {});
  assert.equal(cancelled.state.prompts["task-a"], "Run the tests");
  assert.ok(cancelled.state.tasks[0].runEndedAt, "the work the stop cut short knows when it ended");
});

test("dropping a queued message removes only that one", () => {
  const queued = queueMessage(queueMessage(running(), "First"), "Second");
  const [first] = queued.queuedMessages["task-a"];
  const dropped = reduce(queued, { type: "task.drop-queued", messageId: first.id });

  assert.deepEqual(dropped.effects, []);
  assert.deepEqual(dropped.state.queuedMessages["task-a"].map((message) => message.text), ["Second"]);
});

test("a run starting on a task the user is not looking at leaves them where they are", () => {
  const queued = queueMessage(running(), "Run the tests");
  const looking = run(queued, [{ type: "task.select", taskId: "task-b" }]);
  const finished = reduce({ ...looking, tasks: [...looking.tasks, task("task-b")] }, {
    type: "run.event",
    event: { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 1, status: "succeeded" },
  });
  const [resolve] = finished.effects.filter((effect) => effect.type === "resolve-run-workspace");
  const started = reduce(finished.state, { type: "run.resolved", pendingId: resolve.pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.equal(started.state.currentId, "task-b", "the drained queue runs without stealing the view");
  assert.equal(started.state.activeRuns["task-a"].runId, resolve.pendingId ? started.effects[0].command.runId : undefined);
});

test("a send with no task yet opens the task it creates", () => {
  const sending = reduce(run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]), { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.equal(started.state.currentId, started.state.tasks[0].id);
});

test("a streaming tail shows outside the task, so nothing half-written is ever stored", () => {
  const state = running();
  const event = (sequence, extra) => ({ type: "run.event", event: { taskId: "task-a", runId: "run-a", sequence, ...extra } });

  const streaming = run(state, [
    event(1, { type: "assistant.tail", messageId: "message-1", text: "The first thing" }),
    event(2, { type: "assistant.tail", messageId: "message-1", text: "The first thing to check" }),
  ]);
  assert.deepEqual(streaming.streamingTails["task-a"], { messageId: "message-1", text: "The first thing to check" });
  assert.deepEqual(streaming.tasks[0].messages, [], "a tail never becomes a message");
  assert.equal(streaming.tasks[0], state.tasks[0], "the task is untouched, so persistence has nothing to write");

  const committed = reduce(streaming, event(3, { type: "assistant.delta", messageId: "message-1", text: "The first thing to check is the reducer.\n\n", append: true })).state;
  assert.equal(committed.streamingTails["task-a"], undefined, "the committed block replaces what the tail was standing in for");
  assert.equal(committed.tasks[0].messages[0].text, "The first thing to check is the reducer.\n\n");

  const resumed = reduce(committed, event(4, { type: "assistant.tail", messageId: "message-1", text: "Then the" })).state;
  assert.deepEqual(resumed.streamingTails["task-a"], { messageId: "message-1", text: "Then the" });

  const finished = reduce(resumed, event(5, { type: "run.status", status: "succeeded" })).state;
  assert.deepEqual(finished.streamingTails, {}, "a finished run leaves no tail behind");
});

test("an emptied tail clears rather than rendering nothing, and a new run starts clean", () => {
  const state = running();
  const event = (sequence, extra) => ({ type: "run.event", event: { taskId: "task-a", runId: "run-a", sequence, ...extra } });

  const cleared = run(state, [
    event(1, { type: "assistant.tail", messageId: "message-1", text: "Half a sen" }),
    event(2, { type: "assistant.tail", messageId: "message-1", text: "" }),
  ]);
  assert.deepEqual(cleared.streamingTails, {});

  const stale = run(state, [event(1, { type: "assistant.tail", messageId: "message-1", text: "Interrupted" })]);
  const restarted = reduce(stale, event(2, { type: "run.started" })).state;
  assert.deepEqual(restarted.streamingTails, {}, "a new run never inherits the previous run's tail");
});

test("a side chat streams its own tail without disturbing the main thread", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "What does this do?" },
  ]);
  const sending = reduce(opened, { type: "task.send", taskId: "chat-1" });
  const { runId } = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).effects[0].command;
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).state;

  const streaming = reduce(started, { type: "run.event", event: { type: "assistant.tail", taskId: "chat-1", runId, sequence: 1, messageId: "message-1", text: "It reduces" } }).state;
  assert.deepEqual(streaming.streamingTails["chat-1"], { messageId: "message-1", text: "It reduces" });
  assert.equal(streaming.streamingTails["main-task"], undefined);
  assert.equal(deriveView(streaming).sideChats[0].streamingTail.text, "It reduces");
});

test("a side chat answers its own approval without the main thread in the way", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "What does this do?" },
  ]);
  const sending = reduce(opened, { type: "task.send", taskId: "chat-1" });
  const resolved = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const { runId } = resolved.effects[0].command;

  const asking = run(resolved.state, [
    { type: "run.event", event: { type: "approval.requested", taskId: "chat-1", runId, sequence: 1, approvalId: "approval-1", title: "Run a command", description: "ls", intent: { name: "Bash", input: { command: "ls" } } } },
    { type: "run.event", event: { type: "run.status", taskId: "chat-1", runId, sequence: 2, status: "awaiting-approval" } },
  ]);
  const view = deriveView(asking);
  assert.equal(view.sideChats[0].approval.approvalId, "approval-1");
  assert.equal(view.approval, undefined, "the main thread shows nothing");

  assert.deepEqual(reduce(asking, { type: "run.decide", allow: true }).effects, [], "the main thread cannot answer for the side chat");

  const decided = reduce(asking, { type: "run.decide", allow: true, taskId: "chat-1" });
  assert.deepEqual(decided.effects, [{ type: "send-run-command", command: { type: "approval", taskId: "chat-1", runId, approvalId: "approval-1", allow: true } }]);
  assert.equal(deriveView(decided.state).sideChats[0].approval, undefined);
});

test("a new thread asks for a name, and the name the user types outlasts the suggestion", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const taskId = started.state.tasks[0].id;

  assert.deepEqual(started.effects.filter((effect) => effect.type === "suggest-title"), [{ type: "suggest-title", taskId, text: "Inspect the app", attachments: [] }]);
  assert.equal(started.state.tasks[0].title, "Inspect the app", "the typed message titles the thread until a suggestion lands");

  const named = reduce(started.state, { type: "title.suggested", taskId, title: "App breakage review" }).state;
  assert.equal(named.tasks[0].title, "App breakage review");
  assert.equal(named.tasks[0].updatedAt, started.state.tasks[0].updatedAt, "renaming is cosmetic and never reorders recents");

  const renamed = reduce(named, { type: "task.rename", taskId, title: "  Nightly audit  " }).state;
  assert.equal(renamed.tasks[0].title, "Nightly audit");

  const late = reduce(renamed, { type: "title.suggested", taskId, title: "Something else" }).state;
  assert.equal(late.tasks[0].title, "Nightly audit");
  assert.equal(reduce(renamed, { type: "task.rename", taskId, title: "   " }).state, renamed, "an empty name leaves the thread alone");
});

test("only a thread the send just created is named, from what the user typed and any screenshots", () => {
  const existing = task("task-a", { title: "Inspect the app" });
  const drafted = run(workspace({ tasks: [existing], currentId: "task-a" }), [{ type: "view.set-prompt", prompt: "Now check the reducer" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(started.effects.some((effect) => effect.type === "suggest-title"), false);

  const attached = reduce(workspace(), { type: "task.send", attachments: [{ path: "/tmp/shot.png", labels: [] }] });
  const fromImage = reduce(attached.state, { type: "run.resolved", pendingId: attached.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(fromImage.state.tasks[0].title, "Screenshot");
  assert.deepEqual(
    fromImage.effects.filter((effect) => effect.type === "suggest-title"),
    [{ type: "suggest-title", taskId: fromImage.state.tasks[0].id, text: "", attachments: ["/tmp/shot.png"] }],
    "a screenshot-only thread is named from the screenshot",
  );
});

test("a command that names its task acts on that one, whichever task the user is looking at", () => {
  const state = workspace({
    tasks: [task("task-a"), task("task-b")],
    currentId: "task-a",
    activeRuns: { "task-b": { taskId: "task-b", runId: "run-b", sequence: 0, status: "running" } },
  });

  const modelled = reduce(state, { type: "task.set-model", taskId: "task-b", model: "haiku" });
  assert.equal(modelled.state.tasks[1].model, "haiku");
  assert.equal(modelled.state.tasks[0].model, undefined);
  assert.equal(modelled.state.draftModel, workspace().draftModel, "naming a task leaves the composer's draft alone");

  assert.deepEqual(reduce(state, { type: "run.cancel", taskId: "task-b" }).effects, [
    { type: "send-run-command", command: { type: "cancel", taskId: "task-b", runId: "run-b" } },
  ]);
  assert.deepEqual(reduce(state, { type: "run.cancel" }).effects, [], "task-a has no run of its own");
  assert.deepEqual(reduce(state, { type: "automation.delete", taskId: "task-b" }).effects, [{ type: "automation.delete", taskId: "task-b" }]);
});

test("a command naming a task that does not exist changes nothing", () => {
  const state = workspace({ tasks: [task("task-a")], currentId: "task-a" });

  for (const command of [
    { type: "task.set-policy", taskId: "ghost", policy: "autonomous" },
    { type: "task.send", taskId: "ghost", text: "Ship it" },
    { type: "automation.run-now", taskId: "ghost" },
  ]) {
    const transition = reduce(state, command);
    assert.equal(transition.state, state, `${command.type} left state alone`);
    assert.deepEqual(transition.effects, []);
  }
});

test("a send that carries its own text starts a thread without touching the draft or the user's place", () => {
  const drafted = run(workspace({ projects: [{ id: "project-1", root: "/project", workspaceId: "workspace-1" }] }), [
    { type: "view.set-prompt", prompt: "Half-typed thought" },
  ]);

  const sending = reduce(drafted, { type: "task.send", projectId: "project-1", text: "Implement item 1" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "workspace-1", kind: "project", root: "/project" } });

  const [start] = started.effects;
  assert.equal(start.command.prompt, "Implement item 1");
  assert.equal(started.state.tasks[0].projectId, "project-1");
  assert.equal(started.state.currentId, null, "an agent's send does not move the user");
  assert.equal(started.state.prompts["draft:"], "Half-typed thought", "the composer keeps what the user was typing");
});

test("several sends can start their own threads at once, unlike the composer's one draft", () => {
  let state = workspace();
  const pendingIds = [];
  for (const text of ["Implement 1", "Implement 2", "Implement 3"]) {
    const sending = reduce(state, { type: "task.send", text });
    state = sending.state;
    pendingIds.push(sending.effects[0].pendingId);
  }
  assert.equal(Object.keys(state.pendingRuns).length, 3);

  for (const pendingId of pendingIds) {
    state = reduce(state, { type: "run.resolved", pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).state;
  }
  assert.deepEqual(state.tasks.map((item) => item.messages[0].text).sort(), ["Implement 1", "Implement 2", "Implement 3"]);
  assert.equal(Object.keys(state.activeRuns).length, 3);
});

test("a send to a running thread queues behind that run rather than the current one", () => {
  const state = workspace({
    tasks: [task("task-a"), task("task-b")],
    currentId: "task-a",
    activeRuns: { "task-b": { taskId: "task-b", runId: "run-b", sequence: 0, status: "running" } },
  });

  const queued = reduce(state, { type: "task.send", taskId: "task-b", text: "Also update the README" });
  assert.deepEqual(queued.effects, []);
  assert.equal(queued.state.queuedMessages["task-b"].length, 1);
  assert.equal(queued.state.queuedMessages["task-a"], undefined);

  const steered = reduce(state, { type: "task.send", taskId: "task-b", text: "Stop and read this", steer: true });
  const [effect] = steered.effects;
  assert.equal(effect.command.type, "steer");
  assert.equal(effect.command.taskId, "task-b");
});

test("a new thread records when it was created", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  const [created] = started.state.tasks;
  assert.ok(created.createdAt > 0);
  assert.ok(created.createdAt <= created.messages[0].at);
});

test("visiting threads builds a trail that back and forward walk without extending it", () => {
  const state = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "task.select", taskId: "task-c" },
  ]);
  assert.deepEqual(state.history, ["task-a", "task-b", "task-c"]);

  const back = run(state, [{ type: "view.go-back" }, { type: "view.go-back" }]);
  assert.equal(back.currentId, "task-a");
  assert.deepEqual(back.history, ["task-a", "task-b", "task-c"]);
  assert.ok(deriveView(back).canGoForward);
  assert.ok(!deriveView(back).canGoBack);

  const forward = reduce(back, { type: "view.go-forward" }).state;
  assert.equal(forward.currentId, "task-b");
  assert.ok(deriveView(forward).canGoBack);

  assert.equal(reduce(back, { type: "view.go-back" }).state, back, "there is nowhere further back to go");
});

test("history follows wherever the app took the user, not just sidebar clicks", () => {
  const drafted = run(workspace({ tasks: [task("task-a")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.new" },
    { type: "view.set-prompt", prompt: "Inspect the app" },
  ]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });

  assert.deepEqual(started.state.history, ["task-a", started.state.currentId]);
  assert.equal(reduce(started.state, { type: "view.go-back" }).state.currentId, "task-a");
});

test("visiting a thread after going back drops the trail ahead of it", () => {
  const walked = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "view.go-back" },
    { type: "task.select", taskId: "task-c" },
  ]);
  assert.deepEqual(walked.history, ["task-a", "task-c"]);
  assert.equal(walked.currentId, "task-c");
  assert.ok(!deriveView(walked).canGoForward);
});

test("back and forward step over threads that are gone or archived", () => {
  const visited = run(workspace({ tasks: [task("task-a"), task("task-b"), task("task-c")] }), [
    { type: "task.select", taskId: "task-a" },
    { type: "task.select", taskId: "task-b" },
    { type: "task.select", taskId: "task-c" },
  ]);

  const archived = reduce(visited, { type: "task.archive", taskId: "task-b" }).state;
  const back = reduce(archived, { type: "view.go-back" }).state;
  assert.equal(back.currentId, "task-a", "the archived thread in between is skipped");
  assert.equal(reduce(back, { type: "view.go-forward" }).state.currentId, "task-c");

  const emptied = { ...visited, tasks: visited.tasks.filter((item) => item.id !== "task-a") };
  assert.ok(!deriveView({ ...emptied, historyIndex: 1 }).canGoBack, "a thread that no longer exists is nowhere to go");
});

const PROJECT = { id: "project-a", root: "/repo", workspaceId: "workspace-a" };

function projected(overrides = {}) {
  return workspace({ projects: [PROJECT], draftProjectId: PROJECT.id, ...overrides });
}

function madeWorktree(id = "wt1") {
  return { id, root: `/worktrees/repo-${id}`, workspaceId: `worktree-${id}`, baseCommit: "abcdef1234", createdAt: 2, lastUsedAt: 2 };
}

/** Sends the composer draft and answers the workspace resolution with `resolution`. */
function send(state, resolution, worktree) {
  const sending = reduce(state, { type: "task.send", attachments: [] });
  const resolved = reduce(sending.state, {
    type: "run.resolved",
    pendingId: sending.effects[0].pendingId,
    workspace: resolution,
    ...(worktree ? { worktree } : {}),
  });
  return { request: sending.effects[0], ...resolved };
}

test("asking for a worktree from the panel moves the thread there and then", () => {
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });

  const asked = reduce(state, { type: "task.set-worktree", worktree: true });
  assert.deepEqual(asked.effects, [{ type: "create-worktree", taskId: "task-a", projectRoot: "/repo" }]);
  assert.equal(deriveView(asked.state).location.kind, "local", "the thread is still local until the checkout exists");

  const worktree = madeWorktree();
  const made = reduce(asked.state, { type: "worktree.created", taskId: "task-a", worktree });
  assert.deepEqual(made.state.tasks[0].worktree, worktree);
  assert.equal(deriveView(made.state).location.kind, "worktree");
  assert.match(made.state.tasks[0].messages.at(-1).text, /Moved into a worktree at \/worktrees\/repo-wt1/);
});

test("a thread already in a worktree is not given a second one", () => {
  const worktree = madeWorktree();
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id, worktree })], currentId: "task-a" });

  assert.deepEqual(reduce(state, { type: "task.set-worktree", worktree: true }).effects, []);
});

test("a worktree that could not be made leaves the thread where it was", () => {
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a" });

  const failed = run(state, [
    { type: "task.set-worktree", worktree: true },
    { type: "worktree.failed", taskId: "task-a", message: "Git is not installed or is not on the PATH." },
  ]);

  assert.equal(failed.tasks[0].worktree, undefined);
  assert.equal(failed.actionError, "Git is not installed or is not on the PATH.");
  assert.equal(deriveView(failed).location.kind, "local");
});

test("a thread another thread starts in a worktree gets one on its first run", () => {
  const drafted = projected();

  const sending = reduce(drafted, { type: "task.send", text: "Refactor the loader", projectId: PROJECT.id, worktree: true });
  assert.deepEqual(sending.effects[0].createWorktree, { projectRoot: "/repo", carryChanges: false }, "a thread with no history has nothing to carry");

  const worktree = madeWorktree();
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: sending.effects[0].pendingId,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
    worktree,
  });
  assert.equal(started.effects[0].command.workspaceId, worktree.workspaceId, "the run happens in the worktree, not the project");
  assert.equal(started.effects[0].command.forkContinuation, undefined, "a thread with no session has nothing to fork");
  assert.equal(started.state.tasks[0].worktree.root, worktree.root);
});

test("a thread already talking carries its work into the worktree and forks its session", () => {
  const existing = task("task-a", {
    projectId: PROJECT.id,
    continuation: { provider: "claude", value: "session-1" },
    continuationStatus: "available",
  });
  const state = projected({ tasks: [existing], currentId: "task-a", prompts: { "task-a": "Keep going" } });

  const worktree = madeWorktree();
  const moved = run(state, [
    { type: "task.set-worktree", worktree: true },
    { type: "worktree.created", taskId: "task-a", worktree },
  ]);
  const talking = send(moved, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });

  assert.deepEqual(talking.request.workspace, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });
  const [started] = talking.effects;
  assert.equal(started.command.forkContinuation, true, "the session branches rather than moving, so nothing writes it from two places");
  assert.equal(started.command.continuation.value, "session-1");
  const notes = talking.state.tasks[0].messages.filter((message) => message.kind === "system");
  assert.equal(notes.length, 1, "moving says so once, when it happens");
  assert.match(notes[0].text, /Moved into a worktree at \/worktrees\/repo-wt1/);
  assert.match(notes[0].detail, /Detached at abcdef1/);
});

test("a thread that stays in its worktree reuses it and stops forking", () => {
  const worktree = { ...madeWorktree(), enteredAt: 3 };
  const existing = task("task-a", {
    projectId: PROJECT.id,
    worktree,
    continuation: { provider: "claude", value: "session-2" },
    continuationStatus: "available",
  });
  const state = projected({ tasks: [existing], currentId: "task-a", prompts: { "task-a": "And again" } });

  const again = send(state, { id: worktree.workspaceId, kind: "worktree", root: worktree.root }, worktree);

  assert.deepEqual(again.request, {
    type: "resolve-run-workspace",
    pendingId: again.request.pendingId,
    picker: false,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
  }, "an existing worktree is resolved as a worktree, never made again");
  assert.equal(again.effects[0].command.forkContinuation, undefined, "the thread is already there, so its session just continues");
  assert.equal(again.state.tasks[0].messages.filter((message) => message.kind === "system").length, 0);
});

test("switching back to local hands the worktree back, and the thread records where the work went", () => {
  const worktree = madeWorktree();
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id, worktree })], currentId: "task-a" });

  const leaving = reduce(state, { type: "task.set-worktree", worktree: false });
  assert.deepEqual(leaving.effects, [{
    type: "release-worktree",
    taskId: "task-a",
    worktreeId: "wt1",
    root: worktree.root,
    title: "task-a",
  }]);
  assert.ok(leaving.state.tasks[0].worktree, "the thread keeps its worktree until the snapshot lands");

  const released = reduce(leaving.state, {
    type: "worktree.released",
    taskId: "task-a",
    snapshot: { commit: "1234567890", shortCommit: "1234567", ref: "refs/claudex/wt1" },
  });
  assert.equal(released.state.tasks[0].worktree, undefined);
  assert.equal(deriveView(released.state).location.kind, "local");
  const note = released.state.tasks[0].messages.at(-1);
  assert.match(note.text, /committed as 1234567, and the worktree was removed/);
  assert.match(note.detail, /git show refs\/claudex\/wt1/);
});

test("neither switching back nor deleting happens under a running thread", () => {
  const worktree = madeWorktree();
  const state = projected({
    tasks: [task("task-a", { projectId: PROJECT.id, worktree })],
    currentId: "task-a",
    activeRuns: { "task-a": { taskId: "task-a", runId: "run-a", sequence: 1, status: "running" } },
  });

  const leaving = reduce(state, { type: "task.set-worktree", worktree: false });
  assert.deepEqual(leaving.effects, []);
  assert.equal(leaving.state.actionError, WORKSPACE_ERRORS.worktreeRunning);

  const deleting = reduce(state, { type: "worktree.delete" });
  assert.deepEqual(deleting.effects, []);
  assert.equal(deleting.state.actionError, WORKSPACE_ERRORS.worktreeRunning);
});

test("deleting a worktree keeps nothing and puts the thread back on the project", () => {
  const worktree = madeWorktree();
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id, worktree })], currentId: "task-a" });

  const deleting = reduce(state, { type: "worktree.delete" });
  assert.deepEqual(deleting.effects, [{ type: "delete-worktree", taskId: "task-a", root: worktree.root }]);

  const deleted = reduce(deleting.state, { type: "worktree.deleted", taskId: "task-a" });
  assert.equal(deleted.state.tasks[0].worktree, undefined);
  assert.match(deleted.state.tasks[0].messages.at(-1).text, /Worktree deleted/);
});

test("a thread with no project folder has nowhere to put a worktree", () => {
  const state = workspace({ tasks: [task("task-a")], currentId: "task-a" });

  const refused = reduce(state, { type: "task.set-worktree", worktree: true });

  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.worktreeProject);
  assert.deepEqual(refused.effects, [], "nothing is made where there is no project to cut it from");
});

test("the panel and the sidebar read a thread's checkout from the same place", () => {
  const worktree = madeWorktree();
  const state = projected({
    tasks: [task("task-a", { projectId: PROJECT.id, worktree }), task("task-b", { projectId: PROJECT.id })],
    currentId: "task-a",
  });

  const view = deriveView(state);
  assert.deepEqual([...view.worktreeTaskIds], ["task-a"]);
  assert.equal(view.location.worktree.root, worktree.root);
  assert.equal(deriveView({ ...state, currentId: "task-b" }).location.kind, "local");
});

test("a thread in a worktree reports that checkout's changes, not the project's", () => {
  const worktree = madeWorktree();
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id, worktree })], currentId: "task-a" });

  const refreshing = reduce(state, { type: "view.refresh-environment" });

  assert.deepEqual(refreshing.effects, [{ type: "refresh-environment", workspaceId: worktree.workspaceId, taskId: "task-a" }]);
});

test("resolving into a worktree never restates where the project itself is", () => {
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const worktree = madeWorktree();
  const moved = send(state, { id: worktree.workspaceId, kind: "worktree", root: worktree.root }, worktree);

  assert.deepEqual(moved.state.projects, [PROJECT], "the project keeps its own folder and workspace");
  assert.equal(deriveView(moved.state).folder, "/repo");
});

test("a project with no workspace of its own adopts the one the picker opened for it", () => {
  const state = projected({ projects: [{ ...PROJECT, workspaceId: undefined }], tasks: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const reopened = send(state, { id: "workspace-b", kind: "project", root: "/repo" });

  assert.deepEqual(reopened.state.projects, [{ ...PROJECT, workspaceId: "workspace-b" }]);
});

test("a new thread starts from the branch the draft names, moving the project onto it", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "feature-x" },
    { type: "view.set-prompt", prompt: "Pick up the loader work" },
  ]);
  assert.deepEqual(deriveView(drafted).draftBranch, { name: "feature-x", create: false });

  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  assert.deepEqual(sending.effects[0].checkout, { workspaceId: "workspace-a", branch: "feature-x" }, "without a worktree the project checkout is what moves");
  assert.equal(sending.effects[0].createWorktree, undefined);
});

test("a new thread told to use a worktree detaches it from the branch instead", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "feature-x" },
    { type: "task.set-worktree", worktree: true },
    { type: "view.set-prompt", prompt: "Pick up the loader work" },
  ]);

  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  assert.deepEqual(sending.effects[0].createWorktree, { projectRoot: "/repo", carryChanges: false, branch: "feature-x" });
  assert.equal(sending.effects[0].checkout, undefined, "the project checkout is left where it is");
});

test("a branch the repository does not have yet is made before the thread starts from it", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "loader-fix", create: true },
    { type: "view.set-prompt", prompt: "Pick up the loader work" },
  ]);
  assert.deepEqual(deriveView(drafted).draftBranch, { name: "loader-fix", create: true });

  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  assert.deepEqual(sending.effects[0].createBranch, { workspaceId: "workspace-a", branch: "loader-fix" });
  assert.deepEqual(sending.effects[0].checkout, { workspaceId: "workspace-a", branch: "loader-fix" }, "the project checkout then moves onto it");

  const worktreed = reduce(run(drafted, [{ type: "task.set-worktree", worktree: true }]), { type: "task.send", attachments: [] });

  assert.deepEqual(worktreed.effects[0].createBranch, { workspaceId: "workspace-a", branch: "loader-fix" });
  assert.deepEqual(worktreed.effects[0].createWorktree, { projectRoot: "/repo", carryChanges: false, branch: "loader-fix" });
});

test("a branch already in the repository is started from without being made", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "feature-x" },
    { type: "view.set-prompt", prompt: "Go" },
  ]);

  const sending = reduce(drafted, { type: "task.send", attachments: [] });

  assert.equal(sending.effects[0].createBranch, undefined);
});

test("the draft answers belong to the thread being started, and reset once it exists", () => {
  const drafted = run(projected(), [
    { type: "task.set-branch", branch: "feature-x" },
    { type: "task.set-worktree", worktree: true },
    { type: "view.set-prompt", prompt: "Go" },
  ]);

  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const worktree = madeWorktree();
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: sending.effects[0].pendingId,
    workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root },
    worktree,
  });

  assert.equal(started.state.draftBranch, null, "the next new thread starts from a clean slate");
  assert.equal(started.state.draftWorktree, false);

  /** A message to the thread that now exists uses where it already is, not a stale draft. */
  const taskId = started.state.tasks[0].id;
  const settledRun = run(started.state, [
    { type: "run.event", event: { type: "run.status", taskId, runId: started.effects[0].command.runId, sequence: 1, status: "succeeded" } },
    { type: "view.set-prompt", taskId, prompt: "More" },
  ]);
  const again = reduce(settledRun, { type: "task.send", attachments: [] });
  assert.equal(again.effects[0].checkout, undefined);
  assert.deepEqual(again.effects[0].workspace, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });
});

test("starting a thread in another project clears the branch chosen for the last one", () => {
  const drafted = run(projected(), [{ type: "task.set-branch", branch: "feature-x" }]);

  const switched = reduce(drafted, { type: "task.new", projectId: "project-b" });

  assert.equal(switched.state.draftBranch, null, "a branch belongs to the repository it was read from");
  assert.equal(switched.state.draftWorktree, false);
});

test("a thread's second run in its worktree leaves the project row exactly where it was", () => {
  const worktree = { ...madeWorktree(), enteredAt: 3 };
  const state = projected({
    tasks: [task("task-a", { projectId: PROJECT.id, worktree })],
    currentId: "task-a",
    prompts: { "task-a": "Again" },
  });

  const again = send(state, { id: worktree.workspaceId, kind: "worktree", root: worktree.root });

  assert.deepEqual(again.state.projects, [PROJECT], "a run in a worktree never restates where the project is");
  assert.equal(deriveView(again.state).folder, "/repo");
  assert.equal(again.effects[0].command.workspaceId, worktree.workspaceId, "and it still happens in the worktree");
});

test("a project that already has a workspace is never moved by a run that resolves elsewhere", () => {
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const elsewhere = send(state, { id: "workspace-b", kind: "project", root: "/somewhere-else" });

  assert.deepEqual(elsewhere.state.projects, [PROJECT], "only the picker says where a project lives");
});

test("a thread starting on another branch waits for the runs in that checkout to stop", () => {
  const state = projected({
    tasks: [task("task-a", { projectId: PROJECT.id })],
    activeRuns: { "task-a": { taskId: "task-a", runId: "run-a", sequence: 1, status: "running" } },
    draftBranch: { name: "feature-x", create: false },
    prompts: { "draft:project-a": "Start here" },
  });

  const refused = reduce(state, { type: "task.send", attachments: [] });

  assert.deepEqual(refused.effects, [], "nothing moves the checkout under a thread that is working in it");
  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.checkoutRunning);
  assert.equal(refused.state.tasks.length, 1, "and no thread is created for a send that never started");
});

test("a thread starting on another branch in a worktree ignores the runs in the project checkout", () => {
  const state = projected({
    tasks: [task("task-a", { projectId: PROJECT.id })],
    activeRuns: { "task-a": { taskId: "task-a", runId: "run-a", sequence: 1, status: "running" } },
    draftBranch: { name: "feature-x", create: false },
    draftWorktree: true,
    prompts: { "draft:project-a": "Start here" },
  });

  const sending = reduce(state, { type: "task.send", attachments: [] });

  assert.equal(sending.effects[0].checkout, undefined, "a checkout of its own never moves the project");
  assert.deepEqual(sending.effects[0].createWorktree, { projectRoot: "/repo", carryChanges: false, branch: "feature-x" });
});

test("a thread cannot change where it works while a send is still finding its checkout", () => {
  const worktree = madeWorktree();
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id, worktree })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const sending = reduce(state, { type: "task.send", attachments: [] });
  const changedMind = reduce(sending.state, { type: "task.set-worktree", worktree: false });

  assert.deepEqual(changedMind.effects, [], "the checkout is not handed back from under a run about to start");
  assert.equal(changedMind.state.actionError, WORKSPACE_ERRORS.worktreeRunning);
  assert.ok(changedMind.state.tasks[0].worktree);
});

test("an automation waits for a send that is still finding its checkout", () => {
  const state = projected({ tasks: [task("task-a", { projectId: PROJECT.id })], currentId: "task-a", prompts: { "task-a": "Go" } });

  const sending = reduce(state, { type: "task.send", attachments: [] });
  const fired = reduce(sending.state, {
    type: "automation.fired",
    fire: { automationId: "automation-1", taskId: "task-a", runId: "run-b", runNumber: 2, prompt: "Tick" },
  });

  assert.deepEqual(fired.effects, [{ type: "automation.ack", ack: { automationId: "automation-1", runId: "run-b", started: false } }], "two runs would make two checkouts");
});

test("a dropped thread moves without unfolding the sidebar the user folded", () => {
  const state = workspace({
    projects: [{ id: "project-1", root: "/project" }],
    tasks: [task("task-a"), task("task-b", { projectId: "project-1" })],
    expandedProjects: new Set(),
  });

  const moved = reduce(state, { type: "task.move", taskId: "task-a", target: { projectId: "project-1", index: 0 } });
  assert.equal(moved.state.tasks.find((item) => item.id === "task-a").projectId, "project-1");
  assert.deepEqual([...moved.state.expandedProjects], []);
});

test("the user's own page visit opens a dock tab of its own and allows that origin from then on", () => {
  const opened = reduce(workspace(), { type: "browser.open", url: "github.com/zyuapp/claudex" });
  const [tab] = opened.state.browserTabs;

  assert.equal(tab.url, "https://github.com/zyuapp/claudex");
  assert.equal(tab.loading, true);
  assert.equal(opened.state.browserTabId, tab.id);
  assert.deepEqual(opened.state.browserOrigins, ["https://github.com"]);
  assert.equal(opened.state.dockOpen, true, "a page has to land somewhere the user can see it");
  assert.equal(opened.state.dockTab, tab.id, "a page is a tab in the dock, not a tab inside a panel");
  assert.deepEqual(opened.effects.filter((effect) => effect.type.startsWith("browser")), [
    { type: "browser.open", tabId: tab.id, url: "https://github.com/zyuapp/claudex" },
    { type: "browser.show", tabId: tab.id },
  ]);

  const navigated = reduce(opened.state, { type: "browser.open", url: "https://github.com/zyuapp/claudex/pulls" });
  assert.equal(navigated.state.browserTabs.length, 1, "the tab on screen is reused");
  assert.deepEqual(navigated.effects[0], { type: "browser.navigate", tabId: tab.id, url: "https://github.com/zyuapp/claudex/pulls" });

  const another = reduce(navigated.state, { type: "browser.open", url: "https://example.com", newTab: true });
  assert.equal(another.state.browserTabs.length, 2);
  assert.deepEqual(another.state.browserOrigins, ["https://github.com", "https://example.com"]);
});

test("a page the browser cannot open is refused rather than opened blank", () => {
  const refused = reduce(workspace(), { type: "browser.open", url: "file:///etc/passwd" });

  assert.deepEqual(refused.state.browserTabs, []);
  assert.deepEqual(refused.effects, []);
  assert.match(refused.state.actionError, /not a page the browser can open/);
});

test("a run has to be allowed an origin the user has never visited, and then never again", () => {
  const state = run(workspace(), [
    { type: "view.set-prompt", prompt: "Check the dashboard" },
  ]);
  const withTask = { ...state, tasks: [task("task-1")], currentId: "task-1" };

  const asked = reduce(withTask, { type: "browser.open", taskId: "task-1", url: "https://dash.example.com/metrics" });
  const [blank] = asked.state.browserTabs;
  assert.equal(blank.url, "", "the ask gets a tab of its own to be shown in, and loads nothing into it");
  assert.deepEqual(asked.state.browserApproval, { url: "https://dash.example.com/metrics", taskId: "task-1", tabId: blank.id });
  assert.equal(asked.state.dockTab, blank.id, "the ask is shown where the page would have been");

  const blocked = reduce(asked.state, { type: "browser.decide", allow: false });
  assert.equal(blocked.state.browserApproval, null);
  assert.deepEqual(blocked.state.browserOrigins, []);
  assert.deepEqual(blocked.state.browserTabs, [], "a tab that only carried the ask goes with it");

  const allowed = reduce(asked.state, { type: "browser.decide", allow: true });
  assert.deepEqual(allowed.state.browserOrigins, ["https://dash.example.com"]);
  assert.equal(allowed.state.browserTabs[0].url, "https://dash.example.com/metrics");
  assert.equal(allowed.state.browserApproval, null);

  const again = reduce(allowed.state, { type: "browser.open", taskId: "task-1", url: "https://dash.example.com/other" });
  assert.equal(again.state.browserApproval, null, "an allowed origin is not asked about twice");
  assert.equal(again.effects[0].type, "browser.navigate");
});

test("a thread trusted to act without asking browses without asking", () => {
  const state = { ...workspace(), tasks: [task("task-1", { executionPolicy: "autonomous" })], currentId: "task-1" };

  const opened = reduce(state, { type: "browser.open", taskId: "task-1", url: "https://example.com" });

  assert.equal(opened.state.browserApproval, null);
  assert.equal(opened.state.browserTabs[0].url, "https://example.com/");
  assert.deepEqual(opened.state.browserOrigins, [], "acting without asking is not the user saying yes");
});

test("closing a browser tab hands the panel its neighbour", () => {
  const first = reduce(workspace(), { type: "browser.open", url: "https://one.example" });
  const second = reduce(first.state, { type: "browser.open", url: "https://two.example", newTab: true });
  const [one, two] = second.state.browserTabs;

  const closed = reduce(second.state, { type: "browser.close-tab", tabId: two.id });
  assert.deepEqual(closed.state.browserTabs.map((tab) => tab.id), [one.id]);
  assert.equal(closed.state.browserTabId, one.id);
  assert.deepEqual(closed.effects.filter((effect) => effect.type.startsWith("browser")), [
    { type: "browser.close", tabId: two.id },
    { type: "browser.open", tabId: one.id, url: "https://one.example/" },
    { type: "browser.show", tabId: one.id },
  ]);

  const empty = reduce(closed.state, { type: "browser.close-tab", tabId: one.id });
  assert.equal(empty.state.browserTabId, null);
  assert.deepEqual(empty.effects.filter((effect) => effect.type === "browser.show"), [{ type: "browser.show", tabId: null }]);
});

test("what a page reports is the only thing that writes the tab record", () => {
  const opened = reduce(workspace(), { type: "browser.open", url: "https://example.com" });
  const [tab] = opened.state.browserTabs;

  const updated = reduce(opened.state, {
    type: "browser.updated",
    page: { tabId: tab.id, url: "https://example.com/welcome", title: "Welcome", loading: false, canGoBack: true },
  });

  assert.deepEqual(updated.state.browserTabs[0], { ...tab, url: "https://example.com/welcome", title: "Welcome", loading: false, canGoBack: true });
  assert.deepEqual(updated.effects.at(-1).preferences.browserTabs, ["https://example.com/welcome"]);

  const stray = reduce(updated.state, { type: "browser.updated", page: { tabId: "gone", title: "Nowhere" } });
  assert.equal(stray.state, updated.state);
});

test("a page that fails keeps saying so until the tab lands somewhere else", () => {
  const opened = reduce(workspace(), { type: "browser.open", url: "https://example.com/missing" });
  const tabId = opened.state.browserTabs[0].id;

  const failed = run(opened.state, [
    { type: "browser.updated", page: { tabId, loading: false, error: "ERR_NAME_NOT_RESOLVED (https://example.com/missing)" } },
    { type: "browser.updated", page: { tabId, loading: false, url: "https://example.com/missing", title: "" } },
  ]);
  assert.match(failed.browserTabs[0].error, /ERR_NAME_NOT_RESOLVED/, "the load settling is not the failure being over");

  const landed = reduce(failed, { type: "browser.updated", page: { tabId, loading: false, url: "https://example.com/", title: "Example" } });
  assert.equal(landed.state.browserTabs[0].error, undefined);
});

test("acting in the browser needs a page, and clearing the session takes back every allowed site", () => {
  const empty = reduce(workspace(), { type: "browser.act", taskId: "task-1", action: { kind: "click", ref: "3" } });
  assert.match(empty.state.actionError, /no page open/);

  const opened = reduce(workspace(), { type: "browser.open", url: "https://example.com" });
  const clicked = reduce(opened.state, { type: "browser.act", taskId: "task-1", action: { kind: "click", ref: "3" } });
  assert.deepEqual(clicked.effects, [{ type: "browser.act", tabId: opened.state.browserTabs[0].id, action: { kind: "click", ref: "3" } }]);

  const cleared = reduce(opened.state, { type: "browser.clear-data" });
  assert.deepEqual(cleared.state.browserOrigins, []);
  assert.equal(cleared.effects[0].type, "browser.clear-data");
});

test("a terminal opens in the thread's own checkout and takes a dock tab of its own", () => {
  const state = {
    ...workspace(),
    projects: [{ id: "project-1", root: "/repo" }],
    tasks: [task("task-1", { projectId: "project-1" })],
    currentId: "task-1",
  };

  const opened = reduce(state, { type: "terminal.open" });
  const [terminal] = opened.state.terminals;

  assert.equal(terminal.cwd, "/repo");
  assert.equal(terminal.title, "repo");
  assert.equal(terminal.taskId, "task-1");
  assert.equal(terminal.status, "running");
  assert.equal(opened.state.terminalId, terminal.id);
  assert.equal(opened.state.dockOpen, true, "a shell has to land somewhere the user can see it");
  assert.equal(opened.state.dockTab, terminal.id, "a shell is a tab in the dock, not a tab inside a panel");
  assert.deepEqual(opened.effects, [{ type: "terminal.start", terminalId: terminal.id, cwd: "/repo" }]);

  const inWorktree = { ...state, tasks: [task("task-1", { projectId: "project-1", worktree: { id: "w1", root: "/worktrees/repo-w1", workspaceId: "ws-1", baseCommit: "abc", createdAt: 1, lastUsedAt: 1 } })] };
  assert.equal(reduce(inWorktree, { type: "terminal.open" }).state.terminals[0].cwd, "/worktrees/repo-w1");
});

test("a terminal needs a folder to start in", () => {
  const refused = reduce(workspace(), { type: "terminal.open" });

  assert.deepEqual(refused.state.terminals, []);
  assert.deepEqual(refused.effects, []);
  assert.equal(refused.state.actionError, WORKSPACE_ERRORS.terminalFolder);
});

test("what a shell reports is the only thing that writes the terminal record, and its output is never state", () => {
  const opened = reduce(workspace({ lastFolder: "/repo" }), { type: "terminal.open" });
  const [terminal] = opened.state.terminals;

  const named = reduce(opened.state, { type: "terminal.updated", update: { terminalId: terminal.id, title: "npm run dev" } });
  assert.equal(named.state.terminals[0].title, "npm run dev");

  const exited = reduce(named.state, { type: "terminal.updated", update: { terminalId: terminal.id, status: "exited", exitCode: 1 } });
  assert.equal(exited.state.terminals[0].status, "exited");
  assert.equal(exited.state.terminals[0].exitCode, 1);
  assert.deepEqual(exited.effects, [], "a record change asks for no work");

  const stray = reduce(exited.state, { type: "terminal.updated", update: { terminalId: "gone", title: "Nowhere" } });
  assert.equal(stray.state, exited.state);

  assert.equal(JSON.stringify(exited.state).includes("output"), false);
});

test("typing and resizing a terminal ask for work without touching state", () => {
  const opened = reduce(workspace({ lastFolder: "/repo" }), { type: "terminal.open" });
  const [terminal] = opened.state.terminals;

  const typed = reduce(opened.state, { type: "terminal.input", terminalId: terminal.id, data: "ls\r" });
  assert.equal(typed.state, opened.state);
  assert.deepEqual(typed.effects, [{ type: "terminal.write", terminalId: terminal.id, data: "ls\r" }]);

  const resized = reduce(opened.state, { type: "terminal.resize", terminalId: terminal.id, cols: 120, rows: 40 });
  assert.equal(resized.state, opened.state);
  assert.deepEqual(resized.effects, [{ type: "terminal.resize", terminalId: terminal.id, cols: 120, rows: 40 }]);
});

test("closing a terminal hands the panel its neighbour and kills only the shell that went", () => {
  const first = reduce(workspace({ lastFolder: "/repo" }), { type: "terminal.open" });
  const second = reduce(first.state, { type: "terminal.open" });
  const [one, two] = second.state.terminals;

  const closed = reduce(second.state, { type: "terminal.close", terminalId: two.id });
  assert.deepEqual(closed.state.terminals.map((terminal) => terminal.id), [one.id]);
  assert.equal(closed.state.terminalId, one.id);
  assert.deepEqual(closed.effects, [{ type: "terminal.close", terminalId: two.id }]);

  const empty = reduce(closed.state, { type: "terminal.close", terminalId: one.id });
  assert.equal(empty.state.terminalId, null);
  assert.deepEqual(empty.state.terminals, []);
});

test("⌘W closes the terminal in front, then the dock behind it", () => {
  const opened = reduce(workspace({ lastFolder: "/repo" }), { type: "terminal.open" });
  const [terminal] = opened.state.terminals;

  const closedShell = reduce(opened.state, { type: "view.close-tab" });
  assert.deepEqual(closedShell.state.terminals, []);
  assert.deepEqual(closedShell.effects, [{ type: "terminal.close", terminalId: terminal.id }]);
  assert.equal(closedShell.state.dockTab, "home", "nothing is left in the dock but the picker");

  assert.equal(reduce(closedShell.state, { type: "view.close-tab" }).state.dockOpen, false);
});

test("the dock remembers which panels are open, and a thread switch keeps the pages and shells", () => {
  const state = { ...workspace(), lastFolder: "/repo", tasks: [task("task-1"), task("task-2")], currentId: "task-1", history: ["task-1"], historyIndex: 0 };

  const opened = run(state, [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "browser.open", url: "https://one.example" },
    { type: "terminal.open" },
  ]);
  const [page] = opened.browserTabs;
  const [shell] = opened.terminals;
  assert.deepEqual(opened.dockPanels, ["agents"], "only a panel there is one of is a panel");
  assert.equal(opened.dockTab, shell.id);
  assert.equal(opened.dockOpen, true);

  const switched = reduce(opened, { type: "task.select", taskId: "task-2" });
  assert.deepEqual(switched.state.dockPanels, [], "a panel about the thread goes with the thread");
  assert.deepEqual(switched.state.browserTabs.map((tab) => tab.id), [page.id], "a page outlives the thread that was showing it");
  assert.deepEqual(switched.state.terminals.map((terminal) => terminal.id), [shell.id], "so does a shell");
  assert.equal(switched.state.dockTab, shell.id, "and the one in front keeps showing");

  const closed = reduce(switched.state, { type: "terminal.close", terminalId: shell.id });
  assert.equal(closed.state.dockTab, page.id, "closing a tab hands the dock its neighbour");

  const empty = reduce(closed.state, { type: "browser.close-tab", tabId: page.id });
  assert.equal(empty.state.dockTab, "home");

  const hidden = reduce(empty.state, { type: "view.set-dock-open", open: false });
  assert.equal(hidden.state.dockOpen, false);
});

test("a restored page waits for the panel to show it before it loads", () => {
  const restored = reduce(workspace(), {
    type: "preferences.loaded",
    preferences: { sessionPanelOpen: false, browserTabs: ["https://example.com/docs", "not a url"], browserOrigins: ["https://example.com"] },
  });

  assert.deepEqual(restored.state.browserTabs.map((tab) => tab.url), ["https://example.com/docs"]);
  assert.equal(restored.state.browserTabs[0].loading, false);
  assert.deepEqual(restored.effects, [], "restoring records loads nothing on its own");

  const tabId = restored.state.browserTabs[0].id;
  const shown = reduce(restored.state, { type: "view.select-dock-tab", tab: tabId });
  assert.deepEqual(shown.effects, [
    { type: "browser.open", tabId, url: "https://example.com/docs" },
    { type: "browser.show", tabId },
  ]);

  const kept = reduce(shown.state, { type: "store.loaded", data: { tasks: [], projects: [], lastFolder: null } });
  assert.deepEqual(kept.state.browserTabs, shown.state.browserTabs, "loading the store does not drop the window's pages");
  assert.deepEqual(kept.state.browserOrigins, ["https://example.com"]);
});

test("a side chat is the dock tab it opens, and closing it gives the dock back its last panel", () => {
  const state = { ...workspace(), tasks: [task("task-1")], currentId: "task-1" };

  const opened = run(state, [
    { type: "view.open-dock-panel", panel: "browser" },
    { type: "side-chat.open", chatId: "chat-1" },
  ]);
  assert.equal(opened.dockTab, "chat-1");
  assert.equal(opened.dockOpen, true);

  const closed = reduce(opened, { type: "side-chat.close", chatId: "chat-1" });
  assert.equal(closed.state.dockTab, "browser");
});

test("closing a tab takes what is in front, and only then the window", () => {
  const base = { ...workspace(), tasks: [task("task-1")], currentId: "task-1" };

  assert.deepEqual(reduce(base, { type: "view.close-tab" }).effects, [{ type: "close-window" }], "nothing is in front of a bare window");

  const settings = reduce(base, { type: "view.set-settings-open", open: true });
  const shut = reduce(settings.state, { type: "view.close-tab" });
  assert.equal(shut.state.settingsOpen, false);
  assert.deepEqual(shut.effects, [], "settings closing is not the window closing");

  const asked = reduce({ ...base, computerUseSetup: true }, { type: "view.close-tab" });
  assert.equal(asked.state.computerUseSetup, false, "the settings computer use opened close the same way");

  const browsing = run(base, [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "browser.open", url: "https://one.example" },
    { type: "browser.open", url: "https://two.example", newTab: true },
  ]);
  const [first, second] = browsing.browserTabs;

  const closedPage = reduce(browsing, { type: "view.close-tab" });
  assert.deepEqual(closedPage.state.browserTabs.map((tab) => tab.id), [first.id], "the page in front is what ⌘W takes");
  assert.equal(closedPage.effects.some((effect) => effect.type === "browser.close" && effect.tabId === second.id), true);
  assert.equal(closedPage.state.dockTab, first.id, "and the dock lands on its neighbour");

  const closedLast = reduce(closedPage.state, { type: "view.close-tab" });
  assert.deepEqual(closedLast.state.browserTabs, []);
  assert.equal(closedLast.state.dockTab, "agents", "the panel behind the pages is the next thing in front");

  const closedAgents = reduce(closedLast.state, { type: "view.close-tab" });
  assert.deepEqual(closedAgents.state.dockPanels, []);
  assert.equal(closedAgents.state.dockTab, "home");

  const closedDock = reduce(closedAgents.state, { type: "view.close-tab" });
  assert.equal(closedDock.state.dockOpen, false, "the picker showing means the dock itself is what is in front");
  assert.deepEqual(closedDock.effects, []);

  assert.deepEqual(reduce(closedDock.state, { type: "view.close-tab" }).effects, [{ type: "close-window" }]);
});

test("a side chat in front closes on ⌘W without taking the thread with it", () => {
  const state = run({ ...workspace(), tasks: [task("task-1")], currentId: "task-1" }, [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "side-chat.open", chatId: "chat-1" },
  ]);
  assert.equal(state.dockTab, "chat-1");

  const closed = reduce(state, { type: "view.close-tab" });
  assert.deepEqual(closed.state.sideChats, []);
  assert.equal(closed.state.tasks.some((item) => item.id === "chat-1"), false, "a side chat's thread goes with it");
  assert.equal(closed.state.dockTab, "agents");
});

test("opening settings puts the dock away, and closing them forgets the computer use ask", () => {
  const opened = run({ ...workspace(), tasks: [task("task-1")], currentId: "task-1", computerUseSetup: true }, [
    { type: "view.open-dock-panel", panel: "agents" },
    { type: "view.set-settings-open", open: true },
  ]);
  assert.equal(opened.dockOpen, false);
  assert.equal(deriveView(opened).settingsOpen, true);

  const closed = reduce(opened, { type: "view.set-settings-open", open: false });
  assert.equal(closed.state.computerUseSetup, false);
  assert.equal(deriveView(closed.state).settingsOpen, false);
});
