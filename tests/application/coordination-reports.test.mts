import assert from "node:assert/strict";
import { test } from "vitest";
import { coordinatedThreadStatus, coordinationContext } from "../../src/application/coordination.ts";
import { coordinationView } from "../../src/application/coordination-view.ts";
import { threadMark, withdrawRun } from "../../src/application/thread-run-state.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { CoordinationReport, ThreadBrief } from "../../src/domain/coordination.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, correlatedRunEvent, effectAt, effectOf, run, task, workspace } from "./workspace-reducer-fixtures.mts";

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

test("a thread picked back up after its usage limit, or compacted, keeps what its turn reported", () => {
  const limitPause = { resetsAt: Date.now() + 3_600_000, window: "session" as const, pausedAt: 1 };
  const paused = workspace({ threads: [lead(), member("worker", { title: "Worker", outcome: "finished", report: { state: "working", summary: "Halfway", at: 1 }, limitPause })] });
  const resuming = reduce(paused, { type: "limit.resume", taskId: "worker" });
  const resumed = reduce(resuming.state, { type: "run.resolved", pendingId: effectOf(resuming, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  assert.deepEqual(resumed.state.threads.find((thread) => thread.id === "worker")?.report, { state: "working", summary: "Halfway", at: 1 }, "the limit cut the turn short; it did not end it");

  const reported = reportedTurn("done", "Shipped");
  const worker = reported.threads.find((thread) => thread.id === "worker")!;
  const codex = { ...worker, engine: "codex" as const, model: "gpt-6.1-sol" as const, continuation: { provider: "codex" as const, value: "codex-thread" }, contextUsage: { tokens: 100_000, limit: 400_000, model: "gpt-6.1-sol" } };
  const compacting = reduce({ ...reported, threads: reported.threads.map((thread) => thread.id === "worker" ? codex : thread) }, { type: "run.compact", taskId: "worker" });
  const compacted = reduce(compacting.state, { type: "run.resolved", pendingId: effectOf(compacting, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const runId = effectAt(compacted, "start-run").command.runId;
  const settled = reduce(compacted.state, correlatedRunEvent("worker", runId, 1, { type: "run.status", status: "succeeded" })).state;
  assert.deepEqual(standing(settled), ["done", "Shipped"], "compacting is not a turn");
});

test("a tick that settles unseen puts back the report it superseded, but keeps one it made", () => {
  const before = threadMark(member("worker", { report: { state: "done", summary: "Shipped", at: 1 } }));
  assert.deepEqual(withdrawRun(member("worker"), 0, before).report, { state: "done", summary: "Shipped", at: 1 });
  assert.deepEqual(withdrawRun(member("worker", { report: { state: "blocked", summary: "No access", at: 2 } }), 0, before).report, { state: "blocked", summary: "No access", at: 2 });
});
