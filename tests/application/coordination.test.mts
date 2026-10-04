import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { coordinationSections, coordinationView, overviewGroups } from "../../src/application/coordination.ts";
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

test("a message from another thread names its sender, and a member hears when that sender is not its coordinator", () => {
  const state = workspace({ threads: [lead("lead", { title: "Security review" }), lead("other", { title: "Monday" }), task("worker", { parentId: "lead", title: "QA" })] });
  const heard = (from: string) => {
    const sending = reduce(state, { type: "task.send", taskId: "worker", text: "Skip the scan", from });
    const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
    return { prompt: effectAt(started, "start-run").command.prompt, message: required(started.state.threads.find((thread) => thread.id === "worker")).messages.at(-1) };
  };

  const foreign = heard("other");
  assert.equal(foreign.message?.text, "Skip the scan");
  assert.equal(foreign.message?.detail, "From Monday · other");
  assert.match(foreign.prompt, /Message from the thread "Monday" \[other\], not from the user:\n\nSkip the scan/);
  assert.match(foreign.prompt, /coordinator "Security review" \[lead\], which did not send this message/);

  const own = heard("lead");
  assert.equal(own.message?.detail, "From Security review · lead");
  assert.match(own.prompt, /Message from the thread "Security review" \[lead\]/);
  assert.doesNotMatch(own.prompt, /did not send this message/);
});

test("a queued message from another thread keeps its sender when it is steered in or drained", () => {
  const state = workspace({ threads: [lead("other", { title: "Monday" }), task("worker")], activeRuns: { worker: activeRun("worker", "run-1") } });
  const queued = reduce(state, { type: "task.send", taskId: "worker", text: "Stop the stack", from: "other" });
  const message = required(queued.state.queuedMessages.worker?.[0]);
  assert.equal(message.detail, "From Monday · other");
  assert.match(message.prompt, /^Message from the thread "Monday" \[other\]/);

  const steered = reduce(queued.state, { type: "task.steer-queued", taskId: "worker", messageId: message.id });
  const steer = effectAt(steered, "send-run-command").command;
  assert.match(steer.type === "steer" ? steer.prompt : "", /Message from the thread "Monday"/);
});

