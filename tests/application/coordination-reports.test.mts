import assert from "node:assert/strict";
import { test } from "vitest";
import { coordinatedThreadStatus, coordinationContext } from "../../src/application/coordination.ts";
import { coordinationView } from "../../src/application/coordination-view.ts";
import { threadMark, withdrawRun } from "../../src/application/thread-run-state.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { MAX_OPEN_DECISIONS, type CoordinationReport, type ThreadBrief } from "../../src/domain/coordination.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, correlatedRunEvent, effectAt, effectOf, required, run, task, workspace } from "./workspace-reducer-fixtures.mts";

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };
const BRIEF: ThreadBrief = { intent: "push the login fix", doneWhen: "it is on main", delivers: "commit" };

function lead() {
  return task("lead", { role: "coordinator", title: "Lead" });
}

function member(id: string, overrides: Partial<Thread> = {}) {
  return task(id, { parentId: "lead", title: id[0]!.toUpperCase() + id.slice(1), ...overrides });
}

test("a thread that ends its turn without reporting reads as done in what it last said, and its coordinator is told it never reported", () => {
  const reply = { id: "reply", kind: "assistant" as const, text: "\n- Pushed **commit** `a1b2c3d` to [main](https://github.com/o/r/tree/main).\n\nTests pass.", at: 5 };
  const threads = [
    lead(),
    member("unreported", { brief: BRIEF, outcome: "finished", messages: [reply] }),
    member("silent", { outcome: "finished" }),
    member("progressed", { outcome: "finished", report: { state: "working", summary: "Halfway", at: 1 }, messages: [reply] }),
    member("reported", { outcome: "finished", report: { state: "done", summary: "Shipped", at: 1 }, messages: [reply] }),
    member("asking", { outcome: "finished", messages: [reply], decisions: [{ id: "d1", question: "Keep it?", options: [], raisedAt: 1 }] }),
    member("stopped", { outcome: "stopped", messages: [reply] }),
  ];
  const state = workspace({ threads });
  const view = coordinationView(state, threads[0], new Set(), new Set(), () => undefined);
  assert.deepEqual(view.members.map(({ thread, status, summary }) => [thread.id, status, summary]), [
    ["unreported", "done", "Pushed commit a1b2c3d to main."],
    ["silent", "done", null],
    ["progressed", "done", "Pushed commit a1b2c3d to main."],
    ["reported", "done", "Shipped"],
    ["asking", "asking", "Keep it?"],
    ["stopped", "idle", null],
  ], "a finished turn is done whichever engine ran it, and only its own report outranks what it said");

  const context = coordinationContext(state, threads[0]);
  assert.match(context, /"Unreported" \[unreported\] · idle · ended its turn without reporting; it last said: Pushed commit a1b2c3d to main\.$/m);
  assert.match(context, /"Silent" \[silent\] · idle · ended its turn without reporting$/m);
  assert.match(context, /"Progressed" \[progressed\] · idle · ended its turn without reporting; it last said: Pushed commit a1b2c3d to main\.$/m, "a report that it was working is no final report");
  assert.match(context, /"Reported" \[reported\] · idle · reported done: Shipped$/m, "a thread that reported says so instead");
  assert.doesNotMatch(context, /"Asking" [^\n]*without reporting/, "nor is one waiting on the user");
  assert.doesNotMatch(context, /"Stopped" [^\n]*without reporting/, "nor one that was stopped");
});

test("a thread still at work keeps the report that it is working in its coordinator's roster", () => {
  const threads = [lead(), member("busy", { outcome: "finished", report: { state: "working", summary: "Halfway", at: 1 } })];
  const context = coordinationContext(workspace({ threads, activeRuns: { busy: activeRun("busy", "run-busy") } }), threads[0]);
  assert.match(context, /"Busy" \[busy\] · working · reported working: Halfway$/m);
});

/** A thread mid-turn under the lead that reports `state`, then ends that turn. */
function reportedTurn(state: CoordinationReport["state"], summary: string): WorkspaceState {
  const threads = [lead(), member("worker", { title: "Worker" })];
  return run(workspace({ threads, activeRuns: { worker: activeRun("worker", "run-1") }, runStatuses: { worker: "running" } }), [
    { type: "coordination.reported", taskId: "worker", state, summary },
    correlatedRunEvent("worker", "run-1", 1, { type: "run.status", status: "succeeded" }),
  ]);
}

