import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { deriveView, stateFromData, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { CoordinationNote } from "../../src/domain/coordination.ts";
import type { Subagent } from "../../src/domain/run.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { THREAD_STORE_VERSION } from "../../src/domain/thread-storage.ts";
import type { Workflow } from "../../src/domain/workflow.ts";
import { task, workspace, activeRun, correlatedRunEvent, effectAt, required } from "./workspace-reducer-fixtures.mts";

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };
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
  assert.match(woken(cancelled).text, /"One" ended its turn[\s\S]*"two" was stopped/);
  assert.deepEqual(cancelled.state.threads[0]!.coordinationNotes?.[0], NEWS, "notes stay until the run starts");
});

test("a thread kept from carrying on after a session limit is heard as stopped, as a run the user stops is", () => {
  const said = { id: "m", kind: "assistant" as const, text: "Halfway through the migration", at: 1 };
  const state = workspace({ threads: [lead(), member("one", { messages: [said] })], activeRuns: { one: activeRun("one", "run-1") }, runStatuses: { one: "running" } });
  const heard = (transition: WorkspaceTransition) => transition.state.threads[0]!.coordinationNotes?.map(({ text, urgent, quiet }) => ({ text, urgent, quiet }));
  const stopped = reduce(state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "cancelled" }));
  const limited = reduce(state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "failed", limit: SESSION }));
  assert.equal(heard(limited), undefined, "a thread waiting out a session limit has not ended its turn");
  const cancelled = reduce(limited.state, { type: "limit.cancel", taskId: "one" });
  assert.deepEqual(heard(cancelled), heard(stopped));
  assert.match(woken(cancelled).text, /"one" was stopped\. It last said: Halfway through the migration/);
  for (const ended of [stopped, cancelled]) {
    const thread = required(ended.state.threads.find((item) => item.id === "one"));
    assert.deepEqual([thread.outcome, thread.runEndedAs, ended.state.runStatuses.one], ["stopped", "stopped", "stopped"], "it reads as cut off, not as done");
  }

  const all = reduce(limited.state, { type: "coordination.stop-all", taskId: "lead" });
  assert.match(required(all.state.threads[0]!.coordinationNotes?.at(-1)).text, /"one" was stopped/);
  assert.equal(all.state.threads[0]!.coordinationNotes?.at(-1)?.quiet, true, "Stop all is heard quietly");
  slept(all);
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

test("a thread that reports mid-turn and then waits for approval is heard while it waits", () => {
  const state = workspace({ threads: [lead(), member("one")], activeRuns: { one: activeRun("one", "run-1") }, runStatuses: { one: "running" } });
  const reported = reduce(state, { type: "coordination.reported", taskId: "one", state: "done", summary: "Replied done" });
  slept(reported, "reporting");
  const waiting = reduce(reported.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "awaiting-approval" }));
  assert.match(woken(waiting).text, /reported done: Replied done/);
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

test("a thread whose run the app quit under is restored as stopped, which its coordinator hears without waking", () => {
  const started = reduce(workspace({ threads: [lead(), member("one", { decisions: [{ id: "d1", question: "Which API?", options: [], raisedAt: 30 }] })] }), correlatedRunEvent("one", "run-1", 1, { type: "run.started", agentInitiated: true }));
  const one = (state: WorkspaceState) => required(state.threads.find((thread) => thread.id === "one"));
  assert.equal(one(started.state).runOpen, true, "a run is open on its thread while it goes");
  assert.equal(one(reduce(started.state, correlatedRunEvent("one", "run-1", 2, { type: "run.status", status: "succeeded" })).state).runOpen, undefined, "and closed once it ends");

  const restored = reduce(workspace(), { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: started.state.threads, projects: [], worktrees: [], lastFolder: null } });
  assert.equal(one(restored.state).runOpen, undefined);
  assert.equal(one(restored.state).runEndedAs, "stopped");
  assert.equal(one(restored.state).runEndedAt, 31, "a moment after the last thing it did");
  assert.deepEqual([one(restored.state).outcome, one(restored.state).outcomeUnread], ["stopped", true], "with the verdict a run the user stopped leaves");
  assert.deepEqual(restored.effects.filter((effect) => effect.type === "announce-thread"), [], "and nothing said on the desktop");
  const note = required(restored.state.threads.find((thread) => thread.id === "lead")?.coordinationNotes?.at(-1));
  assert.deepEqual([note.text, note.quiet], ["\"one\" was stopped.", true]);
  slept(restored, "quitting stopped it, as the user stopping it would");
});

