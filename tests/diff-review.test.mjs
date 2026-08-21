import assert from "node:assert/strict";
import test from "node:test";
import { DIFF_PANEL, reduce } from "../dist/main/application/workspace-reducer.js";
import { deriveView, diffFor, dockFor, dockOwner, emptyWorkspaceState } from "../dist/main/application/workspace-state.js";

const PROJECT = { id: "project-a", root: "/repo", workspaceId: "workspace-a" };

function workspace(overrides = {}) {
  return { ...emptyWorkspaceState(), projects: [PROJECT], draftProjectId: PROJECT.id, ...overrides };
}

function run(state, inputs) {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

function diff(state) {
  return diffFor(state, dockOwner(state));
}

/** A file list as the desktop answers with one. */
function summary(files, range = { kind: "uncommitted" }) {
  return {
    status: "available",
    range,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

function file(path, additions = 1, deletions = 0) {
  return { path, status: "modified", additions, deletions, binary: false };
}

/** Opens the review and answers the read it asks for, which is what the renderer would do. */
function reviewing(state, files) {
  const opened = reduce(state, { type: "diff.toggle" });
  const [effect] = opened.effects.filter((item) => item.type === "read-diff");
  return reduce(opened.state, {
    type: "diff.loaded",
    owner: effect.owner,
    workspaceId: effect.workspaceId,
    range: effect.range,
    result: summary(files, effect.range),
  }).state;
}

test.describe("Diff review", { concurrency: true }, () => {

test("opening the review asks for the comparison it is going to draw", () => {
  const opened = reduce(workspace(), { type: "diff.toggle" });

  assert.deepEqual(opened.effects.filter((effect) => effect.type === "read-diff"), [
    { type: "read-diff", owner: "draft", workspaceId: "workspace-a", range: { kind: "uncommitted" } },
  ]);
  assert.equal(dockFor(opened.state, "draft").tab, DIFF_PANEL);
  assert.equal(diff(opened.state).loading, true);
});

test("the review opens on the comparison the session panel is already counting from", () => {
  const counted = workspace({
    environment: { workspaceId: "workspace-a", result: { status: "available", files: [], branch: "topic", baseline: "origin/main", additions: 3, deletions: 1 } },
  });
  const opened = reduce(counted, { type: "diff.toggle" });

  assert.deepEqual(opened.effects.find((effect) => effect.type === "read-diff").range, { kind: "branches", base: "origin/main", compare: null });
});

test("the same click closes the review it opened", () => {
  const opened = reviewing(workspace(), [file("a.ts")]);
  const closed = reduce(opened, { type: "diff.toggle" });

  assert.equal(dockFor(closed.state, "draft").panels.includes(DIFF_PANEL), false);
});

test("a list that no longer answers what the dock asked is dropped", () => {
  const opened = reduce(workspace(), { type: "diff.toggle" }).state;
  const stale = reduce(opened, {
    type: "diff.loaded",
    owner: "draft",
    workspaceId: "workspace-a",
    range: { kind: "branches", base: "main", compare: null },
    result: summary([file("stale.ts")]),
  });

  assert.equal(diff(stale.state).result, null);
  assert.equal(diff(stale.state).loading, true, "the read it is still waiting for has not landed");
});

test("changing the comparison starts a fresh read and keeps nothing but the layout", () => {
  const reviewed = run(reviewing(workspace(), [file("a.ts")]), [
    { type: "diff.set-viewed", path: "a.ts", viewed: true },
    { type: "diff.select-file", path: "a.ts" },
    { type: "diff.set-wrap", wrap: true },
  ]);
  const changed = reduce(reviewed, { type: "diff.set-range", range: { kind: "branches", base: "main", compare: null } });

  assert.deepEqual(diff(changed.state).viewed, {});
  assert.equal(diff(changed.state).file, null);
  assert.equal(diff(changed.state).wrap, true, "how it is drawn is not what is being compared");
  assert.equal(changed.effects.filter((effect) => effect.type === "read-diff").length, 1);
});

test("asking for the comparison already on screen reads nothing again", () => {
  const reviewed = reviewing(workspace(), [file("a.ts")]);
  const same = reduce(reviewed, { type: "diff.set-range", range: { kind: "uncommitted" } });

  assert.deepEqual(same.effects, []);
});

test("ticking the open file off closes it, so the list is worked down by one click", () => {
  const reviewed = run(reviewing(workspace(), [file("a.ts"), file("b.ts")]), [
    { type: "diff.select-file", path: "a.ts" },
    { type: "diff.set-viewed", path: "a.ts", viewed: true },
  ]);

  assert.equal(diff(reviewed).file, null);
  assert.deepEqual(Object.keys(diff(reviewed).viewed), ["a.ts"]);
});

test("a file that changes again comes back unread", () => {
  const reviewed = run(reviewing(workspace(), [file("a.ts", 1), file("b.ts", 1)]), [
    { type: "diff.set-viewed", path: "a.ts", viewed: true },
    { type: "diff.set-viewed", path: "b.ts", viewed: true },
  ]);
  const rewritten = reduce(reviewed, {
    type: "diff.loaded",
    owner: "draft",
    workspaceId: "workspace-a",
    range: { kind: "uncommitted" },
    result: summary([file("a.ts", 4), file("b.ts", 1)]),
  });

  assert.deepEqual(Object.keys(diff(rewritten.state).viewed), ["b.ts"], "only the file that moved is unticked");
});

test("a file that is gone from the list stops being the open one", () => {
  const reviewed = run(reviewing(workspace(), [file("a.ts"), file("b.ts")]), [{ type: "diff.select-file", path: "a.ts" }]);
  const rewritten = reduce(reviewed, {
    type: "diff.loaded",
    owner: "draft",
    workspaceId: "workspace-a",
    range: { kind: "uncommitted" },
    result: summary([file("b.ts")]),
  });

  assert.equal(diff(rewritten.state).file, null);
});

test("ticking a file the list does not have changes nothing", () => {
  const reviewed = reviewing(workspace(), [file("a.ts")]);
  const ticked = reduce(reviewed, { type: "diff.set-viewed", path: "ghost.ts", viewed: true });

  assert.deepEqual(diff(ticked.state).viewed, {});
});

test("a run that settles reads the review the thread has open again", () => {
  const withTask = workspace({
    tasks: [{ id: "task-a", title: "a", projectId: PROJECT.id, executionPolicy: "confirm", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 }],
    currentId: "task-a",
    draftProjectId: null,
    activeRuns: { "task-a": { runId: "run-1", status: "running", sequence: 0 } },
    lastRunIds: { "task-a": "run-1" },
  });
  const reviewed = reviewing(withTask, [file("a.ts")]);
  const settled = reduce(reviewed, {
    type: "run.event",
    event: { type: "run.status", status: "succeeded", taskId: "task-a", runId: "run-1", sequence: 1 },
  });

  assert.deepEqual(settled.effects.filter((effect) => effect.type === "read-diff"), [
    { type: "read-diff", owner: "task-a", workspaceId: "workspace-a", range: { kind: "uncommitted" } },
  ]);
});

test("a review belongs to its thread, so each keeps its own place", () => {
  const twoThreads = workspace({
    tasks: [
      { id: "task-a", title: "a", projectId: PROJECT.id, executionPolicy: "confirm", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 },
      { id: "task-b", title: "b", projectId: PROJECT.id, executionPolicy: "confirm", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 },
    ],
    currentId: "task-a",
    draftProjectId: null,
  });
  const first = run(reviewing(twoThreads, [file("a.ts")]), [{ type: "diff.select-file", path: "a.ts" }]);
  const second = run(first, [{ type: "task.select", taskId: "task-b" }]);

  assert.equal(diffFor(second, "task-a").file, "a.ts");
  assert.equal(diffFor(second, "task-b").file, null);
  assert.equal(deriveView(second).diff.file, null, "the view shows the thread in front");
});

test("a thread that goes for good takes its review with it", () => {
  const withTask = workspace({
    tasks: [{ id: "task-a", title: "a", projectId: PROJECT.id, executionPolicy: "confirm", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 }],
    currentId: "task-a",
    draftProjectId: null,
  });
  const reviewed = reviewing(withTask, [file("a.ts")]);
  const archived = run(reviewed, [{ type: "task.archive", taskId: "task-a" }, { type: "task.clear-archive" }]);

  assert.deepEqual(archived.diffs, {});
});

test("the review a draft was composing follows the thread that send creates", () => {
  const reviewed = reviewing(workspace(), [file("a.ts")]);
  const drafted = run(reviewed, [{ type: "view.set-prompt", prompt: "Look at this" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const pendingId = Object.keys(sending.state.pendingRuns)[0];
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId,
    workspace: { id: "workspace-a", kind: "project", root: "/repo" },
  });
  const taskId = started.effects.find((effect) => effect.type === "start-run").command.taskId;

  assert.equal(diffFor(started.state, taskId).result.files[0].path, "a.ts");
  assert.equal(started.state.diffs.draft, undefined);
});

test("a checkout the app cannot name leaves the review with nothing to read", () => {
  const homeless = { ...emptyWorkspaceState() };
  const opened = reduce(homeless, { type: "diff.toggle" });

  assert.deepEqual(opened.effects.filter((effect) => effect.type === "read-diff"), []);
  assert.equal(diff(opened.state).workspaceId, null);
});

});
