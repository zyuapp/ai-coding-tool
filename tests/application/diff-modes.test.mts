import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { deriveView, diffFor, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { DEFAULT_BRANCH_RANGE } from "../../src/domain/diff.ts";

function workspace(): WorkspaceState {
  return { ...emptyWorkspaceState(), projects: [{ id: "project", root: "/repo", workspaceId: "workspace" }], draftProjectId: "project", environments: { workspace: { status: "available", branch: "topic", baseline: "origin/stack-base", files: [], additions: 0, deletions: 0 } } };
}

function effect<T extends WorkspaceEffect["type"]>(transition: WorkspaceTransition, type: T): Extract<WorkspaceEffect, { type: T }> {
  const found = transition.effects.find((item) => item.type === type);
  assert.ok(found, `expected ${type}`);
  return found as Extract<WorkspaceEffect, { type: T }>;
}

const diff = (state: WorkspaceState) => diffFor(state, "draft");

test("Branch is the default and returns to the chosen comparison after reviewing uncommitted changes", () => {
  const opened = reduce(workspace(), { type: "diff.toggle" });
  assert.equal(diff(opened.state).mode, "branch");
  assert.deepEqual(effect(opened, "read-diff").range, { kind: "branches", base: "origin/stack-base", compare: null });
  const chosen = reduce(opened.state, { type: "diff.set-range", range: { kind: "branches", base: "release", compare: "topic" } });
  const uncommitted = reduce(chosen.state, { type: "diff.set-mode", mode: "uncommitted" });
  assert.deepEqual(effect(uncommitted, "read-diff").range, { kind: "uncommitted" });
  const branch = reduce(uncommitted.state, { type: "diff.set-mode", mode: "branch" });
  assert.deepEqual(effect(branch, "read-diff").range, { kind: "branches", base: "release", compare: "topic" });
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

const REVIEWED = { number: 9, title: "Read me as GitHub does", url: "https://github.com/o/r/pull/9", state: "open", base: "release", head: "a".repeat(40) } as const;

/** The checkout in front asked about its pull request, and GitHub answered with one that merges into release. */
function answered(state: WorkspaceState, review: { baseRef?: string; unpushed?: number } = { baseRef: "origin/release", unpushed: 2 }) {
  const asked = reduce(state, { type: "pull-request.read" });
  const read = effect(asked, "read-pull-request");
  return reduce(asked.state, { type: "pull-request.answered", workspaceId: read.workspaceId, branch: read.branch, read: read.read, answer: { status: "found", pullRequest: REVIEWED, review } });
}

test("Branch opens on an open pull request's base, so the review reads the way its reviewers read it", () => {
  const opened = reduce(answered(workspace()).state, { type: "diff.toggle" });
  assert.deepEqual(effect(opened, "read-diff").range, { kind: "branches", base: "origin/release", compare: null });
  const view = deriveView(opened.state).diffPullRequest;
  assert.equal(view?.pullRequest.number, 9);
  assert.equal(view?.unpushed, 2);
});

test("A pull request found under an open review moves it to that base, and a comparison the user picked stays theirs", () => {
  const opened = reduce(workspace(), { type: "diff.toggle" });
  const found = answered(opened.state);
  assert.deepEqual(effect(found, "read-diff").range, { kind: "branches", base: "origin/release", compare: null });
  assert.deepEqual(diff(found.state).range, { kind: "branches", base: "origin/release", compare: null });

  const picked = reduce(reduce(workspace(), { type: "diff.toggle" }).state, { type: "diff.set-range", range: { kind: "branches", base: "main", compare: null } });
  const kept = answered(picked.state);
  assert.equal(kept.effects.some((item) => item.type === "read-diff"), false);
  assert.deepEqual(diff(kept.state).range, { kind: "branches", base: "main", compare: null });
  assert.equal(deriveView(kept.state).diffPullRequest, null, "a review against another base is not the pull request's");
});

test("A pull request whose base the checkout has never fetched leaves the review where it was", () => {
  const opened = reduce(answered(workspace(), { unpushed: 0 }).state, { type: "diff.toggle" });
  assert.deepEqual(effect(opened, "read-diff").range, { kind: "branches", base: "origin/stack-base", compare: null });
});
