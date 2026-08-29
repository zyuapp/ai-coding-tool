import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView, emptyWorkspaceState, withStoreData, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import type { Thread } from "../../src/domain/thread.ts";
import type { Worktree } from "../../src/domain/worktree.ts";

function task(id: string, worktreeId?: string): Thread {
  return {
    id,
    title: id,
    projectId: "project-1",
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...(worktreeId ? { worktreeId } : {}),
  };
}

function checkout(id: string, root: string): Worktree {
  return { id, projectId: "project-1", root, workspaceId: `workspace-${id}`, baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 2 };
}

test("a load keeps only claimed session checkouts and lets stored records win duplicate ids", () => {
  const state: WorkspaceState = {
    ...emptyWorkspaceState(),
    threads: [task("held", "live"), task("stale", "unclaimed")],
    worktrees: [checkout("stored", "/session-stored"), checkout("live", "/session-live"), checkout("unclaimed", "/session-unclaimed")],
    currentId: "held",
    activeRuns: { held: {
      taskId: "held",
      runId: "run-1",
      sequence: 0,
      status: "running",
      origin: "composer",
      quiet: false,
      notified: false,
      acknowledged: false,
      reportedIssues: [],
      messagesBefore: 0,
      before: { updatedAt: 1 },
    } },
  };
  const stored = checkout("stored", "/stored");
  const loaded = withStoreData(state, {
    version: 2,
    tasks: [task("from-store", "stored")],
    projects: [{ id: "project-1", root: "/project" }],
    worktrees: [stored],
    lastFolder: null,
  });

  assert.deepEqual(loaded.threads.map((item) => item.id), ["from-store", "held"]);
  assert.deepEqual(loaded.worktrees, [stored, checkout("live", "/session-live")]);
});

test("transcript find invalidates when a thread receives a new messages array", () => {
  const first: ConversationMessage = { id: "first", kind: "assistant", text: "needle", at: 1 };
  const found: Thread = { ...task("found"), messages: [first] };
  const state: WorkspaceState = {
    ...emptyWorkspaceState(),
    threads: [found],
    currentId: found.id,
    find: { target: { kind: "thread", taskId: found.id }, query: "needle", index: 0, focus: 0 },
  };
  assert.equal(deriveView(state).find!.matches, 1);
  const second: ConversationMessage = { id: "second", kind: "user", text: "another needle", at: 2 };
  assert.equal(deriveView({ ...state, threads: [{ ...found, messages: [first, second] }] }).find!.matches, 2);
});

test("a worktree being deleted shows the wait, refuses a repeat, and clears on failure", () => {
  const worktree = checkout("wt1", "/worktrees/repo-wt1");
  const state: WorkspaceState = {
    ...emptyWorkspaceState(),
    threads: [task("task-a", worktree.id)],
    worktrees: [worktree],
    managedWorktrees: [{ id: worktree.id, root: worktree.root, repository: "/repo", branch: null }],
  };

  const deleting = reduce(state, { type: "worktree.delete", root: worktree.root });
  assert.deepEqual(deleting.state.deletingWorktrees, [worktree.root]);
  assert.equal(deriveView(deleting.state).managedWorktrees?.[0]?.deleting, true);
  assert.deepEqual(reduce(deleting.state, { type: "worktree.delete", root: worktree.root }).effects, []);

  const failed = reduce(deleting.state, { type: "worktrees.failed", root: worktree.root, message: "Git said no." });
  assert.deepEqual(failed.state.deletingWorktrees, []);
  assert.equal(failed.state.worktreeManagementError, "Git said no.");
  assert.deepEqual(failed.state.managedWorktrees?.map((item) => item.root), [worktree.root]);
});
