import assert from "node:assert/strict";
import test from "node:test";
import { deriveView, emptyWorkspaceState, withStoreData } from "../dist/main/application/workspace-state.js";

function task(id, worktreeId) {
  return {
    id,
    title: id,
    projectId: "project-1",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...(worktreeId ? { worktreeId } : {}),
  };
}

function checkout(id, root) {
  return { id, projectId: "project-1", root, workspaceId: `workspace-${id}`, baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 2 };
}

test("a load keeps only claimed session checkouts and lets stored records win duplicate ids", () => {
  const state = {
    ...emptyWorkspaceState(),
    tasks: [task("held", "live"), task("stale", "unclaimed")],
    worktrees: [checkout("stored", "/session-stored"), checkout("live", "/session-live"), checkout("unclaimed", "/session-unclaimed")],
    currentId: "held",
    activeRuns: { held: { taskId: "held", runId: "run-1", sequence: 0, status: "running" } },
  };
  const stored = checkout("stored", "/stored");
  const loaded = withStoreData(state, {
    version: 2,
    tasks: [task("from-store", "stored")],
    projects: [{ id: "project-1", root: "/project" }],
    worktrees: [stored],
    lastFolder: null,
  });

  assert.deepEqual(loaded.tasks.map((item) => item.id), ["from-store", "held"]);
  assert.deepEqual(loaded.worktrees, [stored, checkout("live", "/session-live")]);
});

test("transcript find invalidates when a thread receives a new messages array", () => {
  const first = { id: "first", kind: "assistant", text: "needle", at: 1 };
  const found = { ...task("found"), messages: [first] };
  const state = {
    ...emptyWorkspaceState(),
    tasks: [found],
    currentId: found.id,
    find: { target: { kind: "transcript" }, query: "needle", index: 0 },
  };
  assert.equal(deriveView(state).find.matches, 1);
  const second = { id: "second", kind: "user", text: "another needle", at: 2 };
  assert.equal(deriveView({ ...state, tasks: [{ ...found, messages: [first, second] }] }).find.matches, 2);
});
