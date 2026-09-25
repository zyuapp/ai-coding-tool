import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { coordinationSections, COORDINATION_UPDATE_DETAIL } from "../../src/application/coordination.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import type { ThreadBrief } from "../../src/domain/coordination.ts";
import { THREAD_STORE_VERSION } from "../../src/domain/thread-storage.ts";
import { task, workspace, activeRun, effectAt, effectOf, correlatedRunEvent, required } from "./workspace-reducer-fixtures.mts";

const PROJECTLESS = { id: "projectless", kind: "projectless" as const, root: "/tmp" };
const BRIEF: ThreadBrief = { intent: "fix the flaky login test", doneWhen: "the suite passes 50 runs", delivers: "pull-request" };

function lead(id = "lead", overrides = {}) {
  return task(id, { role: "coordinator", ...overrides });
}

test("a thread moves under a coordinator and back out, and a coordinator never works under another", () => {
  const state = workspace({ threads: [lead(), task("worker"), lead("other")] });
  const joined = reduce(state, { type: "task.set-coordinator", taskId: "worker", coordinatorId: "lead" });
  assert.equal(joined.state.threads[1].parentId, "lead");
  const left = reduce(joined.state, { type: "task.set-coordinator", taskId: "worker", coordinatorId: null });
  assert.equal(left.state.threads[1].parentId, undefined);

  assert.equal(reduce(state, { type: "task.set-coordinator", taskId: "other", coordinatorId: "lead" }).result?.ok, false);
  assert.equal(reduce(state, { type: "task.set-coordinator", taskId: "worker", coordinatorId: "worker" }).result?.ok, false, "only a coordinator takes threads");
});

test("a coordinator's new thread works under it, carries the brief, and runs as a member", () => {
  const state = workspace({ threads: [lead()] });
  const sending = reduce(state, { type: "task.send", text: "Fix it", coordinatorId: "lead", brief: BRIEF });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const worker = required(started.state.threads.find((thread) => thread.id !== "lead"));
  const command = effectAt(started, "start-run").command;

  assert.equal(worker.parentId, "lead");
  assert.deepEqual(worker.brief, BRIEF);
  assert.equal(worker.messages.at(-1)?.text, "Fix it", "the brief rides the prompt, not the message the user reads");
  assert.match(command.prompt, /The user's words: fix the flaky login test/);
  assert.equal(command.coordinationRole, "member");
});

test("a coordinator's run is read its threads and runs as a coordinator", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead", title: "Fix login", report: { state: "done", summary: "PR #42", at: 1 } })], currentId: "lead" });
  const sending = reduce(state, { type: "task.send", taskId: "lead", text: "How is it going?" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const command = effectAt(started, "start-run").command;

  assert.equal(command.coordinationRole, "coordinator");
  assert.match(command.prompt, /"Fix login" \[worker\] · idle · reported done: PR #42/);
});

test("a thread ending its turn wakes a free coordinator with the news, and waits for a busy one", () => {
  const worker = task("worker", { parentId: "lead", title: "Fix login", messages: [] });
  const busyWorker = { activeRuns: { worker: activeRun("worker", "run-w") }, runStatuses: { worker: "running" as const } };
  const free = workspace({ threads: [lead(), worker], ...busyWorker });
  const ended = reduce(free, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  const woken = effectOf(ended, "resolve-run-workspace");
  const pending = required(ended.state.pendingRuns[woken.pendingId]);
  assert.equal(pending.taskId, "lead");
  assert.equal(pending.detail, COORDINATION_UPDATE_DETAIL);
  assert.match(pending.text, /"Fix login" ended its turn/);

  const started = reduce(ended.state, { type: "run.resolved", pendingId: woken.pendingId, workspace: PROJECTLESS });
  assert.equal(started.state.threads[0].coordinationNotes, undefined, "a delivered note is not delivered again");
  assert.equal(started.state.threads[0].messages.at(-1)?.detail, COORDINATION_UPDATE_DETAIL);

  const busyLead = workspace({ threads: [lead(), worker], activeRuns: { ...busyWorker.activeRuns, lead: activeRun("lead", "run-l") }, runStatuses: { worker: "running", lead: "running" } });
  const waiting = reduce(busyLead, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  assert.equal(waiting.effects.some((effect) => effect.type === "resolve-run-workspace"), false);
  assert.equal(waiting.state.threads[0].coordinationNotes?.length, 1);
  const leadFree = reduce(waiting.state, correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "succeeded" }));
  assert.equal(effectOf(leadFree, "resolve-run-workspace").type, "resolve-run-workspace", "the coordinator hears it once it comes free");

  const stopped = reduce(waiting.state, correlatedRunEvent("lead", "run-l", 1, { type: "run.status", status: "cancelled" }));
  assert.equal(stopped.effects.some((effect) => effect.type === "resolve-run-workspace"), false, "a coordinator the user stopped is not woken straight back up");
});

test("progress is not news, but a thread done, blocked or failed leaves its coordinator a note", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead" })] });
  const working = reduce(state, { type: "coordination.reported", taskId: "worker", state: "working", summary: "Profiling" });
  assert.equal(working.state.threads[1].report?.state, "working");
  assert.equal(working.state.threads[0].coordinationNotes, undefined);
  const done = reduce(state, { type: "coordination.reported", taskId: "worker", state: "done", summary: "PR #42" });
  assert.match(required(done.state.threads[0].coordinationNotes)[0].text, /reported done: PR #42/);
});

test("a decision is put to the user at once and its answer reaches the thread that asked", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead", title: "Dark mode" })], notifications: true });
  const raised = reduce(state, { type: "coordination.decision-raised", taskId: "worker", request: { question: "Tokens or overrides?", options: [{ label: "Tokens", recommended: true }, { label: "Overrides" }] } });
  const decision = required(raised.state.threads[1].decisions?.[0]);
  assert.equal(effectOf(raised, "announce-thread").notice.taskId, "lead", "the notice lands where the decision is answered");
  assert.equal(deriveView({ ...raised.state, currentId: "lead" }).coordination.decisions.length, 1);

  const answered = reduce(raised.state, { type: "decision.answer", taskId: "worker", decisionId: decision.id, answer: "Tokens" });
  assert.equal(answered.state.threads[1].decisions?.[0].answer, "Tokens");
  const sent = required(Object.values(answered.state.pendingRuns).find((pending) => pending.taskId === "worker"));
  assert.match(sent.text, /The user decided "Tokens or overrides\?": Tokens/);

  const stray = reduce(workspace({ threads: [task("alone")] }), { type: "coordination.decision-raised", taskId: "alone", request: { question: "Q?", options: [] } });
  assert.equal(stray.state.threads[0].decisions, undefined, "a thread outside any coordinator has nowhere to show a decision");
});

test("a coordinator stands for its threads in the activity lists", () => {
  const coordinator = lead();
  const asking = task("asking", { parentId: "lead", decisions: [{ id: "d1", question: "Q?", options: [], raisedAt: 1 }] });
  const busy = task("busy", { parentId: "lead" });
  const sections = coordinationSections([coordinator, asking, busy], new Set(["busy"]), new Set());
  assert.deepEqual(sections.priority.map((thread) => thread.id), ["lead"]);
  assert.deepEqual([...sections.running, ...sections.threads].map((thread) => thread.id), [], "its threads are drawn under it, in no list of their own");

  const working = coordinationSections([coordinator, busy], new Set(["busy"]), new Set());
  assert.deepEqual(working.running.map((thread) => thread.id), ["lead"]);

  const orphan = coordinationSections([task("lead"), busy], new Set(["busy"]), new Set());
  assert.deepEqual(orphan.running.map((thread) => thread.id), ["busy"], "a thread whose coordinator stepped down stands on its own");
});

test("dismissing a coordinator files away what its threads finished with", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead", outcome: "finished" })] });
  const dismissed = reduce(state, { type: "task.dismiss", taskId: "lead" });
  assert.equal(dismissed.state.threads[1].outcome, undefined);
});

test("a report or a decision wakes a free coordinator without waiting for the thread's turn to end", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead" })], activeRuns: { worker: activeRun("worker", "run-w") } });
  const reported = reduce(state, { type: "coordination.reported", taskId: "worker", state: "blocked", summary: "Needs the signing cert" });
  assert.equal(required(Object.values(reported.state.pendingRuns)[0]).taskId, "lead");
  const raised = reduce(state, { type: "coordination.decision-raised", taskId: "worker", request: { question: "Ship?", options: [] } });
  assert.equal(required(Object.values(raised.state.pendingRuns)[0]).taskId, "lead");
});

