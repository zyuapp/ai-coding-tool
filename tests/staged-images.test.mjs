import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../dist/main/application/workspace-reducer.js";
import { deriveView, emptyWorkspaceState } from "../dist/main/application/workspace-state.js";
import { MAX_ATTACHMENTS } from "../dist/main/domain/task.js";

function task(id) {
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

function run(state, inputs) {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

function workspaceWithTasks() {
  return { ...emptyWorkspaceState(), tasks: [task("task-1"), task("task-2")], currentId: "task-1" };
}

test("a grabbed window is drafted against the thread it landed in, and removed by id", () => {
  const drafted = run(workspaceWithTasks(), [
    { type: "image.add", path: "/attachments/one.png", label: "Figma — Untitled" },
    { type: "image.add", path: "/attachments/two.png", label: "Chrome" },
  ]);
  const [first, second] = drafted.images["task-1"];
  assert.deepEqual([first.path, second.path], ["/attachments/one.png", "/attachments/two.png"]);
  assert.equal(first.label, "Figma — Untitled");
  assert.deepEqual(deriveView(drafted).images.map((image) => image.path), ["/attachments/one.png", "/attachments/two.png"]);

  const removed = run(drafted, [{ type: "image.remove", imageId: first.id }]);
  assert.deepEqual(removed.images["task-1"].map((image) => image.path), ["/attachments/two.png"]);
  assert.deepEqual(run(removed, [{ type: "image.remove", imageId: second.id }]).images, {});
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
  assert.deepEqual(run(drafted, [{ type: "image.add", path: "", label: "" }]).images["task-1"].length, 1);

  const sending = reduce(drafted, { type: "task.send", attachments: [{ path: "/attachments/one.png", labels: [] }] });
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId: sending.effects[0].pendingId,
    workspace: { id: "w", kind: "projectless", root: "/tmp" },
  });

  assert.deepEqual(started.state.tasks[0].messages.at(-1).attachments, ["/attachments/one.png"]);
  assert.deepEqual(started.state.images, {});
});

test("a composer takes no more images than a message may carry", () => {
  const filled = run(workspaceWithTasks(), Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => (
    { type: "image.add", path: `/attachments/${index}.png`, label: "Figma" }
  )));
  assert.equal(filled.images["task-1"].length, MAX_ATTACHMENTS);
  assert.match(filled.actionError, /up to 6 images/);
});

test("a grab sounds and comes forward by default, and either choice reaches the desktop and the store", () => {
  const state = workspaceWithTasks();
  assert.deepEqual([state.captureSound, state.captureFocus], [true, true], "a grab announces itself until the user says otherwise");
  assert.deepEqual([deriveView(state).captureSound, deriveView(state).captureFocus], [true, true]);

  const quiet = reduce(state, { type: "view.set-capture-options", options: { sound: false, focus: true } });
  assert.deepEqual([quiet.state.captureSound, quiet.state.captureFocus], [false, true]);
  assert.deepEqual(quiet.effects.map((effect) => effect.type), ["persist-preferences", "apply-capture-options"]);
  assert.equal(quiet.effects[0].preferences.captureSound, false);
  assert.deepEqual(quiet.effects[1].options, { sound: false, focus: true });

  const stays = reduce(quiet.state, { type: "view.set-capture-options", options: { sound: false, focus: false } });
  assert.equal(stays.state.captureFocus, false);

  assert.deepEqual(reduce(stays.state, { type: "view.set-capture-options", options: { sound: false, focus: false } }).effects, [], "an unchanged choice writes nothing");
});

test("an image arriving asks for the caret, so the caption is typed where the shot landed", () => {
  const state = workspaceWithTasks();
  const staged = reduce(state, { type: "image.add", path: "/attachments/one.png", label: "Figma" }).state;
  assert.equal(staged.composerFocus, state.composerFocus + 1);
});
