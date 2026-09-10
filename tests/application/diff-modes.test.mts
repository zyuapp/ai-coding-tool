import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { diffFor, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { DEFAULT_BRANCH_RANGE } from "../../src/domain/diff.ts";
import { COMMIT_PAGE_SIZE, type CommitHistoryResult, type CommitSummary } from "../../src/domain/commit-history.ts";
import { DIFF_COMMITS_MENU } from "../../src/application/workspace-diff.ts";
import { readDiffFrom } from "../../src/application/workspace-reducer/shared.ts";

function workspace(): WorkspaceState {
  return { ...emptyWorkspaceState(), projects: [{ id: "project", root: "/repo", workspaceId: "workspace" }], draftProjectId: "project", environments: { workspace: { status: "available", branch: "topic", baseline: "origin/stack-base", files: [], additions: 0, deletions: 0 } } };
}

function effect<T extends WorkspaceEffect["type"]>(transition: WorkspaceTransition, type: T): Extract<WorkspaceEffect, { type: T }> {
  const found = transition.effects.find((item) => item.type === type);
  assert.ok(found, `expected ${type}`);
  return found as Extract<WorkspaceEffect, { type: T }>;
}

const commit = (number: number): CommitSummary => ({ sha: number.toString(16).padStart(40, "0"), subject: `Change ${number}`, author: "Agent", committedAt: "2026-09-09T20:00:00Z" });
const page = (commits: CommitSummary[], offset = 0, hasMore = false): CommitHistoryResult => ({ status: "available", commits, offset, hasMore, head: commit(500).sha });
function answer(transition: WorkspaceTransition, result: CommitHistoryResult, state = transition.state) {
  const read = effect(transition, "read-commits");
  return reduce(state, { type: "diff.commits-loaded", owner: read.owner, workspaceId: read.workspaceId, requestId: read.requestId, result });
}
const diff = (state: WorkspaceState) => diffFor(state, "draft");

test("Branch is the default and returns to the chosen comparison after other modes", () => {
  const opened = reduce(workspace(), { type: "diff.toggle" });
  assert.equal(diff(opened.state).mode, "branch");
  assert.deepEqual(effect(opened, "read-diff").range, { kind: "branches", base: "origin/stack-base", compare: null });
  const chosen = reduce(opened.state, { type: "diff.set-range", range: { kind: "branches", base: "release", compare: "topic" } });
  const uncommitted = reduce(chosen.state, { type: "diff.set-mode", mode: "uncommitted" });
  assert.deepEqual(effect(uncommitted, "read-diff").range, { kind: "uncommitted" });
  const selecting = reduce(uncommitted.state, { type: "diff.set-mode", mode: "commits" });
  assert.equal(diff(selecting.state).mode, "commits");
  assert.equal(selecting.state.openMenu, DIFF_COMMITS_MENU);
  const listed = answer(selecting, page([commit(2), commit(1)]));
  assert.deepEqual(effect(listed, "read-diff").range, { kind: "commit", commit: commit(2).sha });
  const picked = reduce(listed.state, { type: "diff.select-commit", commit: commit(1).sha });
  assert.deepEqual(effect(picked, "read-diff").range, { kind: "commit", commit: commit(1).sha });
  assert.equal(diff(picked.state).commitSummary?.subject, "Change 1");
  assert.equal(picked.state.openMenu, null);
  const branch = reduce(picked.state, { type: "diff.set-mode", mode: "branch" });
  assert.deepEqual(effect(branch, "read-diff").range, { kind: "branches", base: "release", compare: "topic" });
  assert.equal(diff(branch.state).history, undefined, "switching modes releases the history page");
  const returned = reduce(branch.state, { type: "diff.set-mode", mode: "commits" });
  assert.deepEqual(effect(returned, "read-diff").range, { kind: "commit", commit: commit(1).sha });
});

test("Branch remains the default without an origin, and an explicit mode survives reopening", () => {
  const state = { ...workspace(), environments: {} };
  const opened = reduce(state, { type: "diff.toggle" });
  assert.equal(diff(opened.state).mode, "branch");
  assert.deepEqual(effect(opened, "read-diff").range, DEFAULT_BRANCH_RANGE);
  const chosen = reduce(opened.state, { type: "diff.set-mode", mode: "uncommitted" });
  const closed = reduce(chosen.state, { type: "diff.toggle" });
  const reopened = reduce(closed.state, { type: "diff.toggle" });
  assert.equal(diff(reopened.state).mode, "uncommitted");
  assert.deepEqual(effect(reopened, "read-diff").range, { kind: "uncommitted" });
});

test("late diff and commit queries cannot restore an abandoned selection", () => {
  const opened = reduce(workspace(), { type: "diff.toggle" });
  const selecting = reduce(opened.state, { type: "diff.set-mode", mode: "commits" });
  const old = effect(opened, "read-diff");
  const staleDiff = reduce(selecting.state, { type: "diff.loaded", owner: old.owner, workspaceId: old.workspaceId, range: old.range, result: { status: "available", range: old.range, ignoreWhitespace: true, files: [], additions: 0, deletions: 0 } });
  assert.equal(diff(staleDiff.state).result, null);
  const first = reduce(selecting.state, { type: "diff.search-commits", query: "first" });
  const second = reduce(first.state, { type: "diff.search-commits", query: "second" });
  const latest = answer(second, page([commit(9)]));
  assert.equal(answer(first, page([commit(4)]), latest.state).state, latest.state);
  assert.equal(answer(selecting, page([commit(12)]), latest.state).state, latest.state);
  const switched = reduce(latest.state, { type: "diff.set-mode", mode: "uncommitted" });
  assert.equal(answer(second, page([commit(9)]), switched.state).state, switched.state);
});

test("paging replaces one bounded page and does not change the selected commit", () => {
  const selecting = reduce(reduce(workspace(), { type: "diff.toggle" }).state, { type: "diff.set-mode", mode: "commits" });
  const listed = answer(selecting, page(Array.from({ length: COMMIT_PAGE_SIZE }, (_, index) => commit(200 - index)), 0, true));
  const paging = reduce(listed.state, { type: "diff.page-commits", direction: 1 });
  assert.deepEqual(effect(paging, "read-commits").request, { query: "", offset: 100, head: commit(500).sha });
  const older = answer(paging, page(Array.from({ length: COMMIT_PAGE_SIZE }, (_, index) => commit(100 - index)), 100));
  assert.equal(older.effects.length, 0);
  assert.deepEqual(diff(older.state).range, { kind: "commit", commit: commit(200).sha });
  assert.equal(diff(older.state).history?.result?.status, "available");
  const result = diff(older.state).history?.result;
  assert.ok(result?.status === "available");
  assert.equal(result.commits.length, COMMIT_PAGE_SIZE);
  assert.equal(result.commits[0].sha, commit(100).sha);
  assert.deepEqual(reduce(older.state, { type: "diff.page-commits", direction: 1 }).effects, []);
  const newer = reduce(older.state, { type: "diff.page-commits", direction: -1 });
  assert.equal(effect(newer, "read-commits").request.offset, 0);
});

test("empty and failed histories can be retried without reading the old branch comparison", () => {
  const selecting = reduce(reduce(workspace(), { type: "diff.toggle" }).state, { type: "diff.set-mode", mode: "commits" });
  const empty = answer(selecting, { status: "available", commits: [], head: null, offset: 0, hasMore: false });
  assert.equal(diff(empty.state).mode, "commits");
  assert.equal(empty.effects.length, 0);
  const retry = reduce(empty.state, { type: "diff.refresh" });
  assert.equal(effect(retry, "read-commits").request.offset, 0);
  const failed = answer(retry, { status: "error", message: "Git unavailable" });
  assert.equal(diff(failed.state).history?.loading, false);
  assert.deepEqual(diff(failed.state).history?.result, { status: "error", message: "Git unavailable" });
  const searched = reduce(failed.state, { type: "diff.search-commits", query: "fix" });
  assert.equal(effect(searched, "read-commits").request.query, "fix");
  assert.equal(effect(searched, "read-commits").debounce, true);
});

test("moving a checkout while its first commit is loading reads the new history", () => {
  const selecting = reduce(reduce(workspace(), { type: "diff.toggle" }).state, { type: "diff.set-mode", mode: "commits" });
  const moved = readDiffFrom(selecting.state, "draft", "new-workspace", diff(selecting.state).range);
  assert.equal(effect(moved, "read-commits").workspaceId, "new-workspace");
  assert.equal(diff(moved.state).history?.workspaceId, "new-workspace");
  assert.equal(answer(selecting, page([commit(1)]), moved.state).state, moved.state);
  const landed = answer(moved, page([commit(2)]));
  assert.equal(effect(landed, "read-diff").workspaceId, "new-workspace");
  assert.deepEqual(effect(landed, "read-diff").range, { kind: "commit", commit: commit(2).sha });
});
