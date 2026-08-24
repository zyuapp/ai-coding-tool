import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput } from "../src/application/workspace-reducer.ts";
import { deriveView, emptyWorkspaceState, type WorkspaceState } from "../src/application/workspace-state.ts";
import { MAX_ATTACHMENTS, type Task } from "../src/domain/task.ts";

function task(id: string): Task {
  return {
    id,
    title: id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
  };
}

function run(state: WorkspaceState, inputs: WorkspaceInput[]): WorkspaceState {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

function workspaceWithTasks(): WorkspaceState {
  return { ...emptyWorkspaceState(), tasks: [task("task-1"), task("task-2")], currentId: "task-1" };
}

test("a grabbed window is drafted against the thread it landed in, and removed by id", () => {
  const drafted = run(workspaceWithTasks(), [
    { type: "image.add", path: "/attachments/one.png", label: "Figma — Untitled" },
    { type: "image.add", path: "/attachments/two.png", label: "Chrome" },
  ]);
  const [first, second] = drafted.images["task-1"]!;
  assert.ok(first);
  assert.ok(second);
  assert.deepEqual([first.path, second.path], ["/attachments/one.png", "/attachments/two.png"]);
  assert.equal(first.label, "Figma — Untitled");
  assert.deepEqual(deriveView(drafted).images.map((image) => image.path), ["/attachments/one.png", "/attachments/two.png"]);

  const removed = run(drafted, [{ type: "image.remove", imageId: first.id }]);
  assert.deepEqual(removed.images["task-1"]!.map((image) => image.path), ["/attachments/two.png"]);
  assert.deepEqual(run(removed, [{ type: "image.remove", imageId: second.id }]).images, {});
});

test("the same file dropped twice stays one image, however the app named its copies", () => {
  const twice = run(workspaceWithTasks(), [
    { type: "image.add", path: "/attachments/one.png", label: "shot.png", source: "/Users/me/shot.png" },
    { type: "image.add", path: "/attachments/two.png", label: "shot.png", source: "/Users/me/shot.png" },
  ]);
  assert.equal(twice.images["task-1"]!.length, 1);

  /** A pasted image has no file behind it, so two pastes stay two images. */
  const pasted = run(workspaceWithTasks(), [
    { type: "image.add", path: "/attachments/one.png", label: "" },
    { type: "image.add", path: "/attachments/two.png", label: "" },
  ]);
  assert.equal(pasted.images["task-1"]!.length, 2);
});

test("a grabbed window stays with its own thread while the user reads another", () => {
  const drafted = run(workspaceWithTasks(), [{ type: "image.add", path: "/attachments/one.png", label: "Figma" }]);
  const elsewhere = run(drafted, [{ type: "task.select", taskId: "task-2" }]);

  assert.deepEqual(deriveView(elsewhere).images, [], "the other thread's composer is its own");
  assert.deepEqual(deriveView(run(elsewhere, [{ type: "task.select", taskId: "task-1" }])).images.map((image) => image.path), ["/attachments/one.png"]);
});

test("a send clears the images it carried, and a path with nothing to say is ignored", () => {
  const drafted = run(workspaceWithTasks(), [
    { type: "view.set-prompt", prompt: "Why is this misaligned?" },
    { type: "image.add", path: "/attachments/one.png", label: "Figma" },
  ]);
  assert.deepEqual(run(drafted, [{ type: "image.add", path: "", label: "" }]).images["task-1"]!.length, 1);

  const sending = reduce(drafted, { type: "task.send", attachments: [{ path: "/attachments/one.png", labels: [] }] });
  const resolveEffect = sending.effects[0];
  assert.equal(resolveEffect.type, "resolve-run-workspace");
  if (resolveEffect.type !== "resolve-run-workspace") assert.fail("expected workspace resolution");
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: resolveEffect.pendingId,
    workspace: { id: "w", kind: "projectless", root: "/tmp" },
  });

  assert.deepEqual(started.state.tasks[0].messages.at(-1)!.attachments, ["/attachments/one.png"]);
  assert.deepEqual(started.state.images, {});
});

