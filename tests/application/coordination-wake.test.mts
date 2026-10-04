import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { CoordinationNote } from "../../src/domain/coordination.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { THREAD_STORE_VERSION } from "../../src/domain/thread-storage.ts";
import { task, workspace, activeRun, correlatedRunEvent, required } from "./workspace-reducer-fixtures.mts";

const SESSION = { resetsAt: Date.now() + 3_600_000, window: "session" as const };
const NEWS: CoordinationNote = { id: "n1", threadId: "one", text: "\"One\" ended its turn.", at: 1 };
const URGENT: CoordinationNote = { ...NEWS, id: "n2", text: "\"One\" failed.", urgent: true };

function lead(overrides: Partial<Thread> = {}) {
  return task("lead", { role: "coordinator", title: "Lead", ...overrides });
}

function member(id: string, overrides: Partial<Thread> = {}) {
  return task(id, { parentId: "lead", title: id, ...overrides });
}

function wakes(transition: WorkspaceTransition) {
  return Object.values(transition.state.pendingRuns).filter((pending) => pending.taskId === "lead");
}

function woken(transition: WorkspaceTransition, message = "the coordinator wakes once") {
  const runs = wakes(transition);
  assert.equal(runs.length, 1, message);
  assert.equal(transition.effects.filter((effect) => effect.type === "resolve-run-workspace" && effect.pendingId === runs[0]!.id).length, 1, message);
  return runs[0]!;
}

function slept(transition: WorkspaceTransition, message = "the coordinator stays asleep") {
  assert.deepEqual(wakes(transition), [], message);
}

/** A free coordinator holding news while `two` still works. */
function holding(two: Partial<WorkspaceState> = {}, notes = [NEWS]): WorkspaceState {
  return workspace({ threads: [lead({ coordinationNotes: notes }), member("one"), member("two")], ...two });
}

const running = { activeRuns: { two: activeRun("two", "run-2") }, runStatuses: { two: "running" as const } };

test("held news reaches the coordinator when its last working thread's usage-limit pause is cancelled", () => {
  const state = workspace({ threads: [lead({ coordinationNotes: [NEWS] }), member("one"), member("two", { limitPause: { ...SESSION, pausedAt: 1 } })] });
  const cancelled = reduce(state, { type: "limit.cancel", taskId: "two" });
  assert.match(woken(cancelled).text, /"One" ended its turn/);
  assert.deepEqual(cancelled.state.threads[0]!.coordinationNotes, [NEWS], "notes stay until the run starts");
});

test("a coordinator wakes once its last working thread stops, however it stops", () => {
  const cases: Array<[string, WorkspaceState, WorkspaceInput]> = [
    ["finishing", holding(running), correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" })],
    ["failing", holding(running), correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "failed" })],
    ["being stopped", holding(running), correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "cancelled" })],
    ["waiting on an approval", holding(running), correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "awaiting-approval" })],
    ["a send that never started", holding({ pendingRuns: { p: { id: "p", runId: "r", origin: "composer", taskId: "two", text: "go", prompt: "go", attachments: [] } } }), { type: "run.unresolved", pendingId: "p", message: "No checkout" }],
    ["its limit pause cancelled", holding({ threads: [lead({ coordinationNotes: [NEWS] }), member("one"), member("two", { limitPause: { ...SESSION, pausedAt: 1 } })] }), { type: "limit.cancel", taskId: "two" }],
    ["leaving the coordinator", holding(running), { type: "task.set-coordinator", taskId: "two", coordinatorId: null }],
    ["its subagent finishing", holding({ subagents: { two: [{ id: "child", description: "Inspect", status: "working", sessionScoped: true, startedAt: 1, activity: [] }] } }),
      { type: "thread.event", event: { taskId: "two", id: "child", type: "subagent.finished", status: "completed", summary: "Done" } }],
  ];
  for (const [how, state, input] of cases) {
    const before = reduce(state, { type: "view.set-focused", focused: false });
    slept(before, `${how}: nothing wakes while a thread works`);
    woken(reduce(state, input), how);
  }
});

test("a coordinator stays asleep while it cannot hear its news", () => {
  slept(reduce(holding(running), { type: "limit.cancel", taskId: "two" }), "a thread still working");
  const busyLead = holding({ activeRuns: { lead: activeRun("lead", "run-l") }, runStatuses: { lead: "running" } });
  slept(reduce(busyLead, { type: "task.set-coordinator", taskId: "two", coordinatorId: null }), "a coordinator already running");
  const pausedLead = holding({ ...running, threads: [lead({ coordinationNotes: [NEWS], limitPause: { ...SESSION, pausedAt: 1 } }), member("one"), member("two")] });
  slept(reduce(pausedLead, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" })), "a coordinator waiting out its limit");
  const resuming = reduce(holding(running), correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "failed", limit: SESSION }));
  slept(resuming, "a thread waiting out a session limit carries on by itself");
});

