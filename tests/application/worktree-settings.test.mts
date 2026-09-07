import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { activeRun, heldWorktree, projected, task, PROJECT } from "./workspace-reducer-fixtures.mts";

function fixture() {
  const present = heldWorktree();
  const missing = { ...heldWorktree("missing"), projectId: "project-b" };
  return projected({
    settingsOpen: true,
    projects: [PROJECT, { id: "project-b", root: "/other/repo", name: "repo" }],
    worktrees: [present, missing],
    threads: [task("linked", { worktreeId: present.id, projectId: PROJECT.id }), task("archived", { worktreeId: present.id, projectId: PROJECT.id, archivedAt: 5 }), task("missing-thread", { worktreeId: missing.id, projectId: missing.projectId })],
    managedWorktrees: [{ id: present.id, root: present.root, repository: PROJECT.root, branch: "feat/worktrees", status: { changedFiles: 2, comparison: { branch: "main", ahead: 3 } } }],
  });
}

test("project filtering uses identities, includes missing folders, and resets when settings closes", () => {
  const state = fixture();
  const page = deriveView(state).worktreeSettings;
  assert.equal(page.available[0].title, "feat/worktrees");
  assert.equal(page.missing[0].title, "missing-thread");
  assert.deepEqual(page.projects.map((project) => project.count), [1, 1]);
  const filtered = reduce(state, { type: "worktree.filter-project", project: "project-b" }).state;
  const selected = deriveView(filtered).worktreeSettings;
  assert.equal(selected.available.length, 0);
  assert.equal(selected.missing.length, 1);
  assert.equal(selected.missingOpen, true);
  const collapsed = reduce(filtered, { type: "worktree.set-missing-open", open: false }).state;
  assert.equal(deriveView(collapsed).worktreeSettings.missingOpen, false);
  const closed = reduce(filtered, { type: "view.set-settings-open", open: false }).state;
  assert.equal(deriveView(closed).worktreeSettings.project, null);
  assert.equal(deriveView(closed).worktreeSettings.available.length, 1);
});

test("refresh keeps the current list and filter, and a failure never turns present folders into missing ones", () => {
  const filtered = reduce(fixture(), { type: "worktree.filter-project", project: PROJECT.id }).state;
  const refreshing = reduce(filtered, { type: "worktree.refresh" });
  assert.deepEqual(refreshing.effects, [{ type: "list-worktrees" }]);
  assert.equal(deriveView(refreshing.state).worktreeSettings.available.length, 1);
  assert.equal(deriveView(refreshing.state).worktreeSettings.loading, true);
  assert.equal(reduce(refreshing.state, { type: "worktree.refresh" }).effects.length, 0);
  const failed = reduce(refreshing.state, { type: "worktrees.failed", message: "Permission denied" }).state;
  assert.equal(deriveView(failed).worktreeSettings.loading, false);
  assert.equal(deriveView(failed).worktreeSettings.project, PROJECT.id);
  assert.equal(deriveView(failed).worktreeSettings.available.length, 1);
  assert.equal(deriveView(failed).worktreeSettings.missing.length, 0);
  assert.equal(failed.worktreeManagementError, "Permission denied");
});

test("opening settings directly on worktrees requests a scan", () => {
  const opened = reduce(projected(), { type: "view.set-settings-open", open: true, section: "worktrees" });
  assert.ok(opened.effects.some((effect) => effect.type === "list-worktrees"));
  assert.equal(opened.state.worktreeManagementLoading, true);
});

test("a linked archived thread opens without restoring it or changing its checkout", () => {
  const state = fixture();
  const opened = reduce(state, { type: "worktree.open-thread", taskId: "archived" }).state;
  assert.equal(opened.settingsOpen, false);
  assert.equal(opened.currentId, "archived");
  assert.equal(opened.threads.find((thread) => thread.id === "archived")?.archivedAt, 5);
  assert.equal(opened.threads.find((thread) => thread.id === "archived")?.worktreeId, heldWorktree().id);
  assert.equal(reduce(state, { type: "worktree.open-thread", taskId: "unknown" }).state, state);
});

for (const engine of ["claude", "codex"] as const) {
  test(`${engine} runs block deletion even when they start after confirmation opens`, () => {
    const state = fixture();
    const root = heldWorktree().root;
    const asking = reduce(state, { type: "worktree.confirm-delete", root }).state;
    assert.equal(deriveView(asking).worktreeSettings.confirmation?.root, root);
    const running = { ...asking, threads: asking.threads.map((thread) => ({ ...thread, engine })), activeRuns: { linked: activeRun("linked", "running") } };
    assert.equal(deriveView(running).worktreeSettings.confirmation?.busy, true);
    assert.equal(reduce(running, { type: "worktree.delete", root }).effects.length, 0);
    assert.equal(reduce({ ...running, worktreeSettings: state.worktreeSettings }, { type: "worktree.confirm-delete", root }).state.worktreeSettings.confirming, null);
  });
}

test("forgetting a missing folder only removes its record and returns linked threads after success", () => {
  const state = fixture();
  const missing = state.worktrees[1];
  const deleting = reduce(state, { type: "worktree.delete", root: missing.root, missingOnly: true });
  assert.equal(deleting.effects[0]?.type, "delete-worktree");
  assert.equal(deleting.effects[0].missingOnly, true);
  assert.equal(deleting.state.threads[2].worktreeId, missing.id);
  const deleted = reduce(deleting.state, { type: "worktree.deleted", worktreeId: missing.id, root: missing.root, missingOnly: true, snapshot: { commit: null, shortCommit: null, ref: null } }).state;
  assert.equal(deleted.threads[2].worktreeId, undefined);
  assert.equal(deleted.threads.length, 3);
  assert.match(deleted.worktreeManagementNotice!, /Forgot.*Thread history kept/);
  assert.equal(deriveView(deleted).worktreeSettings.missing.length, 0);
});