test("a thread on screen when the app quit under its run is restored stopped, with nothing unread", () => {
  const stored = [task("solo", { runOpen: true, updatedAt: 5 })];
  const restored = stateFromData({ version: THREAD_STORE_VERSION, tasks: stored, projects: [], worktrees: [], lastFolder: null });
  assert.equal(restored.currentId, "solo");
  assert.deepEqual([restored.threads[0]!.outcome, restored.threads[0]!.outcomeUnread], ["stopped", undefined]);
  const filed = stateFromData({ version: THREAD_STORE_VERSION, tasks: [task("solo", { runOpen: true, archivedAt: Date.now() })], projects: [], worktrees: [], lastFolder: null });
  assert.equal(filed.threads[0]!.outcome, undefined, "one filed away is past ranking");
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

test("taking a coordinator's role off quiets what it held, so giving it back wakes nothing until there is new news", () => {
  const off = reduce(holding(running), { type: "task.set-role", taskId: "lead", role: null });
  slept(off, "taking the role off");
  assert.deepEqual(off.state.threads[0]!.coordinationNotes?.map((note) => note.quiet), [true]);
  const ended = reduce(off.state, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" }));
  const back = reduce(ended.state, { type: "task.set-role", taskId: "lead", role: "coordinator" });
  slept(back, "giving it back");
  const again = reduce({ ...back.state, ...running }, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" }));
  assert.match(woken(again).text, /"One" ended its turn[\s\S]*"two" ended its turn/, "what it held is heard with its next wake");
  const reviewer = reduce(holding(running), { type: "task.set-role", taskId: "one", role: "reviewer" });
  assert.deepEqual(reviewer.state.threads[0]!.coordinationNotes, [NEWS], "a role given one of its threads quiets nothing");
});

test("stopping all cancels every run under a coordinator and never wakes it", () => {
  const runs = { lead: activeRun("lead", "run-l"), one: activeRun("one", "run-1") };
  const start = { id: "start", runId: "run-new", origin: "composer" as const, text: "Write docs", prompt: "Write docs", attachments: [], coordination: { coordinatorId: "lead" } };
  const elsewhere = { id: "other", runId: "run-other", origin: "composer" as const, text: "Hi", prompt: "Hi", attachments: [] };
  const state = workspace({
    threads: [lead({ coordinationNotes: [NEWS] }), member("one"), member("two", { limitPause: { ...SESSION, pausedAt: 1 } }), member("three"), task("solo", { title: "Solo" })],
    activeRuns: { ...runs, solo: activeRun("solo", "run-s") },
    runStatuses: { lead: "running", one: "running", solo: "running" },
    pendingRuns: { start, other: elsewhere },
    queuedMessages: { one: [{ id: "q1", text: "Also this", prompt: "Also this", attachments: [] }] },
    quietStops: ["run-gone"],
  });
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  const cancels = stopped.effects.flatMap((effect) => effect.type === "send-run-command" && effect.command.type === "cancel" ? [[effect.command.taskId, effect.command.runId]] : []);
  assert.deepEqual(cancels, [["lead", "run-l"], ["one", "run-1"]], "the coordinator and its threads are stopped, nothing else");
  assert.deepEqual(stopped.state.quietStops, ["run-l", "run-1"], "only runs still going are kept");
  assert.equal(stopped.state.threads.find((thread) => thread.id === "two")?.limitPause, undefined, "a thread waiting out its limit is taken out of line");
  assert.deepEqual(Object.keys(stopped.state.pendingRuns), ["other"], "a start under the coordinator is dropped");
  assert.equal(stopped.state.threads[0]!.coordinationNotes?.every((note) => note.quiet), true, "what it held is heard with its next wake");
  slept(stopped, "stopping it");

  const memberEnds = reduce(stopped.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "cancelled" }));
  const note = required(memberEnds.state.threads[0]!.coordinationNotes?.at(-1));
  assert.match(note.text, /"one" was stopped/);
  assert.equal(note.quiet, true);
  assert.deepEqual(memberEnds.state.quietStops, ["run-l"]);
  assert.equal(memberEnds.state.prompts.one, "Also this", "what was queued goes back to its composer");
  slept(memberEnds, "a thread it stopped ending");
  const leadEnds = reduce(memberEnds.state, correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "cancelled" }));
  assert.deepEqual(leadEnds.state.quietStops, []);
  slept(leadEnds, "its own run ending");

  const limited = reduce(stopped.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "failed", message: "Usage limit reached.", limit: SESSION }));
  const limitedOne = required(limited.state.threads.find((thread) => thread.id === "one"));
  assert.equal(limitedOne.limitPause, undefined, "a usage limit reached before the stop landed never puts it back in line");
  assert.deepEqual([limitedOne.runEndedAs, limitedOne.outcome], ["stopped", "stopped"], "it ends as the stop asked");
  assert.deepEqual([limited.state.threads[0]!.coordinationNotes?.at(-1)?.text, limited.state.threads[0]!.coordinationNotes?.at(-1)?.quiet], ["\"one\" was stopped.", true]);
  assert.equal(limited.effects.some((effect) => effect.type === "announce-thread"), false, "nor is it said as a failure on the desktop");
  assert.equal(limited.state.prompts.one, "Also this", "what was queued goes back to its composer");
  slept(limited, "a thread it stopped hitting its limit");
  const weekly = reduce(stopped.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "failed", limit: { ...SESSION, window: "weekly" } }));
  assert.equal(weekly.state.threads[0]!.coordinationNotes?.at(-1)?.urgent, true, "a weekly limit waits for the user either way, so it is news");

  assert.equal(reduce(state, { type: "coordination.stop-all", taskId: "one" }).effects.length, 0, "only a coordinator stops threads under it");
});

