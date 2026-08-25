import assert from "node:assert/strict";
import { test, describe } from "vitest";
import {
  DIFF_PANEL,
  reduce,
  type WorkspaceEffect,
  type WorkspaceInput,
} from "../../src/application/workspace-reducer.ts";
import type { ActiveRun } from "../../src/application/task-workspace.ts";
import {
  deriveView,
  diffFor,
  dockFor,
  dockOwner,
  emptyWorkspaceState,
  type DiffState,
  type WorkspaceState,
} from "../../src/application/workspace-state.ts";
import type { DiffSummaryResult } from "../../src/contracts/ipc.js";
import type { DiffFileSummary, DiffRange } from "../../src/domain/diff.js";
import type { Project, Task } from "../../src/domain/task.js";

const PROJECT: Project = { id: "project-a", root: "/repo", workspaceId: "workspace-a" };
type AvailableDiffSummary = Extract<DiffSummaryResult, { status: "available" }>;
type ReadDiffEffect = Extract<WorkspaceEffect, { type: "read-diff" }>;
type StartRunEffect = Extract<WorkspaceEffect, { type: "start-run" }>;

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...emptyWorkspaceState(), projects: [PROJECT], draftProjectId: PROJECT.id, ...overrides };
}

function run(state: WorkspaceState, inputs: WorkspaceInput[]): WorkspaceState {
  return inputs.reduce((current, input) => reduce(current, input).state, state);
}

function diff(state: WorkspaceState): DiffState {
  return diffFor(state, dockOwner(state));
}

/** A file list as the desktop answers with one. */
function summary(files: DiffFileSummary[], range: DiffRange = { kind: "uncommitted" }): AvailableDiffSummary {
  return {
    status: "available",
    range,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

function file(path: string, additions = 1, deletions = 0): DiffFileSummary {
  return { path, status: "modified", additions, deletions, binary: false };
}

function readDiffEffect(effects: WorkspaceEffect[]): ReadDiffEffect {
  const effect = effects.find((item): item is ReadDiffEffect => item.type === "read-diff");
  assert.ok(effect);
  return effect;
}

function startRunEffect(effects: WorkspaceEffect[]): StartRunEffect {
  const effect = effects.find((item): item is StartRunEffect => item.type === "start-run");
  assert.ok(effect);
  return effect;
}

function availableResult(review: DiffState): AvailableDiffSummary {
  const result = review.result;
  assert.ok(result);
  if (result.status !== "available") assert.fail(`expected an available diff, got ${result.status}`);
  return result;
}

function activeRun(taskId: string, runId: string): ActiveRun {
  return {
    taskId,
    runId,
    sequence: 0,
    status: "running",
    origin: "composer",
    quiet: false,
    notified: false,
    acknowledged: false,
    reportedIssues: [],
    messagesBefore: 0,
    before: { updatedAt: 1 },
  };
}

function thread(id: string, title: string): Task {
  return {
    id,
    title,
    projectId: PROJECT.id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
  };
}

/** Opens the review and answers the read it asks for, which is what the renderer would do. */
function reviewing(state: WorkspaceState, files: DiffFileSummary[]): WorkspaceState {
  const opened = reduce(state, { type: "diff.toggle" });
  const effect = readDiffEffect(opened.effects);
  return reduce(opened.state, {
    type: "diff.loaded",
    owner: effect.owner,
    workspaceId: effect.workspaceId,
    range: effect.range,
    result: summary(files, effect.range),
  }).state;
}

describe("Opening a review", { concurrent: true }, () => {

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
    environments: { "workspace-a": { status: "available", files: [], branch: "topic", baseline: "origin/main", additions: 3, deletions: 1 } },
  });
  const opened = reduce(counted, { type: "diff.toggle" });

  assert.deepEqual(readDiffEffect(opened.effects).range, { kind: "branches", base: "origin/main", compare: null });
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
    { type: "diff.set-split", split: false },
  ]);
  const changed = reduce(reviewed, { type: "diff.set-range", range: { kind: "branches", base: "main", compare: null } });

  assert.deepEqual(diff(changed.state).viewed, {});
  assert.deepEqual(diff(changed.state).collapsed, []);
  assert.equal(diff(changed.state).split, false, "how it is drawn is not what is being compared");
  assert.equal(changed.effects.filter((effect) => effect.type === "read-diff").length, 1);
});

