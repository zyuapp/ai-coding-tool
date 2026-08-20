import assert from "node:assert/strict";
import test from "node:test";
import { pasteRidesAsPill, pasteSummary, pasteTitle, promptWithPastes } from "../dist/main/application/pastes.js";
import { reduce } from "../dist/main/application/workspace-reducer.js";
import { deriveView, emptyWorkspaceState } from "../dist/main/application/workspace-state.js";

const LONG = Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n");

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

function run(state, inputs) {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

function currentWorkspace() {
  return { ...emptyWorkspaceState(), tasks: [task("task-1")], currentId: "task-1" };
}

test("only a paste big enough to bury the prompt rides as a pill", () => {
  assert.equal(pasteRidesAsPill("a sentence I meant to type"), false);
  assert.equal(pasteRidesAsPill("one\ntwo\nthree"), false);
  assert.equal(pasteRidesAsPill(LONG), true);
  assert.equal(pasteRidesAsPill("x".repeat(1000)), true);
  assert.equal(pasteRidesAsPill("   "), false);
});

test("a pill says how much it holds: lines when it has a shape, characters when it does not", () => {
  assert.equal(pasteSummary("one\ntwo"), "2 lines");
  assert.equal(pasteSummary("x".repeat(1200)), "1,200 characters");
});

test("the prompt carries each pasted block in order, numbered the way the pills are", () => {
  const flat = promptWithPastes("Read this", [{ id: "a", text: "first block" }, { id: "b", text: "second block" }]);
  assert.match(flat, /^Read this\n\n/);
  assert.ok(flat.includes("Pasted text #1:\nfirst block"));
  assert.ok(flat.endsWith("Pasted text #2:\nsecond block"));
  assert.equal(promptWithPastes("Just text", []), "Just text");
});

test("pastes are drafted per task and removed by id", () => {
  const drafted = run(currentWorkspace(), [
    { type: "paste.add", text: LONG },
    { type: "paste.add", text: "second" },
  ]);
  const [first, second] = drafted.pastes["task-1"];
  assert.deepEqual([first.text, second.text], [LONG, "second"]);
  assert.deepEqual(deriveView(drafted).pastes.map((item) => item.text), [LONG, "second"]);
  assert.deepEqual(reduce(currentWorkspace(), { type: "paste.add", text: "" }).state.pastes, {});

  const removed = run(drafted, [{ type: "paste.remove", pasteId: first.id }]);
  assert.deepEqual(removed.pastes["task-1"].map((item) => item.text), ["second"]);
  assert.deepEqual(run(removed, [{ type: "paste.remove", pasteId: second.id }]).pastes, {});
});

test("a send flattens pastes into the prompt, keeps them on the message, and clears the draft", () => {
  const drafted = run(currentWorkspace(), [
    { type: "view.set-prompt", prompt: "Fix this stack trace" },
    { type: "paste.add", text: LONG },
  ]);

  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "w", kind: "projectless", root: "/tmp" } });
  const [effect] = started.effects;
  assert.ok(effect.command.prompt.startsWith("Fix this stack trace\n\n"));
  assert.ok(effect.command.prompt.includes(`Pasted text #1:\n${LONG}`));

  const message = started.state.tasks[0].messages.at(-1);
  assert.equal(message.text, "Fix this stack trace", "the transcript keeps the typed words, not the blob");
  assert.deepEqual(message.pastes.map((item) => item.text), [LONG]);
  assert.deepEqual(started.state.pastes, {});
});

test("a paste alone is enough to send, and titles the thread from its first line", () => {
  const drafted = run(emptyWorkspaceState(), [{ type: "paste.add", text: LONG }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  assert.equal(sending.effects[0].type, "resolve-run-workspace");
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "w", kind: "projectless", root: "/tmp" } });
  assert.equal(started.state.tasks[0].title, "line 0");
  assert.equal(pasteTitle([{ id: "a", text: "\n\n  the first words  \nmore" }]), "the first words");
});

test("a send during a run queues the pastes, and a cancelled run hands them back", () => {
  const base = run(currentWorkspace(), [
    { type: "view.set-prompt", prompt: "Queue me" },
    { type: "paste.add", text: LONG },
  ]);
  const running = { ...base, activeRuns: { "task-1": { taskId: "task-1", runId: "run-1", sequence: 0, status: "running" } } };

  const queued = reduce(running, { type: "task.send", attachments: [] }).state;
  const [message] = queued.queuedMessages["task-1"];
  assert.ok(message.prompt.includes("Pasted text #1:"));
  assert.deepEqual(message.pastes.map((item) => item.text), [LONG]);
  assert.deepEqual(queued.pastes, {}, "the draft cleared when the message joined the queue");

  const cancelled = reduce(queued, { type: "run.event", event: { type: "run.status", taskId: "task-1", runId: "run-1", sequence: 1, status: "cancelled" } }).state;
  assert.equal(cancelled.prompts["task-1"], "Queue me");
  assert.deepEqual(cancelled.pastes["task-1"].map((item) => item.text), [LONG]);
});

test("a side chat drafts its own pastes, and closing it takes them along", () => {
  const opened = run(currentWorkspace(), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "paste.add", taskId: "chat-1", text: LONG },
  ]);
  assert.deepEqual(deriveView(opened).sideChats[0].pastes.map((item) => item.text), [LONG]);
  assert.deepEqual(deriveView(opened).pastes, [], "the main composer shows none of it");
  assert.deepEqual(run(opened, [{ type: "side-chat.close", chatId: "chat-1" }]).pastes, {});
});