test("a thread ending its turn wakes a free coordinator with the news, and waits for a busy one", () => {
  const worker = task("worker", { parentId: "lead", title: "Fix login", messages: [] });
  const busyWorker = { activeRuns: { worker: activeRun("worker", "run-w") }, runStatuses: { worker: "running" as const } };
  const free = workspace({ threads: [lead(), worker], ...busyWorker });
  const ended = reduce(free, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  const woken = effectOf(ended, "resolve-run-workspace");
  const pending = required(ended.state.pendingRuns[woken.pendingId]);
  assert.equal(pending.taskId, "lead");
  assert.deepEqual(pending.messageOrigin, { kind: "coordination" });
  assert.match(pending.text, /"Fix login" ended its turn/);

  const started = reduce(ended.state, { type: "run.resolved", pendingId: woken.pendingId, workspace: PROJECTLESS });
  assert.equal(started.state.threads[0].coordinationNotes, undefined, "a delivered note is not delivered again");
  assert.deepEqual(started.state.threads[0].messages.at(-1)?.origin, { kind: "coordination" });
  assert.equal(started.state.threads[0].messages.at(-1)?.detail, "Thread updates");

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

  const running = reduce({ ...raised.state, activeRuns: { worker: activeRun("worker", "run-w") } }, { type: "decision.answer", taskId: "worker", decisionId: decision.id, answer: "Tokens" });
  const steer = effectOf(running, "send-run-command").command;
  assert.equal(steer.type, "steer", "an answer joins the run that asked rather than waiting behind it");
  assert.match(steer.type === "steer" ? steer.prompt : "", /The user decided "Tokens or overrides\?": Tokens/);

  const stray = reduce(workspace({ threads: [task("alone")] }), { type: "coordination.decision-raised", taskId: "alone", request: { question: "Q?", options: [] } });
  assert.equal(stray.state.threads[0].decisions, undefined, "a thread outside any coordinator has nowhere to show a decision");
});

test("a coordinator stands for its threads in the activity lists", () => {
  const coordinator = lead();
  const asking = task("asking", { parentId: "lead", decisions: [{ id: "d1", question: "Q?", options: [], raisedAt: 1 }] });
  const busy = task("busy", { parentId: "lead" });
  const sections = coordinationSections([coordinator, asking, busy], new Set(["busy"]), new Set());
  assert.deepEqual(sections.priority.map((thread) => thread.id), ["lead"]);
  assert.deepEqual([...sections.running, ...sections.threads].map((thread) => thread.id), [], "its threads are reached through it, in no list of their own");

  const working = coordinationSections([coordinator, busy], new Set(["busy"]), new Set());
  assert.deepEqual(working.running.map((thread) => thread.id), ["lead"]);

  const orphan = coordinationSections([task("lead"), busy], new Set(["busy"]), new Set());
  assert.deepEqual(orphan.running.map((thread) => thread.id), ["busy"], "a thread whose coordinator stepped down stands on its own");
});

test("a thread under a coordinator opens as a tab in the coordinator's dock rather than as a thread of its own", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead", title: "Dark mode", outcome: "finished", outcomeUnread: true }), task("other")], currentId: "other" });
  const opened = reduce(state, { type: "task.select", taskId: "worker" }).state;
  assert.equal(opened.currentId, "lead", "the user lands on the coordinator");
  assert.deepEqual(opened.docks.lead?.threadTabs, ["worker"]);
  assert.equal(opened.docks.lead?.tab, "worker");
  assert.equal(opened.docks.lead?.open, true);
  assert.equal(opened.threads[1].outcomeUnread, undefined, "what the thread had to say is read");
  const view = deriveView(opened);
  assert.deepEqual(view.threadTabs.map((tab) => tab.id), ["worker"]);
  assert.equal(view.threadTabs[0]?.standing, "finished");

  const again = reduce(opened, { type: "task.select", taskId: "worker" }).state;
  assert.deepEqual(again.docks.lead?.threadTabs, ["worker"], "a thread already open is not opened twice");

  const closed = reduce(opened, { type: "view.close-thread-tab", taskId: "worker" }).state;
  assert.deepEqual(closed.docks.lead?.threadTabs, []);
  assert.equal(closed.docks.lead?.tab, "overview", "closing the last tab goes back to the Overview");
  assert.equal(closed.docks.lead?.open, true);
  assert.equal(closed.threads.some((thread) => thread.id === "worker"), true, "closing the tab leaves the thread working");

  const keyed = reduce({ ...opened, keyboardTab: "worker" }, { type: "view.close-tab" }).state;
  assert.deepEqual(keyed.docks.lead?.threadTabs, [], "⌘W closes the thread's tab");

  const alone = reduce(state, { type: "task.select", taskId: "other" }).state;
  assert.equal(alone.currentId, "other", "a thread on its own is landed on as before");
});

test("a thread's tab reviews, schedules and reads the pull request of the thread's own checkout", () => {
  const projects = [{ id: "a", root: "/a", workspaceId: "workspace-a" }, { id: "b", root: "/b", workspaceId: "workspace-b" }];
  const state = workspace({ projects, threads: [lead("lead", { projectId: "a" }), task("worker", { parentId: "lead", projectId: "b" })], currentId: "lead" });
  const selected = reduce(state, { type: "task.select", taskId: "worker" });
  assert.ok(selected.effects.some((effect) => effect.type === "refresh-environment" && effect.workspaceId === "workspace-b"), "opening the tab reads its checkout");

  const reviewing = reduce(selected.state, { type: "diff.toggle", taskId: "worker" });
  assert.equal(reviewing.state.docks.lead?.tab, "diff");
  assert.equal(effectOf(reviewing, "read-diff").workspaceId, "workspace-b");
  assert.equal(deriveView(reviewing.state).reviewSubject, "worker");
  const refreshed = reduce(reviewing.state, { type: "diff.refresh" });
  assert.equal(effectOf(refreshed, "read-diff").workspaceId, "workspace-b", "the review stays on the tab's checkout");

  const own = reduce(reviewing.state, { type: "diff.toggle" });
  assert.equal(effectOf(own, "read-diff").workspaceId, "workspace-a", "the coordinator's own review is its checkout");
  assert.equal(deriveView(own.state).reviewSubject, null);

  const closed = reduce(reviewing.state, { type: "view.close-thread-tab", taskId: "worker" });
  assert.equal(effectOf(closed, "read-diff").workspaceId, "workspace-a", "closing the tab takes the review back to the coordinator");

  const scheduled = reduce(selected.state, { type: "view.open-dock-panel", panel: "automation", taskId: "worker" }).state;
  assert.equal(deriveView(scheduled).automationSubject, "worker");
  assert.equal(effectOf(reduce(scheduled, { type: "automation.run-now", taskId: "worker" }), "automation.run-now").taskId, "worker");

  assert.equal(effectOf(reduce(selected.state, { type: "pull-request.read", taskId: "worker" }), "read-pull-request").workspaceId, "workspace-b");
  assert.equal(effectOf(reduce(selected.state, { type: "task.checkout-branch", taskId: "worker", branch: "main" }), "checkout-branch").workspaceId, "workspace-b");
});

