import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { diffFor, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
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
