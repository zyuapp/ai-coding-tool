import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { parseThreadStore, serializeThreadStore, THREAD_STORE_VERSION } from "../../src/domain/thread-storage.ts";
import type { ManagedWorktree } from "../../src/domain/worktree.ts";
import { activeRun, effectOf, heldWorktree, madeWorktree, projected, required, task, PROJECT } from "./workspace-reducer-fixtures.mts";

function fixture() {
  const first = { ...heldWorktree(), name: "Login redesign" };
  const second = { ...heldWorktree("wt2"), name: "Payment fix" };
  const managed: ManagedWorktree[] = [first, second].map((item) => ({ id: item.id, root: item.root, repository: PROJECT.root, branch: `feature/${item.id}`, status: { changedFiles: 2, comparison: null } }));
  return projected({
    currentId: "review",
    worktrees: [first, second],
    managedWorktrees: managed,
    openMenu: "session:location",
    threads: [task("review", { title: "Review login", projectId: PROJECT.id, worktreeId: first.id }), task("build", { title: "Build login", projectId: PROJECT.id, worktreeId: first.id }), task("archived", { projectId: PROJECT.id, worktreeId: first.id, archivedAt: 1 }), task("local", { projectId: PROJECT.id }), task("payment", { title: "Fix invoice rounding", projectId: PROJECT.id, worktreeId: second.id })],
  });
}

test("shared membership includes dismissed threads, excludes archived threads, and keeps its count during search", () => {
  const dismissed = reduce(fixture(), { type: "task.dismiss", taskId: "build" }).state;
  const initial = required(deriveView(dismissed).worktreeMenu);
  assert.equal(initial.count, 2);
  assert.deepEqual(initial.threads.map(thread => thread.id), ["review", "build"]);
  const filtered = reduce(dismissed, { type: "worktree.menu-search", list: "threads", query: "BUILD" }).state;
  const view = required(deriveView(filtered).worktreeMenu);
  assert.equal(view.count, 2);
  assert.deepEqual(view.threads.map(thread => thread.id), ["build"]);
  const archived = reduce(filtered, { type: "task.archive", taskId: "build" }).state;
  assert.equal(required(deriveView(archived).worktreeMenu).count, 1);
});

test("a worktree scan offers usable destinations while retaining missing folders for Settings cleanup", () => {
  const state = fixture();
  const missing = heldWorktree("missing");
  const unavailable = heldWorktree("unavailable");
  state.worktrees.push(missing, unavailable);
  const loaded = reduce(state, { type: "worktrees.loaded", worktrees: [...state.managedWorktrees!, { id: unavailable.id, root: unavailable.root, repository: null, branch: null, status: { changedFiles: null, comparison: null } }] }).state;
  const view = deriveView(loaded);
  assert.deepEqual(required(view.worktreeMenu).destinations.map(item => item.id), ["wt2"]);
  assert.equal(required(view.worktreeMenu).destinations[0].disabled, false);
  assert.equal(loaded.worktrees.length, 4);
  assert.equal(view.worktreeSettings.missing[0].id, "missing");
});

for (const engine of ["claude", "codex"] as const) {
  test(`${engine} moves between existing checkouts and Local without releasing either checkout`, () => {
    const state = fixture();
    state.threads[0] = { ...state.threads[0], engine, continuation: { provider: engine, value: "original-session" }, continuationStatus: "available", worktreeEnteredAt: 3 };
    const moved = reduce(state, { type: "task.move-worktree", destination: { kind: "worktree", id: "wt2" } });
    const thread = required(moved.state.threads.find((item) => item.id === "review"));
    assert.equal(thread.worktreeId, "wt2");
    assert.equal(thread.worktreeEnteredAt, undefined);
    assert.equal(thread.inheritedContinuation, true);
    assert.equal(thread.continuation?.value, "original-session");
    assert.equal(moved.state.worktrees.length, 2);
    assert.ok(moved.effects.every((effect) => effect.type !== "release-worktree" && effect.type !== "delete-worktree"));
    const local = reduce(moved.state, { type: "task.move-worktree", destination: { kind: "local" } });
    assert.equal(local.state.threads[0].worktreeId, undefined);
    assert.equal(local.state.worktrees.length, 2);
    const sending = reduce(local.state, { type: "task.send", taskId: "review", text: "Continue", attachments: [] });
    const resolution = effectOf(sending, "resolve-run-workspace");
    assert.equal(resolution.workspace?.id, PROJECT.workspaceId);
    const started = reduce(sending.state, { type: "run.resolved", pendingId: resolution.pendingId, workspace: { id: PROJECT.workspaceId!, kind: "project", root: PROJECT.root } });
    assert.equal(effectOf(started, "start-run").command.forkContinuation, true);
    assert.equal(effectOf(started, "start-run").command.engine, engine);
  });

  test(`${engine} scheduled runs fork the continuation after a checkout move`, () => {
    const state = fixture();
    state.threads[0] = { ...state.threads[0], engine, continuation: { provider: engine, value: "original-session" }, continuationStatus: "available" };
    const moved = reduce(state, { type: "task.move-worktree", destination: { kind: "worktree", id: "wt2" } });
    const fired = reduce(moved.state, { type: "automation.fired", fire: { automationId: "a", taskId: "review", runId: "r", prompt: "Check", runNumber: 1 } });
    const resolve = effectOf(fired, "resolve-run-workspace");
    const worktree = heldWorktree("wt2");
    const started = reduce(fired.state, { type: "run.resolved", pendingId: resolve.pendingId, workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root } });
    const command = effectOf(started, "start-run").command;
    assert.equal(command.workspaceId, worktree.workspaceId);
    assert.equal(command.forkContinuation, true);
  });
}

