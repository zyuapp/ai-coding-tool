import { effectAt, task, workspace } from "./workspace-reducer-fixtures.mts";
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import { sidebarLists } from "../../src/application/sidebar-lists.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import { stateFromData } from "../../src/application/workspace-load.ts";
import { createRemoteWorkspaceReader } from "../../src/application/remote-workspace.ts";
import { THREAD_STORE_VERSION } from "../../src/domain/thread-storage.ts";

const PROJECTLESS: WorkspaceRecord = { id: "projectless", kind: "projectless", root: "/tmp" };

afterEach(() => vi.useRealTimers());

function at(time: number) {
  vi.useFakeTimers();
  vi.setSystemTime(time);
}

function start(state: WorkspaceState, taskId: string): WorkspaceState {
  const sending = reduce(state, { type: "task.send", taskId, text: "Review it" });
  return reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS }).state;
}

function speak(state: WorkspaceState, taskId: string, sequence: number): WorkspaceState {
  const runId = state.activeRuns[taskId]!.runId;
  return reduce(state, { type: "run.event", event: { type: "assistant.delta", taskId, runId, sequence, messageId: `reply-${sequence}`, text: "Still reading." } }).state;
}

function end(state: WorkspaceState, taskId: string, sequence: number): WorkspaceState {
  const runId = state.activeRuns[taskId]!.runId;
  return reduce(state, { type: "run.event", event: { type: "run.status", taskId, runId, sequence, status: "succeeded" } }).state;
}

function threadsList(state: WorkspaceState) {
  const busy = new Set(Object.keys(state.activeRuns));
  return sidebarLists(state, [], state.threads, busy, new Set()).activityThreads.threads.map((thread) => thread.id);
}

test("a run moves its thread when it starts and when it ends, never while it speaks", () => {
  let state = workspace({ threads: [task("reviewer", { role: "reviewer", rankedAt: 10 }), task("other", { rankedAt: 20 })] });

  at(100);
  state = start(state, "reviewer");
  assert.equal(state.threads.find((thread) => thread.id === "reviewer")!.rankedAt, 100);
  assert.deepEqual(threadsList(state), ["reviewer", "other"]);

  state = { ...state, threads: state.threads.map((thread) => thread.id === "other" ? { ...thread, rankedAt: 150 } : thread) };
  at(200);
  state = speak(state, "reviewer", 1);
  at(300);
  state = speak(state, "reviewer", 2);
  assert.equal(state.threads.find((thread) => thread.id === "reviewer")!.rankedAt, 100);
  assert.deepEqual(threadsList(state), ["other", "reviewer"], "a reviewer working in Threads holds its row while it speaks");

  at(400);
  state = end(state, "reviewer", 3);
  assert.equal(state.threads.find((thread) => thread.id === "reviewer")!.rankedAt, 400);
  assert.deepEqual(threadsList(state), ["reviewer", "other"]);
});

test("a thread saved or sent before threads were ranked ranks by when it last spoke", () => {
  const { rankedAt: _unranked, ...saved } = task("old", { createdAt: 5, messages: [{ id: "m", kind: "assistant", text: "Done.", at: 40 }], runEndedAt: 41 });
  const loaded = stateFromData({ version: THREAD_STORE_VERSION, tasks: [saved], projects: [], worktrees: [], lastFolder: null });
  assert.equal(loaded.threads[0]!.rankedAt, 41);

  const read = createRemoteWorkspaceReader()({ ...workspace(), threads: [saved] });
  assert.equal(read.threads[0]!.rankedAt, 41);
});