test("a thread's turn that finished or failed before Stop all reached it is news, as one on a paired computer is", () => {
  const state = workspace({ threads: [lead(), member("one")], activeRuns: { lead: activeRun("lead", "run-l"), one: activeRun("one", "run-1") }, runStatuses: { lead: "running", one: "running" } });
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  const leadEnds = reduce(stopped.state, correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "cancelled" }));
  for (const [how, status, said] of [["failed", "failed", /"one" failed/], ["finished", "succeeded", /"one" ended its turn/]] as const) {
    const ended = reduce(leadEnds.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status }));
    assert.equal(required(ended.state.threads[0]!.coordinationNotes?.at(-1)).quiet, undefined, how);
    assert.match(woken(ended, how).text, said);
    assert.deepEqual(ended.state.quietStops, [], `${how}: the stop is spent`);
  }
  const cancelled = reduce(leadEnds.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "cancelled" }));
  assert.equal(required(cancelled.state.threads[0]!.coordinationNotes?.at(-1)).quiet, true, "one the stop ended is heard quietly");
  slept(cancelled);
});

const workflow = (id: string, overrides: Partial<Workflow> = {}): Workflow => ({ id, name: id, description: "Dynamic workflow", status: "running", phases: [], agents: [], totalTokens: 0, totalToolCalls: 0, startedAt: 1, ...overrides });
const subagent = (id: string, overrides: Partial<Subagent> = {}): Subagent => ({ id, description: "Inspect", status: "working", sessionScoped: true, startedAt: 1, activity: [], ...overrides });