test("the app never opens on a thread under a coordinator", () => {
  const restored = reduce(workspace(), { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: [task("worker", { parentId: "lead" }), lead()], projects: [], worktrees: [], lastFolder: null } });
  assert.equal(restored.state.currentId, "lead");
});

test("dismissing a coordinator files away what its threads finished with", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead", outcome: "finished" })] });
  const dismissed = reduce(state, { type: "task.dismiss", taskId: "lead" });
  assert.equal(dismissed.state.threads[1].outcome, undefined);
});

test("a report or a decision waits for the thread's turn to end, and both reach the coordinator in one wake", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead", title: "Fix login" })], activeRuns: { worker: activeRun("worker", "run-w") }, runStatuses: { worker: "running" } });
  const reported = reduce(state, { type: "coordination.reported", taskId: "worker", state: "done", summary: "PR #42" });
  assert.deepEqual(reported.state.pendingRuns, {});
  const raised = reduce(reported.state, { type: "coordination.decision-raised", taskId: "worker", request: { question: "Ship?", options: [] } });
  assert.deepEqual(raised.state.pendingRuns, {});
  const ended = reduce(raised.state, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  const woken = Object.values(ended.state.pendingRuns);
  assert.equal(woken.length, 1);
  assert.match(required(woken[0]).text, /reported done: PR #42[\s\S]*asked the user to decide: Ship\?[\s\S]*ended its turn/);
  assert.match(required(woken[0]).prompt, /None of your threads is working now/);
});

test("a coordinator hears news once its other threads stop working, unless the news cannot wait", () => {
  const runs = { one: activeRun("one", "run-1"), two: activeRun("two", "run-2") };
  const state = workspace({ threads: [lead(), task("one", { parentId: "lead", title: "One" }), task("two", { parentId: "lead", title: "Two" })], activeRuns: runs, runStatuses: { one: "running", two: "running" } });
  const first = reduce(state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "succeeded" }));
  assert.deepEqual(first.state.pendingRuns, {}, "news waits while another thread works");
  assert.equal(first.state.threads[0].coordinationNotes?.length, 1);
  const second = reduce(first.state, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" }));
  const woken = Object.values(second.state.pendingRuns);
  assert.equal(woken.length, 1);
  assert.match(required(woken[0]).text, /"One" ended its turn[\s\S]*"Two" ended its turn/);

  const failed = reduce(state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "failed" }));
  assert.match(required(Object.values(failed.state.pendingRuns)[0]).prompt, /One other thread is still working/, "a failure is heard at once");
  const blocked = reduce(state, { type: "coordination.reported", taskId: "one", state: "blocked", summary: "Needs the signing cert" });
  const blockedEnd = reduce(blocked.state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "succeeded" }));
  assert.equal(Object.values(blockedEnd.state.pendingRuns).length, 1, "a blocked thread is heard at once");

  const approving = { ...state, activeRuns: { ...runs, two: { ...runs.two, status: "awaiting-approval" as const } } };
  const waitingOnUser = reduce(approving, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "succeeded" }));
  assert.equal(Object.values(waitingOnUser.state.pendingRuns).length, 1, "a thread waiting on the user's approval is not working");
});

