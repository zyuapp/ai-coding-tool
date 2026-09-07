import assert from "node:assert/strict";
import { test } from "vitest";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { activeRun, automation, task, workspace } from "./workspace-reducer-fixtures.mts";

function populated(): WorkspaceState {
  return workspace({
    threads: [task("current", { worktreeId: "wt" }), task("archived", { archivedAt: 10 })],
    currentId: "current",
    activeRuns: { current: activeRun("current", "run") },
    projects: [{ id: "project", root: "/repo" }],
    worktrees: [{ id: "wt", projectId: "project", root: "/wt", workspaceId: "workspace", baseCommit: "abc", createdAt: 1, lastUsedAt: 1 }],
    managedWorktrees: [{ id: "wt", root: "/wt", repository: "/repo", branch: "feature", status: { changedFiles: null, comparison: null } }],
    automations: [automation("current")],
  });
}

test("composer and streaming updates reuse workspace lists, counts, and worktree projections", () => {
  const state = populated();
  const before = deriveView(state);
  const typing = deriveView({ ...state, prompts: { current: "typing" } });
  const streaming = deriveView({
    ...state,
    activeRuns: { current: { ...state.activeRuns.current, sequence: 1 } },
    streamingTails: { current: { messageId: "message", text: "stream" } },
  });
  for (const view of [typing, streaming]) {
    assert.equal(view.orderedThreads, before.orderedThreads);
    assert.equal(view.archivedThreads, before.archivedThreads);
    assert.equal(view.activityThreads, before.activityThreads);
    assert.equal(view.threadsByProject, before.threadsByProject);
    assert.equal(view.runningThreadIds, before.runningThreadIds);
    assert.equal(view.blockedThreadIds, before.blockedThreadIds);
    assert.equal(view.worktreeGroups, before.worktreeGroups);
    assert.equal(view.managedWorktrees, before.managedWorktrees);
    assert.equal(view.worktreeSettings, before.worktreeSettings);
    assert.equal(view.schedules, before.schedules);
    assert.equal(view.sideChatAttention, before.sideChatAttention);
  }
  assert.equal(typing.prompt, "typing");
  assert.equal(streaming.streamingTail?.text, "stream");
});

test("run approval and checkout deletion invalidate the sidebar's busy and blocked lists", () => {
  const state = populated();
  const before = deriveView(state);
  const approval = deriveView({ ...state, activeRuns: { current: { ...state.activeRuns.current, status: "awaiting-approval" } } });
  assert.notEqual(approval.activityThreads, before.activityThreads);
  assert.deepEqual([...approval.blockedThreadIds], ["current"]);
  assert.deepEqual(approval.activityThreads.priority.map((thread) => thread.id), ["current"]);
  const idle = { ...state, activeRuns: {} };
  const idleView = deriveView(idle);
  const deleting = deriveView({ ...idle, deletingWorktrees: ["/wt"] });
  assert.deepEqual([...idleView.runningThreadIds], []);
  assert.deepEqual([...deleting.runningThreadIds], ["current"]);
  assert.equal(deleting.managedWorktrees?.[0].deleting, true);
});

test("new messages, archival, and side chat membership refresh the corresponding collections", () => {
  const state = populated();
  const before = deriveView(state);
  const archived = deriveView({ ...state, threads: [{ ...state.threads[0], archivedAt: 20 }, state.threads[1]] });
  assert.deepEqual(archived.archivedThreads.map((thread) => thread.id), ["current", "archived"]);
  assert.deepEqual(archived.orderedThreads, []);
  const withMessage = { ...state.threads[0], messages: [{ id: "new", kind: "assistant" as const, text: "new", at: 100 }] };
  const changed = deriveView({ ...state, threads: [withMessage, state.threads[1]] });
  assert.equal(changed.orderedThreads[0], withMessage);
  assert.notEqual(changed.worktreeGroups, before.worktreeGroups);
  const side = deriveView({ ...state, sideChats: [{ id: "current", sourceThreadId: "archived", error: null }] });
  assert.deepEqual(side.threads.map((thread) => thread.id), ["archived"]);
  assert.deepEqual([...side.worktreeThreadIds], []);
});

test("project names, schedules, and worktree settings update independently of thread collections", () => {
  const state = populated();
  const before = deriveView(state);
  const renamed = deriveView({ ...state, projects: [{ ...state.projects[0], name: "Renamed" }] });
  assert.equal(renamed.managedWorktrees?.[0].project, "Renamed");
  assert.equal(renamed.worktreeSettings.projects[0].name, "Renamed");
  const paused = deriveView({ ...state, automations: [{ ...state.automations[0], paused: true }] });
  assert.equal(paused.schedules.get("current")?.paused, true);
  const settings = deriveView({ ...state, worktreeSettings: { ...state.worktreeSettings, expandedThreads: ["wt"] } });
  assert.deepEqual(settings.worktreeSettings.expandedThreads, ["wt"]);
  assert.equal(settings.threads, before.threads);
});
