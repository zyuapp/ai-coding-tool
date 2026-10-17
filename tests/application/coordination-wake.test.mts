import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceInput, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { CoordinationNote } from "../../src/domain/coordination.ts";
import type { Subagent } from "../../src/domain/run.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { THREAD_STORE_VERSION } from "../../src/domain/thread-storage.ts";
import type { Workflow } from "../../src/domain/workflow.ts";
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

  const failing = reduce(stopped.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "failed" }));
  assert.equal(failing.state.threads[0]!.coordinationNotes?.at(-1)?.urgent, undefined, "a stopped run that fails on its way out is no urgent news");
  slept(failing, "a thread it stopped failing");
  const limited = reduce(stopped.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "failed", limit: SESSION }));
  assert.equal(limited.state.threads.find((thread) => thread.id === "one")?.limitPause, undefined, "a usage limit reached before the stop landed never puts it back in line");
  assert.equal(limited.state.threads[0]!.coordinationNotes?.at(-1)?.quiet, true);
  slept(limited, "a thread it stopped hitting its limit");

  assert.equal(reduce(state, { type: "coordination.stop-all", taskId: "one" }).effects.length, 0, "only a coordinator stops threads under it");
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