test("asking for the comparison already on screen reads nothing again", () => {
  const reviewed = reviewing(workspace(), [file("a.ts")]);
  const same = reduce(reviewed, { type: "diff.set-range", range: { kind: "uncommitted" } });

  assert.deepEqual(same.effects, []);
});

});

describe("The file list a review draws", { concurrent: true }, () => {

test("a review opens side by side", () => {
  assert.equal(diff(reviewing(workspace(), [file("a.ts")])).split, true);
});

test("every file starts open, and ticking one off folds it away", () => {
  const opened = reviewing(workspace(), [file("a.ts"), file("b.ts")]);
  assert.deepEqual(diff(opened).collapsed, [], "nothing is folded until the user folds it");

  const reviewed = run(opened, [{ type: "diff.set-viewed", path: "a.ts", viewed: true }]);
  assert.deepEqual(diff(reviewed).collapsed, ["a.ts"]);
  assert.deepEqual(Object.keys(diff(reviewed).viewed), ["a.ts"]);

  const untucked = run(reviewed, [{ type: "diff.set-viewed", path: "a.ts", viewed: false }]);
  assert.deepEqual(diff(untucked).collapsed, [], "unticking opens it again");
});

test("a file folded by hand stays folded through a fresh list", () => {
  const folded = run(reviewing(workspace(), [file("a.ts"), file("b.ts")]), [
    { type: "diff.set-collapsed", path: "a.ts", collapsed: true },
  ]);
  const reread = reduce(folded, {
    type: "diff.loaded",
    owner: "draft",
    workspaceId: "workspace-a",
    range: { kind: "uncommitted" },
    result: summary([file("a.ts"), file("b.ts")]),
  });

  assert.deepEqual(diff(reread.state).collapsed, ["a.ts"]);
});

test("a ticked file that changes comes back open as well as unread", () => {
  const reviewed = run(reviewing(workspace(), [file("a.ts", 1)]), [{ type: "diff.set-viewed", path: "a.ts", viewed: true }]);
  assert.deepEqual(diff(reviewed).collapsed, ["a.ts"]);

  const rewritten = reduce(reviewed, {
    type: "diff.loaded",
    owner: "draft",
    workspaceId: "workspace-a",
    range: { kind: "uncommitted" },
    result: summary([file("a.ts", 9)]),
  });

  assert.deepEqual(diff(rewritten.state).viewed, {});
  assert.deepEqual(diff(rewritten.state).collapsed, [], "it is worth reading again, so it is open again");
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

test("a file that is gone from the list stops being folded", () => {
  const reviewed = run(reviewing(workspace(), [file("a.ts"), file("b.ts")]), [
    { type: "diff.set-collapsed", path: "a.ts", collapsed: true },
  ]);
  const rewritten = reduce(reviewed, {
    type: "diff.loaded",
    owner: "draft",
    workspaceId: "workspace-a",
    range: { kind: "uncommitted" },
    result: summary([file("b.ts")]),
  });

  assert.deepEqual(diff(rewritten.state).collapsed, []);
});

test("ticking a file the list does not have changes nothing", () => {
  const reviewed = reviewing(workspace(), [file("a.ts")]);
  const ticked = reduce(reviewed, { type: "diff.set-viewed", path: "ghost.ts", viewed: true });

  assert.deepEqual(diff(ticked.state).viewed, {});
});

});

describe("Where a review lives", { concurrent: true }, () => {

test("a run that settles reads the review the thread has open again", () => {
  const withTask = workspace({
    tasks: [thread("task-a", "a")],
    currentId: "task-a",
    draftProjectId: null,
    activeRuns: { "task-a": activeRun("task-a", "run-1") },
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
      thread("task-a", "a"),
      thread("task-b", "b"),
    ],
    currentId: "task-a",
    draftProjectId: null,
  });
  const first = run(reviewing(twoThreads, [file("a.ts")]), [{ type: "diff.set-collapsed", path: "a.ts", collapsed: true }]);
  const second = run(first, [{ type: "task.select", taskId: "task-b" }]);

  assert.deepEqual(diffFor(second, "task-a").collapsed, ["a.ts"]);
  assert.deepEqual(diffFor(second, "task-b").collapsed, []);
  assert.deepEqual(deriveView(second).diff.collapsed, [], "the view shows the thread in front");
});

test("a thread that goes for good takes its review with it", () => {
  const withTask = workspace({
    tasks: [thread("task-a", "a")],
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
  assert.ok(pendingId);
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId,
    workspace: { id: "workspace-a", kind: "project", root: "/repo" },
  });
  const taskId = startRunEffect(started.effects).command.taskId;

  assert.equal(availableResult(diffFor(started.state, taskId)).files[0].path, "a.ts");
  assert.equal(started.state.diffs.draft, undefined);
});

test("a review composed in the draft is asked for again under the thread the send creates", () => {
  const opened = reduce(workspace(), { type: "diff.toggle" });
  /** The read is still in flight: the draft's dock is handed over before any list comes back. */
  const drafted = run(opened.state, [{ type: "view.set-prompt", prompt: "Look at this" }]);
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const pendingId = Object.keys(sending.state.pendingRuns)[0];
  assert.ok(pendingId);
  const started = reduce(sending.state, {
    type: "run.resolved",
    pendingId,
    workspace: { id: "workspace-a", kind: "project", root: "/repo" },
  });
  const taskId = startRunEffect(started.effects).command.taskId;

  assert.deepEqual(started.effects.filter((effect) => effect.type === "read-diff"), [
    { type: "read-diff", owner: taskId, workspaceId: "workspace-a", range: { kind: "uncommitted" } },
  ], "the read is re-issued under the new thread");

  /** The reply the draft asked for is stale and drops; the one the thread asked for lands. */
  const stale = reduce(started.state, { type: "diff.loaded", owner: "draft", workspaceId: "workspace-a", range: { kind: "uncommitted" }, result: summary([file("ghost.ts")]) });
  assert.equal(diffFor(stale.state, taskId).loading, true);

  const landed = reduce(stale.state, { type: "diff.loaded", owner: taskId, workspaceId: "workspace-a", range: { kind: "uncommitted" }, result: summary([file("a.ts")]) });
  assert.equal(diffFor(landed.state, taskId).loading, false);
  assert.deepEqual(availableResult(diffFor(landed.state, taskId)).files.map((item) => item.path), ["a.ts"]);
});

test("a thread that moves into a worktree reviews the checkout it moved to", () => {
  const withTask = workspace({
    tasks: [thread("task-a", "a")],
    currentId: "task-a",
    draftProjectId: null,
  });
  const reviewed = reviewing(withTask, [file("a.ts")]);
  const moved = reduce(reviewed, {
    type: "worktree.created",
    taskId: "task-a",
    worktree: { id: "wt1", root: "/worktrees/wt1", workspaceId: "workspace-wt", baseCommit: "abcdef1234", createdAt: 2, lastUsedAt: 2 },
  });

  assert.deepEqual(moved.effects.filter((effect) => effect.type === "read-diff"), [
    { type: "read-diff", owner: "task-a", workspaceId: "workspace-wt", range: { kind: "uncommitted" } },
  ]);
  assert.equal(diffFor(moved.state, "task-a").workspaceId, "workspace-wt");
  assert.equal(diffFor(moved.state, "task-a").result, null, "the old checkout's list is not what this one holds");

  const landed = reduce(moved.state, { type: "diff.loaded", owner: "task-a", workspaceId: "workspace-wt", range: { kind: "uncommitted" }, result: summary([file("b.ts")]) });
  assert.deepEqual(availableResult(diffFor(landed.state, "task-a")).files.map((item) => item.path), ["b.ts"]);
});

test("a fresh draft compares its own project, not the last draft's", () => {
  const reviewed = run(reviewing(workspace(), [file("a.ts")]), [
    { type: "diff.set-range", range: { kind: "branches", base: "other-project-branch", compare: null } },
  ]);
  const fresh = reduce(reviewed, { type: "task.new" });

  assert.deepEqual(diffFor(fresh.state, "draft").range, { kind: "uncommitted" });
});

test("a checkout the app cannot name leaves the review with nothing to read", () => {
  const homeless = { ...emptyWorkspaceState() };
  const opened = reduce(homeless, { type: "diff.toggle" });

  assert.deepEqual(opened.effects.filter((effect) => effect.type === "read-diff"), []);
  assert.equal(diff(opened.state).workspaceId, null);
});

});