test("notes waiting when the app closed are delivered once the store is back", () => {
  const waiting = lead("lead", { coordinationNotes: [{ id: "n1", threadId: "worker", text: "\"Fix login\" ended its turn.", at: 1 }] });
  const loaded = reduce(workspace(), { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: [waiting, task("worker", { parentId: "lead" })], projects: [], worktrees: [], lastFolder: null } });
  assert.equal(required(Object.values(loaded.state.pendingRuns)[0]).taskId, "lead");
});

test("a run hears exactly the notes it carried and those that arrived since, even past the cap", () => {
  const notes = Array.from({ length: 49 }, (_, index) => ({ id: `n${index}`, threadId: "worker", text: `note ${index}`, at: index }));
  const state = workspace({ threads: [lead("lead", { coordinationNotes: notes }), task("worker", { parentId: "lead" })], activeRuns: { worker: activeRun("worker", "run-w") } });
  const woken = reduce(state, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  const pendingId = effectOf(woken, "resolve-run-workspace").pendingId;
  assert.equal(woken.state.pendingRuns[pendingId]?.coordination?.notes?.length, 50, "the wake carries a full list of notes");
  const late = reduce(woken.state, { type: "coordination.reported", taskId: "worker", state: "done", summary: "late news" });
  const started = reduce(late.state, { type: "run.resolved", pendingId, workspace: PROJECTLESS });
  assert.match(effectAt(started, "start-run").command.prompt, /late news/, "a note that pushed an old one out is still heard");
  assert.equal(started.state.threads[0].coordinationNotes, undefined);
});

test("an answer that cannot be sent leaves the decision open, and an overlong one is refused", () => {
  const decisions = [{ id: "d1", question: "Ship?", options: [], raisedAt: 1 }];
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead", decisions })], creatingWorktrees: ["worker"] });
  const refused = reduce(state, { type: "decision.answer", taskId: "worker", decisionId: "d1", answer: "Yes" });
  assert.equal(refused.result?.ok, false);
  assert.equal(refused.state.threads[1].decisions?.[0].answer, undefined);
  const long = reduce({ ...state, creatingWorktrees: [] }, { type: "decision.answer", taskId: "worker", decisionId: "d1", answer: "x".repeat(4_001) });
  assert.equal(long.result?.ok, false);
});

test("a thread that leaves its coordinator with a decision open is where it is answered", () => {
  const state = workspace({ threads: [lead(), task("worker", { decisions: [{ id: "d1", question: "Ship?", options: [], raisedAt: 1 }] })], currentId: "worker" });
  assert.equal(deriveView(state).coordination.decisions.length, 1);
});
