import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { pruneDeletedThreads } from "../../src/application/thread-pruning.ts";
import { emptyWorkspaceState } from "../../src/application/workspace-state.ts";
import type { ActiveRun } from "../../src/application/thread-run-state.ts";
import type { Thread } from "../../src/domain/thread.ts";

function task(id: string, archived = false): Thread {
  return {
    id,
    title: id,
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...(archived ? { archivedAt: 5 } : {}),
  };
}

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
    threads: [task("kept"), task(gone, true)],
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
