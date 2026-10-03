import assert from "node:assert/strict";
import { test } from "vitest";
import { threadActivity, threadLists, threadStatus, waitingOn, type ThreadStatus } from "../../src/application/thread-activity.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { Subagent } from "../../src/domain/run.ts";
import type { Workflow } from "../../src/domain/workflow.ts";
import type { UsageLimit } from "../../src/domain/usage-limit.ts";
import { activeRun, automation, task, workspace } from "./workspace-reducer-fixtures.mts";

const session: UsageLimit = { resetsAt: 10, window: "session" };
const weekly: UsageLimit = { resetsAt: 10, window: "weekly" };
const workflow = (status: Workflow["status"]): Workflow => ({ id: "wf", name: "wf", description: "", status, phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 });
const subagent = (status: Subagent["status"]): Subagent => ({ id: "agent", description: "Review", status, startedAt: 1, activity: [] });
const queued = [{ id: "message", text: "next", prompt: "next", attachments: [] }];

/** Each condition on thread "t": the status it gives the thread, whether it is working, and whether the activity list ranks it under Running. */
const MATRIX: Array<[string, Partial<WorkspaceState>, ThreadStatus, boolean, boolean]> = [
  ["nothing going", {}, "idle", false, false],
  ["a run", { activeRuns: { t: activeRun("t", "run") } }, "working", true, true],
  ["a run awaiting approval", { activeRuns: { t: activeRun("t", "run", { status: "awaiting-approval" }) } }, "blocked", true, true],
  ["a send resolving", { pendingRuns: { p: { id: "p", runId: "run", origin: "composer", taskId: "t", text: "go", prompt: "go", attachments: [] } } }, "working", true, true],
  ["a queued message", { queuedMessages: { t: queued } }, "working", true, true],
  ["an empty queue", { queuedMessages: { t: [] } }, "idle", false, false],
  ["a checkout being made", { creatingWorktrees: ["t"] }, "working", true, true],
  ["its checkout being released", { releasingWorktrees: ["t"] }, "working", true, true],
  ["its checkout being deleted", { deletingWorktrees: ["/wt"] }, "working", true, true],
  ["a running workflow", { workflows: { t: [workflow("running")] } }, "working", true, true],
  ["a finished workflow", { workflows: { t: [workflow("completed")] } }, "idle", false, false],
  ["a working subagent", { subagents: { t: [subagent("working")] } }, "working", true, true],
  ["a stopped subagent", { subagents: { t: [subagent("stopped")] } }, "idle", false, false],
  ["background processes alone", { backgroundProcesses: { t: [{ id: "shell", kind: "shell", description: "npm run dev" }] } }, "idle", false, false],
  ["a session limit", { threads: [task("t", { worktreeId: "wt", limitPause: { ...session, pausedAt: 1 } })] }, "paused", true, true],
  ["a weekly limit", { threads: [task("t", { worktreeId: "wt", limitPause: { ...weekly, pausedAt: 1 } })] }, "paused", false, false],
  ["a weekly limit holding a message", { threads: [task("t", { worktreeId: "wt", limitPause: { ...weekly, pausedAt: 1 } })], queuedMessages: { t: queued } }, "paused", false, false],
  ["a live watch", { automations: [{ ...automation("t"), endsWhen: "the PR merges" }] }, "idle", false, true],
  ["a paused watch", { automations: [{ ...automation("t"), endsWhen: "the PR merges", paused: true }] }, "idle", false, false],
  ["a routine", { automations: [automation("t")] }, "idle", false, false],
];

test("each condition gives a thread one status, whether it is working, and whether it ranks under Running", () => {
  for (const [condition, overrides, status, working, ranked] of MATRIX) {
    const state = workspace({
      threads: [task("t", { worktreeId: "wt" })],
      worktrees: [{ id: "wt", projectId: "project", root: "/wt", workspaceId: "workspace", baseCommit: "abc", createdAt: 1, lastUsedAt: 1 }],
      ...overrides,
    });
    const activity = threadActivity(state);
    assert.equal(threadStatus(state, "t"), status, condition);
    assert.equal(activity.working.has("t"), working, condition);
    assert.equal(activity.ranked.has("t"), ranked, condition);
  }
});

test("each state is answered once, and lists outlive changes that keep threads and side chats", () => {
  const state = workspace({ threads: [task("t")], activeRuns: { t: activeRun("t", "run") } });
  assert.equal(threadActivity(state), threadActivity(state));
  const typing: WorkspaceState = { ...state, prompts: { t: "typing" } };
  assert.equal(threadLists(typing), threadLists(state));
  assert.notEqual(threadLists({ ...state, sideChats: [{ id: "t", sourceThreadId: "s", error: null }] }), threadLists(state));
});

test("lists leave out side chats and filed threads, and count a side chat's mark under its source", () => {
  const state = workspace({
    threads: [
      task("main"),
      task("chat", { outcome: "finished", outcomeUnread: true }),
      task("filed", { archivedAt: 5, outcome: "failed", outcomeUnread: true, worktreeId: "wt" }),
    ],
    sideChats: [{ id: "chat", sourceThreadId: "main", error: null }],
  });
  const lists = threadLists(state);
  assert.deepEqual(lists.visibleThreads.map((thread) => thread.id), ["main"]);
  assert.deepEqual(lists.archivedThreads.map((thread) => thread.id), ["filed"]);
  assert.deepEqual([...lists.worktreeThreadIds], ["filed"]);
  assert.deepEqual([...lists.sideChatAttention], ["main"]);
  assert.equal(lists.unreadCount, 1);
});

test("a thread waits on its checkout before it waits on its run", () => {
  const pending = { id: "p", runId: "run", origin: "composer" as const, taskId: "t", text: "go", prompt: "go", attachments: [] };
  assert.equal(waitingOn(workspace({ creatingWorktrees: ["t"], pendingRuns: { p: pending } }), "t", "t"), "worktree");
  assert.equal(waitingOn(workspace({ releasingWorktrees: ["t"], pendingRuns: { p: pending } }), "t", "t"), "worktree-release");
  assert.equal(waitingOn(workspace({ pendingRuns: { p: pending } }), "t", "t"), "run");
  assert.equal(waitingOn(workspace({ pendingRuns: { p: { ...pending, taskId: undefined, draftKey: "draft:", creatingWorktree: true } } }), undefined, "draft:"), "worktree");
  assert.equal(waitingOn(workspace(), "t", "t"), null);
});
