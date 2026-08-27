import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceEffect, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { ActiveRun } from "../../src/application/task-workspace.ts";
import type { RunEvent } from "../../src/contracts/ipc.ts";
import type { Task } from "../../src/domain/task.ts";

function task(id: string): Task {
  return { id, title: id, messages: [], createdAt: 1, updatedAt: 1, engine: "claude", executionPolicy: "confirm", continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 0 } };
}

function activeRun(taskId: string, overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    taskId,
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
    ...overrides,
  };
}

/** One thread with a run in it, and the user somewhere else. */
function workspace(overrides: Partial<WorkspaceState> = {}, run: Partial<ActiveRun> = {}): WorkspaceState {
  return {
    ...emptyWorkspaceState(),
    tasks: [task("task-a")],
    activeRuns: { "task-a": activeRun("task-a", run) },
    currentId: null,
    focused: false,
    restored: true,
    ...overrides,
  };
}

type RunEventPayload = Omit<Extract<RunEvent, { type: "run.status" }>, "taskId" | "runId" | "sequence"> | Omit<Extract<RunEvent, { type: "approval.requested" }>, "taskId" | "runId" | "sequence">;

function fire(state: WorkspaceState, payload: RunEventPayload): WorkspaceTransition {
  return reduce(state, { type: "run.event", event: { taskId: "task-a", runId: "run-1", sequence: 1, ...payload } as RunEvent });
}

function headlines(effects: WorkspaceEffect[]): string[] {
  return effects.flatMap((effect) => effect.type === "announce-thread" ? [effect.notice.headline] : []);
}

const APPROVAL = {
  type: "approval.requested" as const,
  approvalId: "approval-1",
  intent: { toolId: "tool-1", name: "Bash", input: { command: "ls" } },
  title: "Bash needs approval",
  description: "Review this action before it runs.",
};

test("a run the user started says how it ended, and a failure carries its own reason", () => {
  assert.deepEqual(headlines(fire(workspace(), { type: "run.status", status: "succeeded" }).effects), ["The run finished."]);
  assert.deepEqual(headlines(fire(workspace(), { type: "run.status", status: "failed", message: "The tool crashed" }).effects), ["The tool crashed"]);
  assert.deepEqual(headlines(fire(workspace(), { type: "run.status", status: "failed" }).effects), ["The run failed."]);
});

test("a run the user ended themselves announces nothing", () => {
  assert.deepEqual(headlines(fire(workspace(), { type: "run.status", status: "cancelled" }).effects), []);
});

test("a run that stops to ask names what it is waiting on", () => {
  assert.deepEqual(headlines(fire(workspace(), APPROVAL).effects), ["Waiting for your permission to use Bash"]);
});

test("a scheduled run answers its own questions, so its stop is not the user's to hear about", () => {
  const scheduled = workspace({}, { origin: "automation" });
  assert.deepEqual(headlines(fire(scheduled, APPROVAL).effects), []);
});

test("a scheduled run speaks through what it finds, so finishing says nothing and failing still does", () => {
  const quiet = workspace({}, { origin: "automation", quiet: true, acknowledged: true });
  assert.deepEqual(headlines(fire(quiet, { type: "run.status", status: "succeeded" }).effects), []);

  const loud = workspace({}, { origin: "automation" });
  assert.deepEqual(headlines(fire(loud, { type: "run.status", status: "succeeded" }).effects), [], "a tick reports itself rather than its ending");
  assert.deepEqual(headlines(fire(loud, { type: "run.status", status: "failed", message: "The checkout is gone" }).effects), ["The checkout is gone"]);
});

test("turning notifications off keeps every notice back, and the thread is still marked", () => {
  const silent = workspace({ notifications: false });
  const settled = fire(silent, { type: "run.status", status: "succeeded" });

  assert.deepEqual(headlines(settled.effects), []);
  assert.equal(settled.state.tasks[0].outcome, "finished");
  assert.equal(settled.state.tasks[0].outcomeUnread, true, "the sidebar still says so");
  assert.deepEqual(headlines(fire(silent, APPROVAL).effects), []);
});

test("the switch is remembered, and an unchanged one writes nothing", () => {
  const off = reduce(workspace(), { type: "view.set-notifications", enabled: false });
  assert.equal(off.state.notifications, false);
  assert.equal(off.effects.filter((effect) => effect.type === "persist-preferences").length, 1);
  assert.deepEqual(reduce(off.state, { type: "view.set-notifications", enabled: false }).effects, []);
});
