import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { threadSummaries } from "../../src/application/thread-projection.ts";
import { dock, task, workspace, automation, effectAt, required, run, running, send } from "./workspace-reducer-fixtures.mts";

test("a side chat forks the source thread once, then continues on its own branch", () => {
  const source = task("main-task", { executionPolicy: "autonomous", continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "What does this do?" },
  ]);
  assert.equal(required(deriveView(opened).sideChats[0]).title, "Chat 1");

  const sending = reduce(opened, { type: "task.send", taskId: "chat-1" });
  const forked = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const first = effectAt(forked, "start-run").command;
  assert.equal(first.channel, "side");
  assert.equal(first.policy, "autonomous", "the chat starts from the source thread's policy");
  assert.equal(first.forkContinuation, true);
  assert.deepEqual(first.continuation, { provider: "claude", value: "main-session" });
  assert.equal(required(deriveView(forked.state).sideChats[0]).prompt, "");
  assert.equal(required(required(deriveView(forked.state).sideChats[0]).task.messages[0]).text, "What does this do?");

  const branched = run(forked.state, [
    { type: "run.event", event: { type: "continuation.updated", taskId: "chat-1", runId: first.runId, sequence: 1, continuation: { provider: "claude", value: "side-session" } } },
    { type: "run.event", event: { type: "run.status", taskId: "chat-1", runId: first.runId, sequence: 2, status: "succeeded" } },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "Follow up" },
  ]);
  const resending = reduce(branched, { type: "task.send", taskId: "chat-1" });
  const resolved = reduce(resending.state, { type: "run.resolved", pendingId: effectAt(resending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const second = effectAt(resolved, "start-run").command;

  assert.deepEqual(second.continuation, { provider: "claude", value: "side-session" });
  assert.equal("forkContinuation" in second, false);
  assert.deepEqual(required(branched.tasks.find((task) => task.id === "main-task")).continuation, { provider: "claude", value: "main-session" }, "the main thread never moves");
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
  const sideChat = required(deriveView(opened).sideChats[0]);
  assert.equal(sideChat.task.executionPolicy, "confirm");
  assert.equal(sideChat.task.model, "opus");
  assert.equal(sideChat.task.effort, "high");

  const retuned = run(opened, [
    { type: "task.set-policy", taskId: "chat-1", policy: "autonomous" },
    { type: "task.set-model", taskId: "chat-1", model: "haiku" },
    { type: "task.set-effort", taskId: "chat-1", effort: "low" },
    { type: "task.set-policy", taskId: "main-task", policy: "allow-edits" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "Fix the typo" },
  ]);
  assert.equal(required(retuned.tasks.find((task) => task.id === "main-task")).executionPolicy, "allow-edits", "the main thread keeps its own policy");

  const sending = reduce(retuned, { type: "task.send", taskId: "chat-1" });
  const resolved = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const command = effectAt(resolved, "start-run").command;
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
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const start = effectAt(started, "start-run");
  const { runId } = start.command;
  assert.match(start.command.prompt, /shot\.png/, "a side chat sends its attachments");
  assert.deepEqual(started.effects.filter((effect) => effect.type === "suggest-title"), [], "a side chat keeps the name the dock gave it");

  const queued = reduce(started.state, { type: "task.send", taskId: "chat-1", text: "And the state file" });
  assert.deepEqual(queued.state.queuedMessages["chat-1"].map((message) => message.text), ["And the state file"], "queueing reaches a side chat");
  const steered = reduce(queued.state, { type: "task.steer-queued", taskId: "chat-1", messageId: queued.state.queuedMessages["chat-1"][0].id });
  assert.equal(effectAt(steered, "send-run-command").command.type, "steer");

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

test("a reading place is kept for its thread, and reporting it again changes nothing", () => {
  const state = workspace({ tasks: [task("task-a")], currentId: "task-a" });
  const placed = reduce(state, { type: "view.reading-point", taskId: "task-a", point: { anchor: "m3", depth: 72 } });
  assert.deepEqual(placed.state.readingPoints["task-a"], { anchor: "m3", depth: 72 });
  assert.equal(deriveView(placed.state).readingPoint, placed.state.readingPoints["task-a"], "the view hands the thread its own place back");

  const again = reduce(placed.state, { type: "view.reading-point", taskId: "task-a", point: { anchor: "m3", depth: 72 } });
  assert.equal(again.state, placed.state, "an unchanged place is not a new state");

  const moved = reduce(placed.state, { type: "view.reading-point", taskId: "task-a", point: { anchor: "m5", depth: -16 } });
  assert.deepEqual(moved.state.readingPoints["task-a"], { anchor: "m5", depth: -16 });

  const cleared = reduce(moved.state, { type: "view.reading-point", taskId: "task-a", point: null });
  assert.deepEqual(cleared.state.readingPoints["task-a"], null);
});

test("a reading place that is malformed or names no thread is refused", () => {
  const state = workspace({ tasks: [task("task-a")], currentId: "task-a" });
  for (const point of [{ anchor: "", depth: 0 }, { anchor: "m1", depth: Number.NaN }, { anchor: "m1", depth: Number.POSITIVE_INFINITY }]) {
    assert.equal(reduce(state, { type: "view.reading-point", taskId: "task-a", point }).state, state, `${point.anchor || "(empty)"} with ${point.depth} is not a place`);
  }
  assert.equal(reduce(state, { type: "view.reading-point", taskId: "no-such-thread", point: { anchor: "m1", depth: 0 } }).state, state);
});

test("closing a side chat takes its reading place with it", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source], currentId: "main-task", readingPoints: { "chat-1": { anchor: "m2", depth: 10 }, "main-task": { anchor: "m4", depth: 30 } } }), [
    { type: "side-chat.open", chatId: "chat-1" },
  ]);
  const closed = reduce(opened, { type: "side-chat.close", chatId: "chat-1" });
  assert.deepEqual(closed.state.readingPoints, { "main-task": { anchor: "m4", depth: 30 } });
});

test("closing a side chat cancels its run, and leaving the thread leaves the chat in its dock", () => {
  const source = task("main-task", { continuation: { provider: "claude", value: "main-session" }, continuationStatus: "available" });
  const opened = run(workspace({ tasks: [source, task("other")], currentId: "main-task" }), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "view.set-prompt", taskId: "chat-1", prompt: "Ask" },
  ]);
  const sending = reduce(opened, { type: "task.send", taskId: "chat-1" });
  const running = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } }).state;
  const runId = required(running.activeRuns["chat-1"]).runId;

  const closed = reduce(running, { type: "side-chat.close", chatId: "chat-1" });
  assert.deepEqual(closed.effects, [{ type: "send-run-command", command: { type: "cancel", taskId: "chat-1", runId } }]);
  assert.deepEqual(closed.state.sideChats, []);
  assert.equal(closed.state.activeRuns["chat-1"], undefined);

  const switched = reduce(running, { type: "task.select", taskId: "other" });
  assert.deepEqual(switched.state.sideChats.map((chat) => chat.id), ["chat-1"], "a fork belongs to the thread it was taken from");
  assert.equal(required(switched.state.activeRuns["chat-1"]).runId, runId, "so its run carries on while the user is elsewhere");
  assert.deepEqual(deriveView(switched.state).sideChats, [], "the thread the user landed on draws its own dock, which has no fork in it");
  assert.deepEqual(deriveView(reduce(switched.state, { type: "task.select", taskId: "main-task" }).state).sideChats.map((chat) => chat.id), ["chat-1"]);
});