test("a coordinator the user stopped, or whose wake could not start, stays stopped until there is new news", () => {
  const leadRun = { activeRuns: { lead: activeRun("lead", "run-l") }, runStatuses: { lead: "running" as const } };
  const stopped = reduce(holding(leadRun, [URGENT]), correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "cancelled" }));
  slept(stopped, "stopping it");
  slept(reduce(holding(leadRun), correlatedRunEvent("lead", "run-old", 1, { type: "run.status", status: "cancelled" })), "a stale report changes nothing");
  slept(reduce(holding(), { type: "limit.cancel", taskId: "lead" }), "a coordinator with nothing to cancel");
  const pausedLead = holding({ threads: [lead({ coordinationNotes: [NEWS], limitPause: { ...SESSION, pausedAt: 1 } }), member("one"), member("two")] });
  slept(reduce(pausedLead, { type: "limit.cancel", taskId: "lead" }), "taking it out of line");

  const pending = { id: "p", runId: "r", origin: "composer" as const, taskId: "lead", text: "go", prompt: "go", attachments: [] };
  const unresolved = reduce(holding({ pendingRuns: { p: pending } }), { type: "run.unresolved", pendingId: "p", message: "No checkout" });
  slept(unresolved, "a wake that could not start is not retried at once");

  for (const [how, after] of [["stopped", stopped.state], ["unresolved", unresolved.state]] as const) {
    const poked = reduce({ ...after, ...running }, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "awaiting-approval" }));
    slept(poked, `${how}: a thread asking for approval is no news`);
    const restored = reduce(workspace(), { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: after.threads, projects: [], worktrees: [], lastFolder: null } });
    slept(restored, `${how}: nor is the app opening again`);
    const ended = reduce({ ...after, ...running }, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" }));
    assert.match(woken(ended, how).text, /"two" ended its turn/);
  }
});

test("a coordinator's run ending wakes it with what arrived meanwhile, unless the user stopped it", () => {
  const leadRun = { activeRuns: { lead: activeRun("lead", "run-l") }, runStatuses: { lead: "running" as const } };
  woken(reduce(holding(leadRun), correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "succeeded" })));
  woken(reduce(holding(leadRun), correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "failed" })));
  const compacting = { activeRuns: { lead: activeRun("lead", "run-l", { operation: "compact" }) }, runStatuses: { lead: "running" as const } };
  woken(reduce(holding(compacting), correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "succeeded" })), "done compacting");
  slept(reduce(holding(compacting), correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "cancelled" })), "compacting stopped");
});

test("a mid-turn report waits for its thread's turn even when it cannot wait for the others", () => {
  const both = { activeRuns: { one: activeRun("one", "run-1"), two: activeRun("two", "run-2") }, runStatuses: { one: "running" as const, two: "running" as const } };
  const state = workspace({ threads: [lead(), member("one"), member("two")], ...both });
  const blocked = reduce(state, { type: "coordination.reported", taskId: "one", state: "blocked", summary: "Needs the cert" });
  slept(blocked, "reporting");
  const otherEnds = reduce(blocked.state, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" }));
  slept(otherEnds, "another thread's turn ending");
  const ends = reduce(blocked.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "succeeded" }));
  assert.match(woken(ends).text, /reported blocked: Needs the cert[\s\S]*"one" ended its turn/);
});

test("urgent news reaches a free coordinator while other threads work, once", () => {
  const both = { activeRuns: { one: activeRun("one", "run-1"), two: activeRun("two", "run-2") }, runStatuses: { one: "running" as const, two: "running" as const } };
  const failed = reduce(workspace({ threads: [lead(), member("one"), member("two")], ...both }), correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "failed" }));
  const wake = woken(failed);
  assert.match(wake.prompt, /One other thread is still working/);
  const again = reduce(failed.state, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" }));
  assert.equal(wakes(again).length, 1, "a coordinator already waking is not woken twice");
});

test("a report from a thread that leaves its coordinator mid-turn is heard without waiting for that turn", () => {
  const state = workspace({ threads: [lead(), member("one"), member("two")], activeRuns: { one: activeRun("one", "run-1") }, runStatuses: { one: "running" } });
  const reported = reduce(state, { type: "coordination.reported", taskId: "one", state: "done", summary: "PR #42" });
  slept(reported);
  assert.match(woken(reduce(reported.state, { type: "task.set-coordinator", taskId: "one", coordinatorId: null })).text, /reported done: PR #42/);
});

test("a streamed event leaves coordinators alone", () => {
  const state = holding({ activeRuns: { two: activeRun("two", "run-2"), one: activeRun("one", "run-1") }, runStatuses: { two: "running", one: "running" } });
  const streamed = reduce(state, correlatedRunEvent("two", "run-2", 1, { type: "assistant.delta", messageId: "m", text: "hi" }));
  slept(streamed);
});

test("notes waiting when the app closed wake their coordinator once the store is back", () => {
  const loaded = reduce(workspace(), { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: [lead({ coordinationNotes: [NEWS] }), member("one")], projects: [], worktrees: [], lastFolder: null } });
  assert.equal(required(woken(loaded)).taskId, "lead");
});

test("archiving a coordinator stops it, so restoring it wakes nothing until there is new news", () => {
  const leadRun = { activeRuns: { lead: activeRun("lead", "run-l") }, runStatuses: { lead: "running" as const } };
  const runningLead = reduce(holding(leadRun), { type: "task.archive", taskId: "lead" });
  const cancelled = reduce(runningLead.state, correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "cancelled" }));
  const idleLead = reduce(holding(), { type: "task.archive", taskId: "lead" });
  for (const [how, archived] of [["running", cancelled.state], ["idle", idleLead.state]] as const) {
    const restored = reduce(archived, { type: "task.restore", taskId: "lead" });
    slept(restored, `${how}: restoring it`);
    const ended = reduce({ ...restored.state, ...running }, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" }));
    assert.match(woken(ended, how).text, /"two" ended its turn/);
  }
});