test("a composer takes no more images than a message may carry", () => {
  const additions: WorkspaceInput[] = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => (
    { type: "image.add", path: `/attachments/${index}.png`, label: "Figma" }
  ));
  const filled = run(workspaceWithTasks(), additions);
  assert.equal(filled.images["task-1"]!.length, MAX_ATTACHMENTS);
  assert.ok(filled.actionError);
  assert.match(filled.actionError, /up to 6 images/);
});

test("images queued behind a run come back to the composer when the run is stopped", () => {
  const drafted = run(workspaceWithTasks(), [
    { type: "view.set-prompt", prompt: "Why is this misaligned?" },
    { type: "image.add", path: "/attachments/one.png", label: "Figma" },
  ]);
  const sending = reduce(drafted, { type: "task.send", attachments: [{ path: "/attachments/one.png", labels: [] }] });
  const resolving = sending.effects[0];
  assert.equal(resolving.type, "resolve-run-workspace");
  if (resolving.type !== "resolve-run-workspace") assert.fail("expected workspace resolution");
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: resolving.pendingId,
    workspace: { id: "w", kind: "projectless", root: "/tmp" },
  });
  const queued = reduce(started.state, { type: "task.send", attachments: [{ path: "/attachments/two.png", labels: [] }] });
  assert.deepEqual(queued.state.queuedMessages["task-1"]![0].attachments, ["/attachments/two.png"]);

  const stopped = reduce(queued.state, {
    type: "run.event",
    event: { type: "run.status", taskId: "task-1", runId: started.state.lastRunIds["task-1"]!, sequence: 1, status: "cancelled" },
  });
  assert.deepEqual(stopped.state.images["task-1"]!.map((image) => image.path), ["/attachments/two.png"]);
});

test("a sent image is offered back to the composer by the path the app keeps it under", () => {
  const recalled = run(workspaceWithTasks(), [{ type: "image.recall", paths: ["/attachments/one.png", "/attachments/two.png"] }]);
  assert.deepEqual(recalled.images["task-1"]!.map((image) => image.path), ["/attachments/one.png", "/attachments/two.png"]);
  assert.deepEqual(run(recalled, [{ type: "image.recall", paths: [] }]).images, {});
});

test("a grab sounds and comes forward by default, and either choice reaches the desktop and the store", () => {
  const state = workspaceWithTasks();
  assert.deepEqual([state.captureSound, state.captureFocus], [true, true], "a grab announces itself until the user says otherwise");
  assert.deepEqual([deriveView(state).captureSound, deriveView(state).captureFocus], [true, true]);

  const quiet = reduce(state, { type: "view.set-capture-options", options: { sound: false, focus: true } });
  assert.deepEqual([quiet.state.captureSound, quiet.state.captureFocus], [false, true]);
  assert.deepEqual(quiet.effects.map((effect) => effect.type), ["persist-preferences", "apply-capture-options"]);
  const persist = quiet.effects[0];
  const apply = quiet.effects[1];
  assert.equal(persist.type, "persist-preferences");
  assert.equal(apply.type, "apply-capture-options");
  if (persist.type !== "persist-preferences" || apply.type !== "apply-capture-options") assert.fail("expected capture effects");
  assert.equal(persist.preferences.captureSound, false);
  assert.deepEqual(apply.options, { sound: false, focus: true });

  const stays = reduce(quiet.state, { type: "view.set-capture-options", options: { sound: false, focus: false } });
  assert.equal(stays.state.captureFocus, false);

  assert.deepEqual(reduce(stays.state, { type: "view.set-capture-options", options: { sound: false, focus: false } }).effects, [], "an unchanged choice writes nothing");
});

test("an image arriving asks for the caret, so the caption is typed where the shot landed", () => {
  const state = workspaceWithTasks();
  const staged = reduce(state, { type: "image.add", path: "/attachments/one.png", label: "Figma" }).state;
  assert.equal(staged.composerFocus, state.composerFocus + 1);
});
