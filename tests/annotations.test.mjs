import assert from "node:assert/strict";
import test from "node:test";
import { clampQuote, promptWithAnnotations } from "../dist/main/application/annotations.js";
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

function run(state, inputs) {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

function currentWorkspace() {
  return workspace({ tasks: [task("task-1")], currentId: "task-1" });
}

test("the prompt carries each quote and its note, and an empty note stays quiet", () => {
  const flat = promptWithAnnotations("Fix it", [
    { id: "a", quote: "line one\nline two", note: "this is wrong" },
    { id: "b", quote: "another claim", note: "  " },
  ]);
  assert.match(flat, /^Fix it\n\n/);
  assert.ok(flat.includes("> line one\n> line two\nthis is wrong"));
  assert.ok(flat.endsWith("> another claim"));
  assert.equal(promptWithAnnotations("Just text", []), "Just text");
});

test("a quote is clamped when it is made, so a select-all cannot flood the prompt", () => {
  const state = reduce(currentWorkspace(), { type: "annotation.add", quote: `  ${"x".repeat(5000)}  ` }).state;
  const [added] = deriveView(state).annotations;
  assert.equal(added.quote.length, 2000);
  assert.ok(added.quote.endsWith("…"));
  assert.equal(clampQuote("short"), "short");
  assert.deepEqual(reduce(currentWorkspace(), { type: "annotation.add", quote: "   " }).state.annotations, {});
});

test("annotations are drafted per task, their notes edited and removed by id", () => {
  const drafted = run(currentWorkspace(), [
    { type: "annotation.add", quote: "first", note: "typed at the highlight", anchor: { messageId: "m-1", start: 4, end: 9 } },
    { type: "annotation.add", quote: "second" },
  ]);
  const [first, second] = drafted.annotations["task-1"];
  assert.deepEqual([first.quote, second.quote], ["first", "second"]);
  assert.equal(first.note, "typed at the highlight");
  assert.deepEqual(first.anchor, { messageId: "m-1", start: 4, end: 9 });
  assert.equal(second.anchor, undefined, "a side chat reference carries no anchor");

  const noted = run(drafted, [{ type: "annotation.note", annotationId: first.id, note: "keep this" }]);
  assert.equal(noted.annotations["task-1"][0].note, "keep this");

  const removed = run(noted, [{ type: "annotation.remove", annotationId: second.id }]);
  assert.deepEqual(removed.annotations["task-1"].map((item) => item.quote), ["first"]);
  assert.deepEqual(run(removed, [{ type: "annotation.remove", annotationId: first.id }]).annotations, {});
});

test("a send flattens annotations into the prompt, keeps them on the message, and clears the draft", () => {
  const drafted = run(currentWorkspace(), [
    { type: "view.set-prompt", prompt: "About this" },
    { type: "annotation.add", quote: "the claim", anchor: { messageId: "m-1", start: 0, end: 9 } },
  ]);
  const noted = run(drafted, [{ type: "annotation.note", annotationId: drafted.annotations["task-1"][0].id, note: "not true" }]);

  const sending = reduce(noted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: { id: "w", kind: "projectless", root: "/tmp" } });
  const [effect] = started.effects;
  assert.ok(effect.command.prompt.startsWith("About this\n\n"));
  assert.ok(effect.command.prompt.includes("> the claim\nnot true"));

  const message = started.state.tasks[0].messages.at(-1);
  assert.equal(message.text, "About this");
  assert.deepEqual(message.annotations.map((item) => [item.quote, item.note]), [["the claim", "not true"]]);
  assert.ok(message.annotations.every((item) => item.anchor === undefined), "the sent message keeps no anchor");
  assert.deepEqual(started.state.annotations, {});
});

test("annotations alone are enough to send", () => {
  const drafted = run(currentWorkspace(), [{ type: "annotation.add", quote: "just this" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  assert.equal(sending.effects.length, 1);
  assert.equal(sending.effects[0].type, "resolve-run-workspace");
});

test("a send during a run queues the annotations, and a cancelled run hands them back", () => {
  const base = run(currentWorkspace(), [
    { type: "view.set-prompt", prompt: "Queue me" },
    { type: "annotation.add", quote: "queued quote" },
  ]);
  const running = { ...base, activeRuns: { "task-1": { taskId: "task-1", runId: "run-1", sequence: 0, status: "running" } } };

  const queued = reduce(running, { type: "task.send", attachments: [] }).state;
  const [message] = queued.queuedMessages["task-1"];
  assert.ok(message.prompt.includes("> queued quote"));
  assert.deepEqual(message.annotations.map((item) => item.quote), ["queued quote"]);
  assert.deepEqual(queued.annotations, {}, "the draft cleared when the message joined the queue");

  const cancelled = reduce(queued, { type: "run.event", event: { type: "run.status", taskId: "task-1", runId: "run-1", sequence: 1, status: "cancelled" } }).state;
  assert.deepEqual(cancelled.queuedMessages, {});
  assert.equal(cancelled.prompts["task-1"], "Queue me");
  assert.deepEqual(cancelled.annotations["task-1"].map((item) => item.quote), ["queued quote"]);
});

test("a side chat drafts its own annotations, and closing it takes them along", () => {
  const opened = run(currentWorkspace(), [
    { type: "side-chat.open", chatId: "chat-1" },
    { type: "annotation.add", taskId: "chat-1", quote: "for the side" },
  ]);
  assert.deepEqual(deriveView(opened).sideChats[0].annotations.map((item) => item.quote), ["for the side"]);
  assert.deepEqual(deriveView(opened).annotations, [], "the main composer shows none of it");

  const closed = run(opened, [{ type: "side-chat.close", chatId: "chat-1" }]);
  assert.deepEqual(closed.annotations, {});
});

test("recalling a sent message puts its annotations back over whatever the draft holds", () => {
  const drafted = run(currentWorkspace(), [{ type: "annotation.add", quote: "drafted since" }]);
  const sent = [{ id: "a", quote: "what was sent", note: "and its note" }];

  const recalled = reduce(drafted, { type: "annotation.recall", annotations: sent }).state;
  assert.deepEqual(recalled.annotations["task-1"], sent, "the recall replaces the draft rather than adding to it");

  const stepped = reduce(recalled, { type: "annotation.recall", annotations: [] }).state;
  assert.deepEqual(stepped.annotations, {}, "stepping back down to an empty draft leaves nothing behind");
});