test("news held for a thread's background work reaches the coordinator when that work finishes", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead", title: "Worker" })], activeRuns: { worker: activeRun("worker", "run-w") }, runStatuses: { worker: "running" } });
  const subagent = { taskId: "worker", id: "child" };
  const started = reduce(state, { type: "thread.event", event: { ...subagent, type: "subagent.started", description: "Inspect", sessionScoped: true } });
  const ended = reduce(started.state, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  assert.deepEqual(ended.state.pendingRuns, {}, "news waits while the subagent works");
  const finished = reduce(ended.state, { type: "thread.event", event: { ...subagent, type: "subagent.finished", status: "completed", summary: "Done" } });
  assert.match(required(Object.values(finished.state.pendingRuns)[0]).text, /"Worker" ended its turn/);
});

test("held news reaches the coordinator when its last working thread stops working without ending a turn", () => {
  const runs = { one: activeRun("one", "run-1"), two: activeRun("two", "run-2") };
  const state = workspace({ threads: [lead(), task("one", { parentId: "lead", title: "One" }), task("two", { parentId: "lead", title: "Two" })], activeRuns: runs, runStatuses: { one: "running", two: "running" } });
  const held = reduce(state, correlatedRunEvent("one", "run-1", 1, { type: "run.status", status: "succeeded" })).state;
  assert.deepEqual(held.pendingRuns, {});

  const asking = reduce(held, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "awaiting-approval" }));
  assert.match(required(Object.values(asking.state.pendingRuns)[0]).text, /"One" ended its turn/, "a thread waiting on the user's approval");

  const compacting = { ...held, activeRuns: { ...held.activeRuns, two: { ...runs.two, operation: "compact" as const } } };
  const compacted = reduce(compacting, correlatedRunEvent("two", "run-2", 1, { type: "run.status", status: "succeeded" }));
  assert.match(required(Object.values(compacted.state.pendingRuns)[0]).text, /"One" ended its turn/, "a thread done compacting");
  assert.doesNotMatch(required(Object.values(compacted.state.pendingRuns)[0]).text, /"Two"/, "compacting is not a turn");

  const resolving = { ...held, activeRuns: { one: runs.one }, pendingRuns: { p: { id: "p", runId: "r", origin: "composer" as const, taskId: "two", text: "go", prompt: "go", attachments: [] } } };
  const unresolved = reduce(resolving, { type: "run.unresolved", pendingId: "p", message: "No checkout" });
  assert.deepEqual(unresolved.state.pendingRuns, {}, "a thread still working keeps the news held");
  const idleOne = { ...resolving, activeRuns: {} };
  const failedSend = reduce(idleOne, { type: "run.unresolved", pendingId: "p", message: "No checkout" });
  assert.match(required(Object.values(failedSend.state.pendingRuns)[0]).text, /"One" ended its turn/, "a thread whose send never started");

  const moved = reduce({ ...held, activeRuns: { two: runs.two } }, { type: "task.set-coordinator", taskId: "two", coordinatorId: null });
  assert.equal(Object.values(moved.state.pendingRuns).length, 1, "a thread leaving its coordinator");
});

test("a coordinator waiting out a usage limit keeps its news, and a thread waiting one out has not ended its turn", () => {
  const session = { resetsAt: Date.now() + 3_600_000, window: "session" as const };
  const runs = { worker: activeRun("worker", "run-w") };
  const pausedLead = lead("lead", { limitPause: { ...session, pausedAt: 1 } });
  const state = workspace({ threads: [pausedLead, task("worker", { parentId: "lead", title: "Worker" })], activeRuns: runs, runStatuses: { worker: "running" } });
  const ended = reduce(state, correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "succeeded" }));
  assert.deepEqual(ended.state.pendingRuns, {}, "no wake runs into the limit");
  assert.equal(ended.state.threads[0].coordinationNotes?.length, 1, "the news waits for the coordinator to resume");

  const limited = reduce(workspace({ threads: [lead(), task("worker", { parentId: "lead", title: "Worker" })], activeRuns: runs, runStatuses: { worker: "running" } }),
    correlatedRunEvent("worker", "run-w", 1, { type: "run.status", status: "failed", limit: session }));
  assert.deepEqual(limited.state.pendingRuns, {});
  assert.equal(limited.state.threads[0].coordinationNotes, undefined, "a thread that resumes on its own has not ended its turn");
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