test("stopping all stops each workflow and subagent that outlives its thread's run, and is then no longer offered", () => {
  const state = workspace({
    threads: [lead(), member("one"), member("two"), task("solo", { title: "Solo" })],
    activeRuns: { one: activeRun("one", "run-1") },
    runStatuses: { one: "running" },
    workflows: { lead: [workflow("wf-lead")], one: [workflow("wf-1"), workflow("wf-done", { status: "completed" })], two: [workflow("wf-2", { stopping: true })], solo: [workflow("wf-solo")] },
    subagents: { two: [subagent("child"), subagent("gone", { status: "completed" })] },
  });
  assert.equal(deriveView(state).stoppableCoordinatorIds.has("lead"), true);
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  const commands = stopped.effects.flatMap((effect) => effect.type === "send-run-command" ? [effect.command] : []);
  assert.deepEqual(commands, [
    { type: "cancel", taskId: "one", runId: "run-1" },
    { type: "stop-process", taskId: "lead", processId: "wf-lead" },
    { type: "stop-process", taskId: "one", processId: "wf-1" },
    { type: "stop-process", taskId: "two", processId: "child" },
  ], "only work still going under the coordinator, and not already stopping");
  assert.deepEqual(stopped.state.workflows.one?.map((item) => [item.id, item.stopping]), [["wf-1", true], ["wf-done", undefined]]);
  assert.deepEqual(stopped.state.subagents.two?.map((item) => [item.id, item.stopping]), [["child", true], ["gone", undefined]]);
  assert.equal(stopped.state.workflows.solo?.[0]?.stopping, undefined, "a thread outside it");
  slept(stopped);

  const ended = reduce(stopped.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "cancelled" }));
  assert.equal(deriveView(ended.state).stoppableCoordinatorIds.has("lead"), false, "what is left is already on its way to stopping");
});

