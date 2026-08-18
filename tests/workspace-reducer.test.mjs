import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../dist/main/application/workspace-reducer.js";
import { deriveView, emptyWorkspaceState } from "../dist/main/application/workspace-state.js";

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
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "side-chat.set-prompt", chatId: "chat-1", prompt: "What does this do?" },
  ]);
  assert.equal(opened.sideChats[0].title, "Chat 1");

  const sending = reduce(opened, { type: "side-chat.send", chatId: "chat-1" });
  const forked = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const first = forked.effects[0].command;
  assert.equal(first.channel, "side");
  assert.equal(first.policy, "plan");
  assert.equal(first.forkContinuation, true);
  assert.deepEqual(first.continuation, { provider: "claude", value: "main-session" });
  assert.equal(forked.state.sideChats[0].prompt, "");
  assert.equal(forked.state.sideChats[0].task.messages[0].text, "What does this do?");

  const branched = run(forked.state, [
    { type: "run.event", event: { type: "continuation.updated", taskId: "chat-1", runId: first.runId, sequence: 1, continuation: { provider: "claude", value: "side-session" } } },
    { type: "run.event", event: { type: "run.status", taskId: "chat-1", runId: first.runId, sequence: 2, status: "succeeded" } },
    { type: "side-chat.set-prompt", chatId: "chat-1", prompt: "Follow up" },
  ]);
  const resending = reduce(branched, { type: "side-chat.send", chatId: "chat-1" });
  const second = reduce(resending.state, { type: "run.resolved", pendingId: resending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).effects[0].command;

  assert.deepEqual(second.continuation, { provider: "claude", value: "side-session" });
  assert.equal("forkContinuation" in second, false);
  assert.deepEqual(branched.tasks[0].continuation, { provider: "claude", value: "main-session" }, "the main thread never moves");
});

test("a side chat cannot run without a source thread to fork", () => {
  const opened = run(workspace({ tasks: [task("main-task")], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "side-chat.set-prompt", chatId: "chat-1", prompt: "Ask" },
  ]);
  assert.deepEqual(reduce(opened, { type: "side-chat.send", chatId: "chat-1" }).effects, []);
});

test("closing a side chat cancels its run, and switching tasks closes every chat", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source, task("other")], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "side-chat.set-prompt", chatId: "chat-1", prompt: "Ask" },
  ]);
  const sending = reduce(opened, { type: "side-chat.send", chatId: "chat-1" });
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
  assert.deepEqual(closed.effects, [{ type: "persist-preferences", preferences: { sessionPanelOpen: false } }]);
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

test("a finished run drains everything still queued into one following run", () => {
  const queued = queueMessage(queueMessage(running(), "Run the tests"), "Then update the README");
  const finished = reduce(queued, {
    type: "run.event",
    event: { type: "run.status", taskId: "task-a", runId: "run-a", sequence: 1, status: "succeeded" },
  });

  const [resolve] = finished.effects.filter((effect) => effect.type === "resolve-run-workspace");
  assert.ok(resolve, "the drained queue asks for its workspace the way a send does");
  assert.equal(finished.state.queuedMessages["task-a"].length, 2, "the messages stay queued until the run actually starts");

  const started = reduce(finished.state, { type: "run.resolved", pendingId: resolve.pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const [start] = started.effects;
  assert.equal(start.command.prompt, "Run the tests\n\nThen update the README");
  assert.deepEqual(started.state.queuedMessages, {});
  assert.equal(started.state.tasks[0].messages.at(-1).text, "Run the tests\n\nThen update the README");
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
    { type: "side-chat.set-prompt", chatId: "chat-1", prompt: "What does this do?" },
  ]);
  const sending = reduce(opened, { type: "side-chat.send", chatId: "chat-1" });
  const { runId } = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).effects[0].command;
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).state;

  const streaming = reduce(started, { type: "run.event", event: { type: "assistant.tail", taskId: "chat-1", runId, sequence: 1, messageId: "message-1", text: "It reduces" } }).state;
  assert.deepEqual(streaming.streamingTails["chat-1"], { messageId: "message-1", text: "It reduces" });
  assert.equal(streaming.streamingTails["main-task"], undefined);
  assert.equal(deriveView(streaming).sideChats[0].streamingTail.text, "It reduces");
});

test("a new thread asks for a name, and the name the user types outlasts the suggestion", () => {
  const drafted = run(workspace(), [{ type: "view.set-prompt", prompt: "Inspect the app" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const taskId = started.state.tasks[0].id;

  assert.deepEqual(started.effects.filter((effect) => effect.type === "suggest-title"), [{ type: "suggest-title", taskId, text: "Inspect the app" }]);
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

test("only a thread the send just created is named, and only from what the user typed", () => {
  const existing = task("task-a", { title: "Inspect the app" });
  const drafted = run(workspace({ tasks: [existing], currentId: "task-a" }), [{ type: "view.set-prompt", prompt: "Now check the reducer" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(started.effects.some((effect) => effect.type === "suggest-title"), false);

  const attached = reduce(workspace(), { type: "task.send", attachments: [{ path: "/tmp/shot.png", labels: [] }] });
  const fromImage = reduce(attached.state, { type: "run.resolved", pendingId: attached.effects[0].pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.equal(fromImage.state.tasks[0].title, "Screenshot");
  assert.equal(fromImage.effects.some((effect) => effect.type === "suggest-title"), false, "there is no message to name a screenshot-only thread from");
});