test("a coordinator's dock leads with an Overview that opens once a thread works under it and never closes", () => {
  const alone = reduce(workspace({ threads: [lead()], currentId: "lead" }), { type: "view.set-dock-open", open: false }).state;
  assert.equal(alone.docks.lead?.panels.includes("overview") ?? false, false, "a coordinator with nobody under it has no Overview");

  const joined = reduce(workspace({ threads: [lead(), task("worker"), task("second")], currentId: "lead" }), { type: "task.set-coordinator", taskId: "worker", coordinatorId: "lead" }).state;
  assert.deepEqual(joined.docks.lead?.panels, ["overview"]);
  assert.equal(joined.docks.lead?.tab, "overview");
  assert.equal(joined.docks.lead?.open, true, "the first thread under it shows the Overview");

  const hidden = reduce(joined, { type: "view.close-tab" }).state;
  assert.equal(hidden.docks.lead?.open, false, "⌘W on the Overview hides the dock");
  assert.deepEqual(hidden.docks.lead?.panels, ["overview"], "and keeps the tab");
  const another = reduce(hidden, { type: "task.set-coordinator", taskId: "second", coordinatorId: "lead" }).state;
  assert.equal(another.docks.lead?.open, false, "a dock the user hid stays hidden as more threads join");

  const tabbed = reduce(reduce(joined, { type: "view.open-dock-panel", panel: "automation" }).state, { type: "task.select", taskId: "worker" }).state;
  assert.equal(reduce(tabbed, { type: "view.close-thread-tab", taskId: "worker" }).state.docks.lead?.tab, "overview", "closing the last thread tab falls back to the Overview, not the panel beside it");

  const kept = reduce(joined, { type: "view.close-dock-panel", panel: "overview" }).state;
  assert.deepEqual(kept.docks.lead?.panels, ["overview"], "the Overview does not close");

  const stepped = reduce(joined, { type: "task.set-role", taskId: "lead", role: null }).state;
  assert.deepEqual(stepped.docks.lead?.panels, [], "a thread that stops coordinating loses its Overview");
});

test("a coordinator's Overview groups its threads by what they need, and its tool approvals wait beside its decisions", () => {
  const threads = [
    lead(),
    task("approval", { parentId: "lead" }),
    task("asking", { parentId: "lead", decisions: [{ id: "d1", question: "Keep it?", options: [], raisedAt: 1 }] }),
    task("failed", { parentId: "lead", outcome: "failed" }),
    task("busy", { parentId: "lead" }),
    task("done", { parentId: "lead", report: { state: "done", summary: "Shipped", at: 1 } }),
    task("idle", { parentId: "lead" }),
  ];
  const approval = { approvalId: "a1", taskId: "approval", runId: "run-a", title: "Run a command?", description: "", toolName: "Bash", input: { command: "yarn test" } };
  const view = coordinationView(threads, threads[0], new Set(["approval", "busy"]), new Set(["approval"]), (id) => id === "approval" ? approval : undefined);
  const groups = overviewGroups(view.members);
  assert.deepEqual(groups.needs.map(({ thread }) => thread.id), ["approval", "asking", "failed"]);
  assert.deepEqual(groups.working.map(({ thread }) => thread.id), ["busy"]);
  assert.deepEqual(groups.done.map(({ thread }) => thread.id), ["done", "idle"]);
  assert.deepEqual(view.approvals.map(({ thread, approval: item }) => [thread.id, item.approvalId]), [["approval", "a1"]]);
  assert.deepEqual(view.decisions.map(({ decision }) => decision.id), ["d1"]);

  const own = { ...approval, approvalId: "a0", taskId: "lead", runId: "run-lead" };
  const state = workspace({
    threads,
    currentId: "lead",
    activeRuns: { lead: activeRun("lead", "run-lead", { status: "awaiting-approval" }), approval: activeRun("approval", "run-a", { status: "awaiting-approval" }) },
    approvals: { "run-lead": own, "run-a": approval },
  });
  assert.deepEqual(deriveView(state).coordination.approvals.map(({ approval: item }) => item.approvalId), ["a0", "a1"], "the open coordinator's own approval waits first, beside its threads'");

  const alone = coordinationView([lead()], lead(), new Set(), new Set(), (id) => id === "lead" ? own : undefined);
  assert.deepEqual(alone.approvals.map(({ approval: item }) => item.approvalId), ["a0"], "a coordinator with nobody under it still answers its own approval in the card");
});
