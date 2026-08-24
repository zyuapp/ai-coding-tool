import assert from "node:assert/strict";
import { test } from "vitest";
import { fileTitle, promptWithFiles } from "../src/application/files.ts";
import { reduce, type WorkspaceInput } from "../src/application/workspace-reducer.ts";
import { deriveView, emptyWorkspaceState, type WorkspaceState } from "../src/application/workspace-state.ts";
import { MAX_ATTACHED_FILES, type Task } from "../src/domain/task.ts";

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

/** Sends the current draft and takes the run all the way to the message it writes. */
function sent(state: WorkspaceState) {
  const sending = reduce(state, { type: "task.send" });
  const resolving = sending.effects[0];
  assert.equal(resolving.type, "resolve-run-workspace");
  if (resolving.type !== "resolve-run-workspace") assert.fail("expected workspace resolution");
  return reduce(sending.state, {
    type: "run.resolved",
    pendingId: resolving.pendingId,
    workspace: { id: "w", kind: "projectless", root: "/tmp" },
  });
}

test("the prompt names attached files by where they are, and says which are folders", () => {
  const prompt = promptWithFiles("Read this", [
    { id: "a", path: "/Users/me/notes.md", name: "notes.md" },
    { id: "b", path: "/Users/me/shots", name: "shots", folder: true },
  ]);
  assert.match(prompt, /Read this/);
  assert.match(prompt, /\/Users\/me\/notes\.md$/m);
  assert.match(prompt, /\/Users\/me\/shots \(folder\)/);
  assert.equal(promptWithFiles("Read this", []), "Read this", "nothing attached says nothing");
});

test("a drop with nothing typed names the thread after what was dropped", () => {
  assert.equal(fileTitle([{ id: "a", path: "/tmp/report.pdf", name: "report.pdf" }]), "report.pdf");
  assert.equal(fileTitle([
    { id: "a", path: "/tmp/one.pdf", name: "one.pdf" },
    { id: "b", path: "/tmp/two.pdf", name: "two.pdf" },
  ]), "2 files");
  assert.equal(fileTitle([]), "");
});

test("files are drafted against the thread they landed in, and removed by id", () => {
  const drafted = run(workspaceWithTasks(), [
    { type: "file.attach", files: [{ path: "/tmp/one.md", name: "one.md" }, { path: "/tmp/pics", name: "pics", folder: true }] },
  ]);
  const [first, second] = drafted.files["task-1"]!;
  assert.deepEqual([first.path, second.path], ["/tmp/one.md", "/tmp/pics"]);
  assert.equal(second.folder, true);
  assert.deepEqual(deriveView(drafted).files.map((file) => file.name), ["one.md", "pics"]);

  const removed = run(drafted, [{ type: "file.detach", fileId: first.id }]);
  assert.deepEqual(removed.files["task-1"]!.map((file) => file.name), ["pics"]);
  assert.deepEqual(run(removed, [{ type: "file.detach", fileId: second.id }]).files, {});
});

test("the same file dropped twice stays one file, and a nameless path is ignored", () => {
  const twice = run(workspaceWithTasks(), [
    { type: "file.attach", files: [{ path: "/tmp/one.md", name: "one.md" }] },
    { type: "file.attach", files: [{ path: "/tmp/one.md", name: "one.md" }, { path: "/tmp/one.md", name: "one.md" }] },
    { type: "file.attach", files: [{ path: "", name: "" }] },
  ]);
  assert.equal(twice.files["task-1"]!.length, 1);
});

test("a composer takes no more files than a message may name", () => {
  const filled = run(workspaceWithTasks(), [{
    type: "file.attach",
    files: Array.from({ length: MAX_ATTACHED_FILES + 1 }, (_, index) => ({ path: `/tmp/${index}.md`, name: `${index}.md` })),
  }]);
  assert.equal(filled.files["task-1"]!.length, MAX_ATTACHED_FILES);
  assert.match(filled.actionError ?? "", /up to 10 files/);
});

test("a file stays with its own thread while the user reads another", () => {
  const drafted = run(workspaceWithTasks(), [{ type: "file.attach", files: [{ path: "/tmp/one.md", name: "one.md" }] }]);
  const elsewhere = run(drafted, [{ type: "task.select", taskId: "task-2" }]);
  assert.deepEqual(deriveView(elsewhere).files, [], "the other thread's composer is its own");
  assert.deepEqual(deriveView(run(elsewhere, [{ type: "task.select", taskId: "task-1" }])).files.map((file) => file.name), ["one.md"]);
});

test("a file arriving asks for the caret, so the question is typed where it landed", () => {
  const state = workspaceWithTasks();
  const attached = reduce(state, { type: "file.attach", files: [{ path: "/tmp/one.md", name: "one.md" }] }).state;
  assert.equal(attached.composerFocus, state.composerFocus + 1);
});

test("a send carries the files, clears them, and keeps them on the message", () => {
  const drafted = run(workspaceWithTasks(), [
    { type: "view.set-prompt", prompt: "What is wrong here?" },
    { type: "file.attach", files: [{ path: "/tmp/one.md", name: "one.md" }] },
  ]);
  const started = sent(drafted);
  const message = started.state.tasks[0].messages.at(-1)!;
  assert.deepEqual(message.files!.map((file) => file.path), ["/tmp/one.md"]);
  assert.deepEqual(started.state.files, {}, "the composer is empty again");
  const run_ = started.effects.find((effect) => effect.type === "start-run");
  assert.ok(run_ && run_.type === "start-run");
  assert.match(run_.command.prompt, /What is wrong here\?/);
  assert.match(run_.command.prompt, /\/tmp\/one\.md/);
});

test("a drop alone is worth sending, and titles the thread it starts", () => {
  const drafted = run({ ...emptyWorkspaceState() }, [{ type: "file.attach", files: [{ path: "/tmp/report.pdf", name: "report.pdf" }] }]);
  const started = sent(drafted);
  assert.equal(started.state.tasks[0].title, "report.pdf");
  assert.deepEqual(started.state.tasks[0].messages.at(-1)!.files!.map((file) => file.name), ["report.pdf"]);
});

test("files queued behind a run come back to the composer when the run is stopped", () => {
  const running = run(workspaceWithTasks(), [
    { type: "view.set-prompt", prompt: "first" },
    { type: "file.attach", files: [{ path: "/tmp/one.md", name: "one.md" }] },
  ]);
  const started = sent(running);
  const queued = run(started.state, [
    { type: "view.set-prompt", prompt: "second" },
    { type: "file.attach", files: [{ path: "/tmp/two.md", name: "two.md" }] },
    { type: "task.send" },
  ]);
  assert.deepEqual(queued.queuedMessages["task-1"]![0].files!.map((file) => file.name), ["two.md"]);
  assert.deepEqual(queued.files, {}, "a queued message takes the draft with it");

  const stopped = run(queued, [{
    type: "run.event",
    event: { type: "run.status", taskId: "task-1", runId: started.state.lastRunIds["task-1"]!, sequence: 1, status: "cancelled" },
  }]);
  assert.deepEqual(stopped.files["task-1"]!.map((file) => file.name), ["two.md"], "a stopped run hands the draft back");
});