/** The user writes to the worker and its next turn ends `status`, having said `reply` and reported nothing. */
function nextTurn(state: WorkspaceState, status: "succeeded" | "failed", reply: string): WorkspaceState {
  const sending = reduce(state, { type: "task.send", taskId: "worker", text: "Here they are" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const runId = effectAt(started, "start-run").command.runId;
  return run(started.state, [
    correlatedRunEvent("worker", runId, 1, { type: "assistant.delta", messageId: "reply", text: reply }),
    correlatedRunEvent("worker", runId, 2, { type: "run.status", status }),
  ]);
}

function standing(state: WorkspaceState) {
  const { status, summary } = coordinatedThreadStatus(state.threads.find((thread) => thread.id === "worker")!, new Set(), new Set());
  return [status, summary];
}

test("a report belongs to the turn that made it, so a later turn is read by how it ended", () => {
  const blocked = reportedTurn("blocked", "need DB credentials");
  assert.deepEqual(standing(blocked), ["blocked", "need DB credentials"]);
  const unblocked = nextTurn(blocked, "succeeded", "Migrated the database.");
  assert.equal(unblocked.threads.find((thread) => thread.id === "worker")?.report, undefined, "the new turn took the old report off");
  assert.deepEqual(standing(unblocked), ["done", "Migrated the database."], "a blocked report never outlives the turn that made it");
  const context = coordinationContext(unblocked, unblocked.threads[0]!);
  assert.match(context, /"Worker" \[worker\] · idle · ended its turn without reporting; it last said: Migrated the database\.$/m);
  assert.doesNotMatch(context.split("Your threads right now:")[1]!, /need DB credentials/, "the roster no longer says it is blocked");

  const failed = nextTurn(reportedTurn("done", "Shipped"), "failed", "Starting the follow-up.");
  assert.deepEqual(standing(failed), ["failed", null], "a turn that failed after an earlier done report needs the user");
});

/** A thread mid-turn under the lead that says `reply`, reports nothing, and ends that turn `status`. */
function unreportedTurn(status: "succeeded" | "failed", reply: string): WorkspaceState {
  const threads = [lead(), member("worker", { title: "Worker" })];
  return run(workspace({ threads, activeRuns: { worker: activeRun("worker", "run-1") }, runStatuses: { worker: "running" } }), [
    correlatedRunEvent("worker", "run-1", 1, { type: "assistant.delta", messageId: "reply", text: reply }),
    correlatedRunEvent("worker", "run-1", 2, { type: "run.status", status }),
  ]);
}

/** The coordinator has taken its thread's news and ended a turn of its own, which leaves it in Priority. */
function heard(state: WorkspaceState): WorkspaceState {
  return { ...state, pendingRuns: {}, threads: state.threads.map((thread) => thread.id === "lead" ? { ...thread, outcome: "finished" as const } : thread) };
}

test("filing a coordinator away takes its threads' verdicts off, but not how their turns ended", () => {
  for (const dismiss of [{ type: "task.dismiss", taskId: "lead" }, { type: "task.dismiss-all" }] as const) {
    const finished = heard(unreportedTurn("succeeded", "Migrated the database."));
    const filed = reduce(finished, dismiss).state;
    assert.equal(filed.threads.find((thread) => thread.id === "worker")?.outcome, undefined, `${dismiss.type} filed the verdict away`);
    assert.deepEqual(standing(filed), ["done", "Migrated the database."], `${dismiss.type} leaves an unreported finish done in its own words`);
    assert.match(coordinationContext(filed, filed.threads[0]!), /"Worker" \[worker\] · idle · ended its turn without reporting; it last said: Migrated the database\.$/m);

    const failed = reduce(heard(unreportedTurn("failed", "Starting.")), dismiss).state;
    assert.deepEqual(standing(failed), ["failed", null], `${dismiss.type} leaves a failed turn failed`);
  }
});

/** The agent opens a turn of its own on the worker, says `reply` and ends it without reporting. */
function agentTurn(state: WorkspaceState, reply: string): WorkspaceState {
  return run(state, [
    correlatedRunEvent("worker", "run-agent", 1, { type: "run.started", agentInitiated: true }),
    correlatedRunEvent("worker", "run-agent", 2, { type: "assistant.delta", messageId: "woke", text: reply }),
    correlatedRunEvent("worker", "run-agent", 3, { type: "run.status", status: "succeeded" }),
  ]);
}

test("a turn the agent opens itself leaves a report that it needs the user standing, but not one that it is done", () => {
  const blocked = agentTurn(reportedTurn("blocked", "need DB credentials"), "The build finished.");
  assert.deepEqual(standing(blocked), ["blocked", "need DB credentials"], "nobody has answered the blocker");
  assert.match(coordinationContext(blocked, blocked.threads[0]!), /"Worker" \[worker\] [^\n]*· reported blocked: need DB credentials$/m);
  assert.deepEqual(standing(agentTurn(reportedTurn("done", "Shipped"), "The build finished.")), ["done", "The build finished."], "what it said since is newer than its report");
});

/** A Codex session with enough context to compact. */
const codexSession = { engine: "codex" as const, model: "gpt-6.1-sol" as const, continuation: { provider: "codex" as const, value: "codex-thread" }, contextUsage: { tokens: 100_000, limit: 400_000, model: "gpt-6.1-sol" } };

test("a thread picked back up after its usage limit, or compacted, keeps what its turn reported", () => {
  const limitPause = { resetsAt: Date.now() + 3_600_000, window: "session" as const, pausedAt: 1 };
  const paused = workspace({ threads: [lead(), member("worker", { title: "Worker", outcome: "finished", report: { state: "working", summary: "Halfway", at: 1 }, limitPause })] });
  const resuming = reduce(paused, { type: "limit.resume", taskId: "worker" });
  const resumed = reduce(resuming.state, { type: "run.resolved", pendingId: effectOf(resuming, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  assert.deepEqual(resumed.state.threads.find((thread) => thread.id === "worker")?.report, { state: "working", summary: "Halfway", at: 1 }, "the limit cut the turn short; it did not end it");

  const reported = reportedTurn("done", "Shipped");
  const worker = reported.threads.find((thread) => thread.id === "worker")!;
  const codex = { ...worker, ...codexSession };
  const compacting = reduce({ ...reported, threads: reported.threads.map((thread) => thread.id === "worker" ? codex : thread) }, { type: "run.compact", taskId: "worker" });
  const compacted = reduce(compacting.state, { type: "run.resolved", pendingId: effectOf(compacting, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const runId = effectAt(compacted, "start-run").command.runId;
  const settled = reduce(compacted.state, correlatedRunEvent("worker", runId, 1, { type: "run.status", status: "succeeded" })).state;
  assert.deepEqual(standing(settled), ["done", "Shipped"], "compacting is not a turn");

  const failed = unreportedTurn("failed", "Starting.");
  const failedWorker = { ...failed.threads.find((thread) => thread.id === "worker")!, ...codexSession };
  const recompacting = reduce({ ...failed, threads: failed.threads.map((thread) => thread.id === "worker" ? failedWorker : thread) }, { type: "run.compact", taskId: "worker" });
  const recompacted = reduce(recompacting.state, { type: "run.resolved", pendingId: effectOf(recompacting, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const resettled = reduce(recompacted.state, correlatedRunEvent("worker", effectAt(recompacted, "start-run").command.runId, 1, { type: "run.status", status: "succeeded" })).state;
  assert.equal(resettled.threads.find((thread) => thread.id === "worker")?.runEndedAs, "failed", "compacting does not end a turn either");
  assert.deepEqual(standing(resettled), ["failed", null]);
});

test("a run that starts takes how the last one ended off, and a tick that settles unseen puts it back", () => {
  const finished = unreportedTurn("succeeded", "Migrated the database.");
  const sending = reduce(finished, { type: "task.send", taskId: "worker", text: "Next" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS }).state;
  assert.equal(started.threads.find((thread) => thread.id === "worker")?.runEndedAs, undefined);
  const before = threadMark(finished.threads.find((thread) => thread.id === "worker"));
  assert.equal(withdrawRun(member("worker", { runEndedAs: "failed" }), 0, before).runEndedAs, "finished");
});

test("a tick that settles unseen puts back the report it superseded, but keeps one it made of where its work ended up", () => {
  const before = threadMark(member("worker", { report: { state: "done", summary: "Shipped", at: 1 } }));
  assert.deepEqual(withdrawRun(member("worker"), 0, before).report, { state: "done", summary: "Shipped", at: 1 });
  assert.deepEqual(withdrawRun(member("worker", { report: { state: "blocked", summary: "No access", at: 2 } }), 0, before).report, { state: "blocked", summary: "No access", at: 2 });
  assert.deepEqual(withdrawRun(member("worker", { report: { state: "working", summary: "Looking", at: 2 } }), 0, before).report, { state: "done", summary: "Shipped", at: 1 }, "a report that it was working ended with the tick");
});

test("a resolved thread that a later turn leaves blocked or failed is open again, whatever opened the turn", () => {
  const resolved = reduce(workspace({ threads: [lead(), member("worker", { outcome: "finished" })], currentId: "lead" }), { type: "task.resolve", taskId: "worker" }).state;
  const standing = (state: WorkspaceState) => {
    const worker = required(deriveView(state).coordination.members[0]);
    return { status: worker.status, summary: worker.summary, resolved: state.threads[1]!.resolvedAt !== undefined };
  };
  const fired = reduce(resolved, { type: "automation.fired", fire: { automationId: "automation-1", taskId: "worker", runId: "run-tick", prompt: "Poll", runNumber: 2 } });
  const ticking = reduce(fired.state, { type: "run.resolved", pendingId: effectAt(fired, "resolve-run-workspace").pendingId, workspace: PROJECTLESS }).state;

  const failed = reduce(ticking, correlatedRunEvent("worker", "run-tick", 1, { type: "run.status", status: "failed", message: "boom" })).state;
  assert.deepEqual(standing(failed), { status: "failed", summary: null, resolved: false }, "a scheduled tick that fails");
  const blocked = reduce(ticking, { type: "coordination.reported", taskId: "worker", state: "blocked", summary: "Need a token" }).state;
  const ended = reduce(blocked, correlatedRunEvent("worker", "run-tick", 1, { type: "run.status", status: "succeeded" })).state;
  assert.deepEqual(standing(ended), { status: "blocked", summary: "Need a token", resolved: false }, "a scheduled tick that reports it is blocked");
  const quiet = reduce(ticking, correlatedRunEvent("worker", "run-tick", 1, { type: "run.status", status: "succeeded" })).state;
  assert.equal(standing(quiet).status, "resolved", "a tick that ends well leaves it resolved");

  const opened = reduce(resolved, correlatedRunEvent("worker", "run-agent", 1, { type: "run.started", agentInitiated: true })).state;
  const reported = reduce(opened, { type: "coordination.reported", taskId: "worker", state: "failed", summary: "The migration is broken" }).state;
  const settled = reduce(reported, correlatedRunEvent("worker", "run-agent", 2, { type: "run.status", status: "succeeded" })).state;
  assert.deepEqual(standing(settled), { status: "failed", summary: "The migration is broken", resolved: false }, "a turn the agent opened itself");
  const crashed = reduce(opened, correlatedRunEvent("worker", "run-agent", 2, { type: "run.status", status: "failed" })).state;
  assert.equal(standing(crashed).status, "failed");
  assert.equal(reduce(settled, { type: "task.resolve", taskId: "worker" }).result?.ok, undefined, "and the user can file it away again");
});

test("a thread the user resolved while it was stuck stays resolved through a turn that ends well", () => {
  const stuck = member("worker", { outcome: "finished", report: { state: "blocked", summary: "Need a token", at: 1 } });
  const resolved = reduce(workspace({ threads: [lead(), stuck], currentId: "lead" }), { type: "task.resolve", taskId: "worker" }).state;
  assert.equal(deriveView(resolved).coordination.members[0]?.status, "resolved");
  const opened = reduce(resolved, correlatedRunEvent("worker", "run-agent", 1, { type: "run.started", agentInitiated: true })).state;
  const ended = reduce(opened, correlatedRunEvent("worker", "run-agent", 2, { type: "run.status", status: "succeeded" })).state;
  assert.equal(deriveView(ended).coordination.members[0]?.status, "resolved", "the report it was filed away with says nothing new");
});

test("a resolved thread stays resolved through a session limit and a compaction that fails", () => {
  const resolved = reduce(workspace({ threads: [lead(), member("worker", { outcome: "finished", ...codexSession })], currentId: "lead" }), { type: "task.resolve", taskId: "worker" }).state;
  const status = (state: WorkspaceState) => deriveView(state).coordination.members[0]?.status;
  const opened = reduce(resolved, correlatedRunEvent("worker", "run-agent", 1, { type: "run.started", agentInitiated: true })).state;
  const session = { resetsAt: Date.now() + 3_600_000, window: "session" as const };
  const limited = reduce(opened, correlatedRunEvent("worker", "run-agent", 2, { type: "run.status", status: "failed", limit: session })).state;
  assert.equal(typeof limited.threads[1]!.resolvedAt, "number", "a limit that lifts on its own is not news");
  const resuming = reduce(limited, { type: "limit.resume", taskId: "worker" });
  const resumed = reduce(resuming.state, { type: "run.resolved", pendingId: effectOf(resuming, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const ended = reduce(resumed.state, correlatedRunEvent("worker", effectAt(resumed, "start-run").command.runId, 1, { type: "run.status", status: "succeeded" })).state;
  assert.equal(status(ended), "resolved", "nor is the turn it cut short ending well");

  const compacting = reduce(resolved, { type: "run.compact", taskId: "worker" });
  const compacted = reduce(compacting.state, { type: "run.resolved", pendingId: effectOf(compacting, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const failed = reduce(compacted.state, correlatedRunEvent("worker", effectAt(compacted, "start-run").command.runId, 1, { type: "run.status", status: "failed" })).state;
  assert.equal(status(failed), "resolved", "compacting is not a turn");
});

test("a thread raises only so many decisions at once, and one past them neither waits nor is announced", () => {
  let state = workspace({ threads: [lead(), member("worker")], notifications: true });
  for (let index = 0; index < MAX_OPEN_DECISIONS; index += 1) {
    state = reduce(state, { type: "coordination.decision-raised", taskId: "worker", request: { question: `Q${index}?`, options: [] } }).state;
  }
  const past = reduce(state, { type: "coordination.decision-raised", taskId: "worker", request: { question: "One more?", options: [] } });
  assert.equal(past.state, state);
  assert.deepEqual(past.effects, []);
  const first = required(state.threads[1].decisions?.[0]);
  const answered = reduce(state, { type: "decision.answer", taskId: "worker", decisionId: first.id, answer: "Yes" }).state;
  const again = reduce(answered, { type: "coordination.decision-raised", taskId: "worker", request: { question: "One more?", options: [] } });
  assert.equal(required(again.state.threads[1].decisions).filter((decision) => decision.answer === undefined).length, MAX_OPEN_DECISIONS, "an answer makes room for the next");
});

test("a thread that floods its coordinator crowds out its own notes, never another thread's news", () => {
  const state = workspace({ threads: [lead(), member("one"), member("two")] });
  let flooded = reduce(state, { type: "coordination.reported", taskId: "two", state: "done", summary: "Shipped PR #9" }).state;
  for (let index = 0; index < 60; index += 1) {
    flooded = reduce(flooded, { type: "coordination.reported", taskId: "one", state: "blocked", summary: `Stuck ${index}` }).state;
  }
  const notes = required(flooded.threads[0].coordinationNotes);
  assert.equal(notes.length, 50);
  assert.match(required(notes.find((note) => note.threadId === "two")).text, /Shipped PR #9/);
  assert.match(notes.at(-1)!.text, /Stuck 59/, "the newest of the flood is kept, its oldest given up");
  assert.match(notes.filter((note) => note.threadId === "one")[0].text, /Stuck 11$/);
});
