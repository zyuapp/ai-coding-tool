import { task } from "./workspace-reducer-fixtures.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { pruneDeletedThreads } from "../../src/application/thread-pruning.ts";
import { DOCK_PICKER, diffFor, dockFor, emptyWorkspaceState, withDock } from "../../src/application/workspace-state.ts";
import type { ActiveRun } from "../../src/application/thread-run-state.ts";

function activeRun(taskId: string): ActiveRun {
  return {
    taskId,
    runId: "run-active",
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

test("permanently deleted threads leave no session data behind", () => {
  const gone = "archived-a";
  const payload = "held data";
  const state = {
    ...emptyWorkspaceState(),
    threads: [task("kept"), task(gone, { archivedAt: 5 })],
    currentId: "kept",
    history: [gone, "kept"],
    historyIndex: 1,
    prompts: { [gone]: payload },
    annotations: { [gone]: [] },
    pastes: { [gone]: [{ id: "paste-1", text: payload }] },
    images: { [gone]: [{ id: "image-1", path: "/tmp/image.png", label: "Screenshot" }] },
    pendingRuns: { pending: { id: "pending", runId: "run-pending", origin: "composer" as const, taskId: gone, text: payload, prompt: payload, attachments: [] } },
    queuedMessages: { [gone]: [{ id: "queued", text: payload, prompt: payload, attachments: [] }] },
    lastRunIds: { [gone]: "run-old" },
    activeRuns: { [gone]: activeRun(gone) },
    runStatuses: { [gone]: "stopped" as const },
    approvals: { approval: { approvalId: "approval", taskId: gone, runId: "run-active", title: payload, description: payload, toolName: "Edit", input: {} } },
    streamingTails: { [gone]: { messageId: "message", text: payload } },
    backgroundProcesses: { [gone]: [{ id: "process", kind: "shell" as const, description: payload }] },
    workflows: { [gone]: [{ id: "workflow", name: payload, description: payload, status: "completed" as const, phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1 }] },
    readingPoints: { [gone]: { anchor: "message", depth: 1 } },
  };

  const cleared = reduce(state, { type: "task.clear-archive" }).state;

  assert.deepEqual(cleared.history, ["kept"]);
  assert.equal(cleared.historyIndex, 0);
  for (const record of [cleared.prompts, cleared.annotations, cleared.pastes, cleared.images, cleared.queuedMessages, cleared.lastRunIds, cleared.activeRuns, cleared.runStatuses, cleared.streamingTails, cleared.backgroundProcesses, cleared.workflows, cleared.readingPoints]) {
    assert.equal(gone in record, false);
  }
  assert.deepEqual(cleared.pendingRuns, {});
  assert.deepEqual(cleared.approvals, {});
});

test("pruning a missing task keeps unrelated keyed state intact", () => {
  const state = { ...emptyWorkspaceState(), prompts: { kept: "draft" }, readingPoints: { kept: null } };
  const pruned = pruneDeletedThreads(state, new Set(["missing"]));

  assert.equal(pruned.prompts, state.prompts);
  assert.equal(pruned.readingPoints, state.readingPoints);
});

test("a deleted thread holds no checkout, dock, review, focus, side chat or ask to browse either", () => {
  const gone = "gone";
  const base = emptyWorkspaceState();
  const state = {
    ...withDock(withDock(base, gone, { open: true }), "kept", { open: true, threadTabs: [gone], tab: gone }),
    threads: [task("kept")],
    currentId: "kept",
    creatingWorktrees: [gone],
    releasingWorktrees: [gone],
    movesAfterRun: { [gone]: { destination: { kind: "local" as const } } },
    diffs: { [gone]: diffFor(base, gone) },
    dockFocus: { owner: gone, tab: "agents", count: 1 },
    keyboardTab: gone,
    sideChats: [{ id: "chat", sourceThreadId: gone, error: null }],
    subagents: { [gone]: [] },
    browserApproval: { approvalId: "ask", url: "https://example.com", taskId: gone },
  };

  const pruned = pruneDeletedThreads(state, new Set([gone]));

  assert.deepEqual([pruned.creatingWorktrees, pruned.releasingWorktrees], [[], []]);
  for (const record of [pruned.movesAfterRun, pruned.docks, pruned.diffs, pruned.subagents]) assert.equal(gone in record, false);
  assert.deepEqual(dockFor(pruned, "kept").threadTabs, []);
  assert.equal(dockFor(pruned, "kept").tab, DOCK_PICKER, "a dock showing the thread falls back to the picker");
  assert.equal(pruned.dockFocus, null);
  assert.equal(pruned.keyboardTab, null);
  assert.deepEqual(pruned.sideChats, [], "a side chat forked from it goes with it");
  assert.equal(pruned.browserApproval, null);
});