test("a new destination starts at the source checkout and moves only after creation succeeds", () => {
  const state = fixture();
  const creating = reduce(state, { type: "task.move-worktree", destination: { kind: "new" } });
  const effect = effectOf(creating, "create-worktree");
  assert.equal(effect.projectRoot, heldWorktree().root);
  assert.equal(effect.move, true);
  assert.equal(effect.name, "Review login");
  assert.equal(creating.state.threads[0].worktreeId, "wt1");
  assert.equal(required(deriveView(creating.state).worktreeMenu).location.kind, "creating");
  assert.equal(reduce(creating.state, { type: "task.send", taskId: "review", text: "Continue", attachments: [] }).effects.length, 0);
  assert.equal(reduce(creating.state, { type: "worktree.delete", root: heldWorktree().root }).effects.length, 0);
  const failed = reduce(creating.state, { type: "worktree.failed", taskId: "review", message: "No disk space" });
  assert.equal(failed.state.threads[0].worktreeId, "wt1");
  assert.deepEqual(failed.state.creatingWorktrees, []);
  const created = reduce(creating.state, { type: "worktree.created", taskId: "review", move: true, projectId: PROJECT.id, worktree: { ...madeWorktree("new"), name: effect.name } });
  assert.equal(created.state.threads[0].worktreeId, "new");
  assert.equal(created.state.worktrees.length, 3);
  assert.equal(created.state.worktrees[2].name, "Review login");
});

test("moves refuse active threads, other projects, missing folders, and destinations being removed", () => {
  const state = fixture();
  const command = { type: "task.move-worktree", destination: { kind: "worktree", id: "wt2" } } as const;
  const busy = reduce({ ...state, activeRuns: { review: activeRun("review", "run") } }, command);
  assert.equal(busy.state.threads[0].worktreeId, "wt1");
  assert.ok(busy.state.actionError);
  for (const candidate of [
    { ...state, worktrees: [state.worktrees[0], { ...state.worktrees[1], projectId: "other" }] },
    { ...state, managedWorktrees: [] },
    { ...state, deletingWorktrees: [heldWorktree("wt2").root] },
    { ...state, releasingWorktrees: ["payment"] },
  ]) {
    const result = reduce(candidate, command);
    assert.equal(result.state.threads[0].worktreeId, "wt1");
    assert.ok(result.state.actionError);
  }
});

test("creation completion keeps its original project when a Local thread changes projects", () => {
  const state = fixture();
  state.projects.push({ id: "other", root: "/other", workspaceId: "other-workspace" });
  const creating = reduce(state, { type: "task.move-worktree", taskId: "local", destination: { kind: "new" } });
  const moved = reduce(creating.state, { type: "task.move", taskId: "local", target: { projectId: "other", index: 0 } });
  const event = { type: "worktree.created", taskId: "local", move: true, projectId: PROJECT.id, worktree: madeWorktree("new") } as const;
  const created = reduce(moved.state, event);
  const thread = required(created.state.threads.find((item) => item.id === "local"));
  assert.equal(thread.projectId, "other");
  assert.equal(thread.worktreeId, undefined);
  assert.equal(created.state.worktrees[2].projectId, PROJECT.id);
  assert.deepEqual(created.state.creatingWorktrees, []);
  assert.equal(reduce(created.state, event).state.worktrees.length, 3);
});

test("a delayed file scan from the old checkout does not replace a moved thread's snapshot", () => {
  const moved = reduce(fixture(), { type: "task.move-worktree", destination: { kind: "worktree", id: "wt2" } });
  const result = { status: "available", files: ["old-file.ts"], branch: "old", baseline: null, additions: 1, deletions: 0 } as const;
  const scanned = reduce(moved.state, { type: "environment.updated", taskId: "review", workspaceId: heldWorktree().workspaceId, result: { ...result, files: [...result.files] } });
  assert.deepEqual(scanned.state.threads[0].lastChangeSnapshot.files, []);
  const current = reduce(scanned.state, { type: "environment.updated", taskId: "review", workspaceId: heldWorktree("wt2").workspaceId, result: { ...result, files: ["new-file.ts"] } });
  assert.deepEqual(current.state.threads[0].lastChangeSnapshot.files, ["new-file.ts"]);
});

test("the session card loads deletion details without opening Settings and includes archived claimants", () => {
  const state = fixture();
  state.managedWorktrees = null;
  state.worktreeSettings.project = "unrelated-filter";
  const asked = reduce(state, { type: "worktree.confirm-delete", root: heldWorktree().root });
  assert.equal(asked.state.settingsOpen, false);
  assert.equal(effectOf(asked, "list-worktrees").type, "list-worktrees");
  const loaded = reduce(asked.state, { type: "worktrees.loaded", worktrees: fixture().managedWorktrees! });
  assert.equal(required(deriveView(loaded.state).worktreeDeleteConfirmation).threads.length, 3);
  const busy = { ...loaded.state, activeRuns: { archived: activeRun("archived", "run") } };
  assert.equal(required(deriveView(busy).worktreeMenu).canDelete, false);
  assert.equal(reduce(busy, { type: "worktree.delete", root: heldWorktree().root }).effects.length, 0);
});

test("worktree display names survive storage while old records remain readable", () => {
  const state = fixture();
  delete state.worktrees[1].name;
  const parsed = parseThreadStore(serializeThreadStore({ version: THREAD_STORE_VERSION, tasks: state.threads, projects: state.projects, worktrees: state.worktrees, lastFolder: null }));
  assert.ok(parsed.ok);
  assert.equal(parsed.data.worktrees[0].name, "Login redesign");
  assert.equal(parsed.data.worktrees[1].name, undefined);
});