test("a turn the agent takes itself after stopping all stopped its workflow ends quietly, and only that one", () => {
  const state = workspace({ threads: [lead(), member("one")], workflows: { one: [workflow("wf")] } });
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  assert.deepEqual(stopped.state.quietSessions, ["one"]);
  const answering = reduce(stopped.state, correlatedRunEvent("one", "run-a", 1, { type: "run.started", agentInitiated: true }));
  assert.deepEqual(answering.state.quietSessions, [], "only its next turn of its own");
  const answered = reduce(answering.state, correlatedRunEvent("one", "run-a", 2, { type: "run.status", status: "succeeded" }));
  assert.equal(answered.state.threads[0]!.coordinationNotes?.at(-1)?.quiet, true);
  assert.deepEqual(answered.state.quietStops, []);
  slept(answered, "the agent answering the stop");
  const limitedAnswer = reduce(answering.state, correlatedRunEvent("one", "run-a", 2, { type: "run.status", status: "failed", limit: SESSION }));
  assert.equal(limitedAnswer.state.threads[1]!.limitPause, undefined, "an answer a session limit cut short stays ended");
  assert.equal(limitedAnswer.state.threads[0]!.coordinationNotes?.at(-1)?.quiet, true);

  const later = reduce(answered.state, correlatedRunEvent("one", "run-b", 1, { type: "run.started", agentInitiated: true }));
  const news = reduce(later.state, correlatedRunEvent("one", "run-b", 2, { type: "run.status", status: "succeeded" }));
  assert.equal(news.state.threads[0]!.coordinationNotes?.at(-1)?.quiet, undefined, "a later turn of its own is news again");

  const messaged = reduce(stopped.state, { type: "task.send", taskId: "one", text: "Carry on" });
  const pendingId = required(Object.values(messaged.state.pendingRuns).find((pending) => pending.taskId === "one")).id;
  const sent = reduce(messaged.state, { type: "run.resolved", pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  assert.deepEqual(sent.state.quietSessions, [], "the user picking the thread back up");
  assert.equal(sent.state.quietStops.includes(required(sent.state.activeRuns.one).runId), false);
});

test("stopping all drops a coordinator's wake and hands back what its threads were about to send", () => {
  const wake = { id: "wake", runId: "run-w", origin: "composer" as const, taskId: "lead", text: "Update", prompt: "Update", attachments: [], coordination: { notes: ["n1"] } };
  const drained = { id: "next", runId: "run-n", origin: "composer" as const, taskId: "one", text: "Then this", prompt: "Then this", attachments: [], queuedIds: ["q1"] };
  const tick = { id: "tick", runId: "run-t", origin: "automation" as const, taskId: "one", text: "Check", prompt: "Check", attachments: [], automationId: "a1" };
  const state = workspace({
    threads: [lead({ coordinationNotes: [NEWS] }), member("one")],
    pendingRuns: { wake, next: drained, tick },
    queuedMessages: { one: [{ id: "q1", text: "Then this", prompt: "Then this", attachments: [] }] },
  });
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  assert.deepEqual(Object.keys(stopped.state.pendingRuns), ["tick"], "a scheduled tick is the user's to stop on its own");
  assert.equal(stopped.state.prompts.one, "Then this");
  assert.deepEqual(stopped.state.queuedMessages, {});
  assert.deepEqual(stopped.state.threads[0]!.coordinationNotes?.map((note) => note.quiet), [true], "the news its wake carried stays for the next one");
  slept(stopped);
});

test("a decision the user answered just before stopping all still reaches the thread that asked", () => {
  const decision = { id: "d1", question: "Keep the old API?", options: [], raisedAt: 1 };
  const state = workspace({ threads: [lead(), member("one", { decisions: [decision] })], activeRuns: { lead: activeRun("lead", "run-l") }, runStatuses: { lead: "running" } });
  const answered = reduce(state, { type: "decision.answer", taskId: "one", decisionId: "d1", answer: "A" });
  const stopped = reduce(answered.state, { type: "coordination.stop-all", taskId: "lead" });
  assert.deepEqual(Object.values(stopped.state.pendingRuns).map((pending) => [pending.taskId, pending.text]), [["one", "The user decided \"Keep the old API?\": A"]], "the answer is on its way, not dropped");
});

test("an answer queued into a run that stops before reading it opens its decision again", () => {
  const decision = { id: "d1", question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }], raisedAt: 1 };
  const state = workspace({ currentId: "lead", threads: [lead(), member("one", { decisions: [decision] })], activeRuns: { one: activeRun("one", "run-1") }, runStatuses: { one: "running" } });
  const answered = reduce(state, { type: "decision.answer", taskId: "one", decisionId: "d1", answer: "Postgres" });
  assert.equal(deriveView(answered.state).coordination.decisions.length, 0, "an answer on its way closes the decision");
  const message = required(answered.state.queuedMessages.one?.[0]);
  const stops: Array<[string, WorkspaceState]> = [
    ["stopping all", reduce(answered.state, { type: "coordination.stop-all", taskId: "lead" }).state],
    ["stopping the thread", answered.state],
  ];
  for (const [how, stopping] of stops) {
    const ended = reduce(stopping, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "cancelled" }));
    assert.equal(ended.state.prompts.one, undefined, `${how}: the answer is not handed to the composer as the user's words`);
    assert.equal(deriveView(ended.state).coordination.decisions.length, 1, `${how}: the decision is open to answer again`);
    assert.equal(required(ended.state.threads[1]!.decisions?.[0]).answer, undefined);
  }

  const delivered = reduce(answered.state, correlatedRunEvent("one", "run-1", 1, { type: "queued.delivered", messageId: message.id }));
  const after = reduce(delivered.state, correlatedRunEvent("one", "run-1", 2, { type: "run.status", status: "cancelled" }));
  assert.equal(required(after.state.threads[1]!.decisions?.[0]).answer, "Postgres", "an answer the thread read stays its answer");

  const paused = workspace({ currentId: "lead", threads: [lead(), member("one", { decisions: [decision], limitPause: { ...SESSION, pausedAt: 1 } })] });
  const held = reduce(paused, { type: "decision.answer", taskId: "one", decisionId: "d1", answer: "SQLite" });
  const heldAnswer = required(held.state.queuedMessages.one?.[0]);
  assert.equal(required(held.state.threads[1]!.limitPause?.held?.[0]).answers, "d1", "a held answer remembers its decision through a restart");
  const edited = reduce({ ...held.state, currentId: "one" }, { type: "task.edit-queued", taskId: "one", messageId: heldAnswer.id });
  assert.equal(edited.state.prompts.one, undefined, "an answer is the decision's, not the user's words to edit");
  assert.deepEqual(edited.state.queuedMessages.one, [heldAnswer]);
  const dropped = reduce(held.state, { type: "task.drop-queued", taskId: "one", messageId: heldAnswer.id });
  assert.equal(deriveView(dropped.state).coordination.decisions.length, 1, "taking the answer off opens the decision again");
});

