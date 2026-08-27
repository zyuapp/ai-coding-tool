import assert from "node:assert/strict";
import { test } from "vitest";
import { clampQuote, promptWithAnnotations } from "../../src/application/annotations.ts";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { deriveView, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { Task } from "../../src/domain/task.ts";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...emptyWorkspaceState(), ...overrides };
}

function run(state: WorkspaceState, inputs: WorkspaceInput[]): WorkspaceState {
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
  assert.ok(added);
  assert.equal(added.quote.length, 2000);
  assert.ok(added.quote.endsWith("…"));
  assert.equal(clampQuote("short"), "short");
  assert.deepEqual(reduce(currentWorkspace(), { type: "annotation.add", quote: "   " }).state.annotations, {});
});

test("annotations are drafted per task, their notes edited and removed by id", () => {
  const drafted = run(currentWorkspace(), [
    { type: "annotation.add", quote: "first", note: "typed at the highlight", anchor: { kind: "message", messageId: "m-1", start: 4, end: 9 } },
    { type: "annotation.add", quote: "second" },
  ]);
  const [first, second] = drafted.annotations["task-1"]!;
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual([first.quote, second.quote], ["first", "second"]);
  assert.equal(first.note, "typed at the highlight");
  assert.deepEqual(first.anchor, { kind: "message", messageId: "m-1", start: 4, end: 9 });
  assert.equal(second.anchor, undefined, "a side chat reference carries no anchor");

  const noted = run(drafted, [{ type: "annotation.note", annotationId: first.id, note: "keep this" }]);
  assert.equal(noted.annotations["task-1"]![0].note, "keep this");

  const removed = run(noted, [{ type: "annotation.remove", annotationId: second.id }]);
  assert.deepEqual(removed.annotations["task-1"]!.map((item) => item.quote), ["first"]);
  assert.deepEqual(run(removed, [{ type: "annotation.remove", annotationId: first.id }]).annotations, {});
});

test("a send flattens annotations into the prompt, keeps them on the message, and clears the draft", () => {
  const drafted = run(currentWorkspace(), [
    { type: "view.set-prompt", prompt: "About this" },
    { type: "annotation.add", quote: "the claim", anchor: { kind: "message", messageId: "m-1", start: 0, end: 9 } },
  ]);
  const noted = run(drafted, [{ type: "annotation.note", annotationId: drafted.annotations["task-1"]![0].id, note: "not true" }]);

  const sending = reduce(noted, { type: "task.send", attachments: [] });
  const resolveEffect = sending.effects[0];
  assert.equal(resolveEffect.type, "resolve-run-workspace");
  if (resolveEffect.type !== "resolve-run-workspace") assert.fail("expected workspace resolution");
  const started = reduce(sending.state, { type: "run.resolved", pendingId: resolveEffect.pendingId, workspace: { id: "w", kind: "projectless", root: "/tmp" } });
  const [effect] = started.effects;
  assert.equal(effect.type, "start-run");
  if (effect.type !== "start-run") assert.fail("expected a run");
  assert.ok(effect.command.prompt.startsWith("About this\n\n"));
  assert.ok(effect.command.prompt.includes("> the claim\nnot true"));

  const message = started.state.tasks[0].messages.at(-1);
  assert.ok(message);
  assert.equal(message.text, "About this");
  assert.deepEqual(message.annotations!.map((item) => [item.quote, item.note]), [["the claim", "not true"]]);
  assert.ok(message.annotations!.every((item) => item.anchor === undefined), "the sent message keeps no anchor");
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
  const running: WorkspaceState = { ...base, activeRuns: { "task-1": {
    taskId: "task-1",
    runId: "run-1",
    sequence: 0,
    status: "running",
    origin: "composer",
    quiet: false,
    notified: false,
    acknowledged: false,
    reportedIssues: [],
    messagesBefore: 0,
    before: { updatedAt: 1 },
  } } };

  const queued = reduce(running, { type: "task.send", attachments: [] }).state;
  const [message] = queued.queuedMessages["task-1"];
  assert.ok(message);
  assert.ok(message.prompt.includes("> queued quote"));
  assert.deepEqual(message.annotations!.map((item) => item.quote), ["queued quote"]);
  assert.deepEqual(queued.annotations, {}, "the draft cleared when the message joined the queue");

  const cancelled = reduce(queued, { type: "run.event", event: { type: "run.status", taskId: "task-1", runId: "run-1", sequence: 1, status: "cancelled" } }).state;
  assert.deepEqual(cancelled.queuedMessages, {});
  assert.equal(cancelled.prompts["task-1"], "Queue me");
  assert.deepEqual(cancelled.annotations["task-1"]!.map((item) => item.quote), ["queued quote"]);
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

test("a new annotation hands the caret to the composer that will carry it, but a diff comment does not", () => {
  const start = currentWorkspace();
  const noted = reduce(start, { type: "annotation.add", quote: "the claim", anchor: { kind: "message", messageId: "m-1", start: 0, end: 9 } }).state;
  assert.equal(noted.composerFocus, start.composerFocus + 1);

  const reviewed = reduce(noted, { type: "annotation.add", quote: "a changed line", anchor: { kind: "diff", comparison: "working", path: "a.ts", start: "1", end: "1", side: "new" } }).state;
  assert.equal(reviewed.composerFocus, noted.composerFocus, "the review keeps the keyboard while the rows are worked down");

  const empty = reduce(reviewed, { type: "annotation.add", quote: "   " }).state;
  assert.equal(empty.composerFocus, reviewed.composerFocus, "a quote that clamps away is no annotation at all");
});

test("an annotation made in a side chat focuses that chat's composer, not the thread's own", () => {
  const opened = run(currentWorkspace(), [{ type: "side-chat.open", chatId: "chat-1" }]);
  const noted = reduce(opened, { type: "annotation.add", taskId: "chat-1", quote: "for the side" }).state;
  assert.equal(noted.composerFocus, opened.composerFocus, "the thread's own composer is left alone");
  assert.deepEqual(noted.dockFocus, { owner: "task-1", tab: "chat-1", count: opened.dockFocus!.count + 1 });
});
