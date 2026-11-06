import { mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar } from "../support/sidebar.mts";
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

afterEach(() => vi.restoreAllMocks());

function at(time: number) {
  vi.spyOn(Date, "now").mockReturnValue(time);
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

function lists(state: WorkspaceState) {
  const busy = new Set(Object.keys(state.activeRuns));
  const { activityThreads, recentThreads } = sidebarLists(state, [], state.threads, busy, new Set());
  return { threads: activityThreads.threads.map((thread) => thread.id), recents: recentThreads.map((thread) => thread.id) };
}

test("a run moves its thread when it starts and when it ends, never while it speaks", () => {
  let state = workspace({ threads: [task("reviewer", { role: "reviewer", rankedAt: 10 }), task("other", { rankedAt: 20 })] });

  at(100);
  state = start(state, "reviewer");
  assert.equal(state.threads.find((thread) => thread.id === "reviewer")!.rankedAt, 100);
  assert.deepEqual(lists(state), { threads: ["reviewer", "other"], recents: ["reviewer", "other"] });

  state = { ...state, threads: state.threads.map((thread) => thread.id === "other" ? { ...thread, rankedAt: 150 } : thread) };
  at(200);
  state = speak(state, "reviewer", 1);
  at(300);
  state = speak(state, "reviewer", 2);
  assert.equal(state.threads.find((thread) => thread.id === "reviewer")!.rankedAt, 100);
  assert.deepEqual(lists(state), { threads: ["other", "reviewer"], recents: ["other", "reviewer"] }, "a working thread holds its row in Threads and Recents while it speaks");

  at(400);
  state = end(state, "reviewer", 3);
  assert.equal(state.threads.find((thread) => thread.id === "reviewer")!.rankedAt, 400);
  assert.deepEqual(lists(state), { threads: ["reviewer", "other"], recents: ["reviewer", "other"] });
});

test("a thread saved or sent before threads were ranked ranks by when it last spoke", () => {
  const { rankedAt: _unranked, ...saved } = task("old", { createdAt: 5, messages: [{ id: "m", kind: "assistant", text: "Done.", at: 40 }], runEndedAt: 41 });
  const loaded = stateFromData({ version: THREAD_STORE_VERSION, tasks: [saved], projects: [], worktrees: [], lastFolder: null });
  assert.equal(loaded.threads[0]!.rankedAt, 41);

  const read = createRemoteWorkspaceReader()({ ...workspace(), threads: [saved] });
  assert.equal(read.threads[0]!.rankedAt, 41);
});

function fire(quiet: boolean): WorkspaceState {
  const pending = reduce(workspace({ threads: [task("task-a", { rankedAt: 1 })] }), {
    type: "automation.fired",
    fire: { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2, unattended: true, ...(quiet ? { quiet } : {}) },
  });
  return reduce(pending.state, { type: "run.resolved", pendingId: effectAt(pending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS }).state;
}

test("joining a scheduled run ranks a quiet one where its turn starts and leaves a loud one where it began", () => {
  at(100);
  const loud = fire(false);
  const quiet = fire(true);
  assert.deepEqual([loud.threads[0]!.rankedAt, quiet.threads[0]!.rankedAt], [100, 1]);

  at(200);
  const join = (state: WorkspaceState) => reduce(state, { type: "task.send", taskId: "task-a", text: "What did you find?", steer: true }).state.threads[0]!.rankedAt;
  assert.equal(join(loud), 100, "a loud tick already moved the row when it started");
  assert.equal(join(quiet), 200, "a quiet tick becomes a turn once the user joins it");
});

test("a row says when its thread was ranked, not when it last spoke", async () => {
  const ranked = Date.UTC(2026, 0, 1, 9, 5);
  const working = task("task-a", { projectId: "project-1", rankedAt: ranked, messages: [{ id: "m", kind: "assistant", text: "Still reading.", at: Date.UTC(2026, 0, 1, 14, 40) }] });
  const view = await mount(renderProjectSidebar({
    mode: "activity",
    projects: [{ id: "project-1", root: "/work/api" }],
    activityThreads: { priority: [], running: [], threads: [working], snoozed: [] },
  }));
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(ranked);
  assert.equal(query(view.container, ".task-row-text small").textContent, `api · ${time}`);
  await view.unmount();
});