test("an answer whose run never starts opens its decision again", () => {
  const decision = { id: "d1", question: "Ship?", options: [], raisedAt: 1 };
  const state = workspace({ currentId: "lead", threads: [lead(), member("one", { decisions: [decision] })] });
  const answered = reduce(state, { type: "decision.answer", taskId: "one", decisionId: "d1", answer: "Yes" });
  assert.equal(deriveView(answered.state).coordination.decisions.length, 0, "an answer on its way closes the decision");
  const pendingId = effectAt(answered, "resolve-run-workspace").pendingId;

  const unresolved = reduce(answered.state, { type: "run.unresolved", pendingId, message: "Reopen the project" });
  assert.equal(deriveView(unresolved.state).coordination.decisions.length, 1, "a checkout that never resolved sent nothing");

  const own = reduce(answered.state, correlatedRunEvent("one", "run-agent", 1, { type: "run.started", agentInitiated: true }));
  const overtaken = reduce(own.state, { type: "run.resolved", pendingId, workspace: PROJECTLESS });
  assert.equal(overtaken.result?.ok, false);
  assert.equal(deriveView(overtaken.state).coordination.decisions.length, 1, "a turn the agent opened first left the answer unsent");
  assert.equal(overtaken.state.threads[1]!.messages.length, 0);
});

test("a message another thread queued for a run that stops is not handed to the user, and its coordinator hears it never arrived", () => {
  const state = workspace({ threads: [lead(), member("one"), task("other", { title: "Other" })], activeRuns: { one: activeRun("one", "run-1") }, runStatuses: { one: "running" } });
  let queued = reduce(state, { type: "task.send", taskId: "one", text: "Also bump the version to 2.0", from: "lead" }).state;
  queued = reduce(queued, { type: "task.send", taskId: "one", text: "Mine", attachments: [] }).state;
  queued = reduce(queued, { type: "task.send", taskId: "one", text: "From the side", from: "other" }).state;
  const notes = (next: WorkspaceState) => next.threads[0]!.coordinationNotes?.map(({ text, quiet }) => ({ text, quiet }));
  const stopped = reduce(reduce(queued, { type: "coordination.stop-all", taskId: "lead" }).state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "cancelled" }));
  assert.equal(stopped.state.prompts.one, "Mine", "only the user's own words go back to the composer");
  assert.deepEqual(stopped.state.queuedMessages.one, undefined);
  assert.deepEqual(notes(stopped.state), [
    { text: "\"one\" was stopped.", quiet: true },
    { text: "Your message to \"one\" was not delivered: Also bump the version to 2.0", quiet: true },
  ], "a sender that is no coordinator has nowhere to hear it");
  slept(stopped);

  const message = required(queued.queuedMessages.one?.[0]);
  const dropped = reduce(queued, { type: "task.drop-queued", taskId: "one", messageId: message.id });
  assert.deepEqual(notes(dropped.state), [{ text: "Your message to \"one\" was not delivered: Also bump the version to 2.0", quiet: true }], "so does taking it off the queue");
});

test("news after a stop-all wakes the coordinator as usual, carrying what it missed", () => {
  const state = workspace({ threads: [lead(), member("one"), member("two")], activeRuns: { one: activeRun("one", "run-1"), two: activeRun("two", "run-2") }, runStatuses: { one: "running", two: "running" } });
  const stopped = reduce(state, { type: "coordination.stop-all", taskId: "lead" });
  const ended = [["one", "run-1"], ["two", "run-2"]].reduce((next, [id, runId]) => reduce(next, correlatedRunEvent(id!, runId!, 1, { type: "run.status", status: "cancelled" })).state, stopped.state);
  assert.equal(ended.threads[0]!.coordinationNotes?.length, 2);
  slept({ state: ended, effects: [] });

  const messaged = reduce(ended, { type: "task.send", taskId: "one", text: "Carry on" });
  const pendingId = required(Object.values(messaged.state.pendingRuns).find((pending) => pending.taskId === "one")).id;
  const running = reduce(messaged.state, { type: "run.resolved", pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  slept(running, "the user talking to a thread is not news yet");
  const runId = required(running.state.activeRuns.one).runId;
  const wake = woken(reduce(running.state, correlatedRunEvent("one", runId, 1, { type: "run.status", status: "succeeded" })));
  assert.match(wake.text, /"one" was stopped[\s\S]*"two" was stopped[\s\S]*"one" ended its turn/);
});

test("a suggestion that was starting when everything stopped can be started again", () => {
  const brief = { intent: "fix the flaky login test", doneWhen: "the suite passes", delivers: "report" as const };
  const proposal = { id: "p1", title: "Fix login", prompt: "Fix it", brief, place: { worktree: false }, proposedAt: 1 };
  const state = workspace({ threads: [lead({ threadModel: { model: "opus", effort: "high" }, proposals: [proposal] })] });
  const starting = reduce(state, { type: "proposal.start", taskId: "lead", proposalId: "p1" });
  assert.deepEqual(starting.state.startingProposals, ["p1"]);
  const stopped = reduce(starting.state, { type: "coordination.stop-all", taskId: "lead" });
  assert.deepEqual(stopped.state.pendingRuns, {});
  assert.deepEqual(stopped.state.startingProposals, [], "its row stops spinning");
  assert.deepEqual(stopped.state.threads[0]!.proposals?.map((item) => [item.id, item.error]), [["p1", undefined]], "it stays to start again");
  const again = reduce(stopped.state, { type: "proposal.start", taskId: "lead", proposalId: "p1" });
  assert.deepEqual(again.state.startingProposals, ["p1"]);
  assert.equal(Object.values(again.state.pendingRuns).filter((pending) => pending.coordination?.proposalId === "p1").length, 1);
});

test("Stop all is offered exactly while it has something to stop", () => {
  const stoppable = (state: Partial<WorkspaceState>) => deriveView(workspace({ threads: [lead(), member("one"), task("solo")], ...state })).stoppableCoordinatorIds.has("lead");
  assert.equal(stoppable({}), false, "an idle coordinator has nothing to stop");
  assert.equal(stoppable({ activeRuns: { one: activeRun("one", "run-1") } }), true, "a thread's run");
  assert.equal(stoppable({ activeRuns: { lead: activeRun("lead", "run-l") } }), true, "its own run");
  assert.equal(stoppable({ threads: [lead(), member("one", { limitPause: { ...SESSION, pausedAt: 1 } })] }), true, "a wait on a usage limit");
  const start = { id: "start", runId: "run-new", origin: "composer" as const, text: "Write docs", prompt: "Write docs", attachments: [], coordination: { coordinatorId: "lead" } };
  assert.equal(stoppable({ pendingRuns: { start } }), true, "a new thread still being started under it, though nothing runs yet");
  const tick = { id: "tick", runId: "run-t", origin: "automation" as const, taskId: "one", text: "Check", prompt: "Check", attachments: [], automationId: "a1" };
  assert.equal(stoppable({ pendingRuns: { tick } }), false, "a scheduled tick is not its to stop");
  assert.equal(stoppable({ activeRuns: { solo: activeRun("solo", "run-s") } }), false, "a thread outside it");
  assert.equal(stoppable({ creatingWorktrees: ["one"] }), false, "a checkout being made is no run to stop");
  assert.equal(stoppable({ workflows: { one: [workflow("wf")] } }), true, "a workflow its run left going");
  assert.equal(stoppable({ subagents: { lead: [subagent("child")] } }), true, "a subagent its run left going");
  assert.equal(stoppable({ workflows: { one: [workflow("wf", { stopping: true })] }, subagents: { one: [subagent("child", { status: "completed" })] } }), false, "work stopping or done");
  assert.equal(stoppable({ workflows: { solo: [workflow("wf")] } }), false, "a workflow outside it");
});

test("a working thread on a paired computer holds non-urgent news, and its turn ending there delivers it", () => {
  const far = task("far", { title: "Far", remoteLead: { threadId: "lead", title: "Lead", computer: "Mac" }, createdAt: 1 });
  const holder = workspace({ threads: [far], activeRuns: { far: activeRun("far", "run-far") } });
  const studio = { id: "studio", name: "Studio", host: "studio.test", pairedAt: 1, status: "connected" as const, error: null, state: holder };
  const state = workspace({ threads: [lead({ coordinationNotes: [NEWS], remoteHeard: { far: 1 } }), member("one")], computers: { ...workspace().computers, paired: [studio] } });
  slept(reduce(state, { type: "view.set-focused", focused: false }), "a thread working there holds the news here");
  const ended = { ...holder, threads: [{ ...far, runEndedAt: 9, outcome: "finished" as const }], activeRuns: {} };
  const woke = woken(reduce(state, { type: "computer.state", id: "studio", state: ended }));
  assert.match(woke.text, /"One" ended its turn\.\n"Far" ended its turn\./);
});
