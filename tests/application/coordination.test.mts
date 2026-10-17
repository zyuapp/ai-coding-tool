import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { coordinationContext, coordinationSections, nextSteps, type CoordinatedThreadStatus } from "../../src/application/coordination.ts";
import { coordinationView, overviewGroups } from "../../src/application/coordination-view.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { NEXT_STEPS, withMemoryChange, type ThreadBrief } from "../../src/domain/coordination.ts";
import type { PullRequestAnswer, PullRequestLink } from "../../src/domain/pull-request.ts";
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

test("becoming a coordinator keeps what it ran on for its threads", () => {
  const state = workspace({ threads: [task("planner", { model: "sonnet", effort: "low" }), task("light", { model: "haiku" })], currentId: "planner" });
  const made = reduce(state, { type: "task.set-role", taskId: "planner", role: "coordinator" }).state;
  assert.deepEqual(made.threads[0].threadModel, { model: "sonnet", effort: "low" });
  assert.deepEqual(deriveView(made).coordination.threadModel, { model: "sonnet", effort: "low" }, "its Overview says so before any thread starts");

  const moved = reduce(reduce(made, { type: "task.set-model", taskId: "planner", engine: "claude", model: "opus" }).state, { type: "task.set-effort", taskId: "planner", engine: "claude", effort: "max" }).state;
  assert.equal(moved.threads[0].model, "opus");
  assert.deepEqual(moved.threads[0].threadModel, { model: "sonnet", effort: "low" }, "the coordinator's own model and effort no longer reach its threads");
  const dropped = reduce(moved, { type: "task.set-role", taskId: "planner", role: null }).state;
  assert.equal(dropped.threads[0].threadModel, undefined, "a thread that stops coordinating forgets the choice");
  const again = reduce(dropped, { type: "task.set-role", taskId: "planner", role: "coordinator" }).state;
  assert.deepEqual(again.threads[0].threadModel, { model: "opus", effort: "max" }, "becoming one again snapshots what it runs on now");

  const light = reduce(state, { type: "task.set-role", taskId: "light", role: "coordinator" }).state;
  assert.deepEqual(light.threads[1].threadModel, { model: "opus", effort: "high" }, "a Haiku thread's threads run on its engine's default");

  const drafted = reduce(reduce(reduce(reduce(workspace(), { type: "task.set-model", engine: "codex", model: "gpt-6-luna" }).state, { type: "task.set-effort", engine: "codex", effort: "low" }).state, { type: "task.set-role", role: "coordinator" }).state, { type: "view.set-prompt", prompt: "Split this work up" }).state;
  const sending = reduce(drafted, { type: "task.send" });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  assert.deepEqual(started.state.threads[0].threadModel, { model: "gpt-6-luna", effort: "low" }, "a draft made a coordinator snapshots its first run's model");
});

test("a coordinator's threads cannot run on Haiku or an effort their model lacks", () => {
  const state = workspace({ threads: [lead("lead", { threadModel: { model: "gpt-6.1-sol", effort: "ultra" } }), task("solo")] });
  const haiku = reduce(state, { type: "coordination.set-thread-model", taskId: "lead", model: "haiku" });
  assert.equal(haiku.result?.ok, false);
  assert.equal(haiku.state.threads, state.threads);

  const luna = reduce(state, { type: "coordination.set-thread-model", taskId: "lead", model: "gpt-6-luna" }).state;
  assert.deepEqual(luna.threads[0].threadModel, { model: "gpt-6-luna", effort: "max" }, "an effort the new model lacks moves to the nearest it takes");
  const mapped = reduce(luna, { type: "coordination.set-thread-model", taskId: "lead", model: "opus", effort: "ultra" }).state;
  assert.deepEqual(mapped.threads[0].threadModel, { model: "opus", effort: "max" });
  const low = reduce(mapped, { type: "coordination.set-thread-model", taskId: "lead", model: "opus", effort: "low" }).state;
  assert.deepEqual(low.threads[0].threadModel, { model: "opus", effort: "low" });
  assert.equal(reduce(low, { type: "coordination.set-thread-model", taskId: "lead", model: "opus", effort: "low" }).state.threads, low.threads, "an unchanged choice writes nothing");

  const solo = reduce(state, { type: "coordination.set-thread-model", taskId: "solo", model: "opus" });
  assert.equal(solo.result?.ok, false, "only a coordinator has threads to choose for");
  assert.equal(solo.state.threads[1].threadModel, undefined);
});

test("only a coordinator is muted, and it forgets the mute once it stops being one", () => {
  const state = workspace({ threads: [lead(), task("solo"), task("worker", { parentId: "lead" })] });
  const muted = reduce(state, { type: "coordination.set-muted", taskId: "lead", muted: true }).state;
  assert.equal(muted.threads[0].muted, true);
  assert.equal(reduce(muted, { type: "coordination.set-muted", taskId: "lead", muted: true }).state.threads, muted.threads, "an unchanged mute writes nothing");
  assert.equal(reduce(state, { type: "coordination.set-muted", taskId: "solo", muted: true }).state.threads, state.threads, "a thread under no coordinator has nothing to mute");
  assert.equal(reduce(state, { type: "coordination.set-muted", taskId: "worker", muted: true }).state.threads, state.threads, "nor does one of its threads");

  const restored = reduce(workspace(), { type: "store.loaded", data: { version: THREAD_STORE_VERSION, tasks: muted.threads, projects: [], worktrees: [], lastFolder: null } }).state;
  assert.equal(restored.threads.find((thread) => thread.id === "lead")?.muted, true, "the mute is kept with the thread");

  const dropped = reduce(muted, { type: "task.set-role", taskId: "lead", role: null }).state;
  assert.equal(dropped.threads[0].muted, undefined);
});

test("a coordinator made before it chose what its threads run on reads what it runs on itself", () => {
  const legacy = workspace({ threads: [lead("lead", { model: "sonnet", effort: "medium" })], currentId: "lead" });
  assert.deepEqual(deriveView(legacy).coordination.threadModel, { model: "sonnet", effort: "medium" });
  const gone = workspace({ threads: [lead("lead", { model: "haiku", threadModel: { model: "haiku" } })], currentId: "lead" });
  assert.deepEqual(deriveView(gone).coordination.threadModel, { model: "opus", effort: "high" }, "a choice its threads can no longer run on falls back to the engine's default");
});

test("a thread started with a brief but no coordinator keeps neither", () => {
  const state = workspace({ threads: [] });
  const sending = reduce(state, { type: "task.send", text: "Fix it", brief: BRIEF });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const thread = required(started.state.threads[0]);

  assert.equal(thread.brief, undefined);
  assert.doesNotMatch(effectAt(started, "start-run").command.prompt, /Brief from the coordinator/);
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

test("a coordinator's dock leads with an Overview and never closes it", () => {
  const joined = reduce(workspace({ threads: [lead(), task("worker"), task("second")], currentId: "lead" }), { type: "task.set-coordinator", taskId: "worker", coordinatorId: "lead" }).state;
  assert.deepEqual(joined.docks.lead?.panels, ["overview"]);
  assert.equal(joined.docks.lead?.tab, "overview", "the dock opens on the Overview");
  assert.equal(joined.docks.lead?.open ?? false, false, "but a thread arriving never opens it");

  const shown = reduce(joined, { type: "view.set-dock-open", open: true }).state;
  assert.equal(shown.docks.lead?.tab, "overview");
  const hidden = reduce(shown, { type: "view.close-tab" }).state;
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

test("a thread a coordinator starts in the background never opens, switches or focuses its dock", () => {
  const picking = reduce(workspace({ threads: [lead()], currentId: "lead" }), { type: "view.set-dock-open", open: true }).state;
  const state = { ...picking, focused: false };
  const sending = reduce(state, { type: "task.send", text: "Fix it", coordinatorId: "lead", brief: BRIEF });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  assert.deepEqual(started.state.docks.lead?.panels, ["overview"], "the Overview is there to pick");
  assert.equal(started.state.docks.lead?.tab, picking.docks.lead?.tab, "the dock keeps showing what the user left it on");
  assert.equal(started.state.dockFocus, null);
  for (const step of [sending, started]) assert.equal(step.effects.some((effect) => effect.type === "focus-window"), false, "the window is never called back");

  const closed = reduce(workspace({ threads: [lead(), task("worker")], currentId: "lead" }), { type: "view.set-dock-open", open: false }).state;
  const joined = reduce({ ...closed, focused: false }, { type: "task.set-coordinator", taskId: "worker", coordinatorId: "lead" });
  assert.equal(joined.state.docks.lead?.open, false, "a closed dock stays closed");
  assert.equal(joined.effects.some((effect) => effect.type === "focus-window"), false);
});

test("coming back to a coordinator puts the caret in the composer, not the Overview it was last in", () => {
  const state = workspace({ threads: [lead(), task("worker", { parentId: "lead" }), task("other")], currentId: "lead" });
  const overview = reduce(reduce(state, { type: "view.set-dock-open", open: true }).state, { type: "view.select-dock-tab", tab: "overview" }).state;
  assert.equal(deriveView(overview).dockFocus?.tab, "overview", "picking the Overview hands it the keys");

  const away = reduce(overview, { type: "task.select", taskId: "other" }).state;
  const back = reduce(away, { type: "task.select", taskId: "lead" }).state;
  assert.equal(back.docks.lead?.tab, "overview", "the dock comes back as it was left");
  assert.equal(deriveView(back).dockFocus, null, "but nothing in it asks for the keys again");

  const member = reduce(away, { type: "task.select", taskId: "worker" }).state;
  assert.equal(deriveView(member).dockFocus?.tab, "worker", "a thread opened in the dock on the way in still takes them");
});

test("a coordinator's Overview remembers how the user folded each group, per coordinator", () => {
  const state = workspace({ threads: [lead(), lead("other"), task("worker", { parentId: "lead" })], currentId: "lead" });
  const unfolded = reduce(state, { type: "view.set-overview-group", taskId: "lead", group: "done", open: true }).state;
  const whole = reduce(unfolded, { type: "view.set-overview-group", taskId: "lead", group: "working", all: true }).state;
  assert.deepEqual(deriveView(whole).overviewFolds, { done: { open: true }, working: { all: true } });
  assert.deepEqual(deriveView({ ...whole, currentId: "other" }).overviewFolds, {}, "another coordinator starts from its own defaults");
  assert.equal(reduce(whole, { type: "view.set-overview-group", taskId: "lead", group: "done", open: true }).state, whole, "an unchanged group changes nothing");
  assert.equal(reduce(whole, { type: "view.set-overview-group", taskId: "lead", group: "nowhere" as "done", open: true }).state, whole, "an unknown group is ignored");
});

test("a coordinator's Overview groups its threads by what they need, and its tool approvals wait beside its decisions", () => {
  const pullRequest = { number: 212, url: "https://github.com/o/r/pull/212", title: "Fix it", state: "open" as const, checks: "failing" as const };
  const threads = [
    lead(),
    task("approval", { parentId: "lead" }),
    task("asking", { parentId: "lead", decisions: [{ id: "d1", question: "Keep it?", options: [], raisedAt: 1 }] }),
    task("failed", { parentId: "lead", outcome: "failed" }),
    task("review", { parentId: "lead", brief: BRIEF, pullRequest, report: { state: "done", summary: "Opened #212", at: 1 } }),
    task("busy", { parentId: "lead" }),
    task("done", { parentId: "lead", report: { state: "done", summary: "Shipped", at: 1 } }),
    task("draft", { parentId: "lead", brief: BRIEF, pullRequest: { ...pullRequest, state: "draft" } }),
    task("idle", { parentId: "lead" }),
    task("resolved", { parentId: "lead", resolvedAt: 2, outcome: "failed" }),
    task("reworking", { parentId: "lead", resolvedAt: 2 }),
    task("reasking", { parentId: "lead", resolvedAt: 2, decisions: [{ id: "d2", question: "Again?", options: [], raisedAt: 2 }] }),
  ];
  const approval = { approvalId: "a1", taskId: "approval", runId: "run-a", title: "Run a command?", description: "", toolName: "Bash", input: { command: "yarn test" } };
  const view = coordinationView(workspace({ threads }), threads[0], new Set(["approval", "busy", "reworking"]), new Set(["approval"]), (id) => id === "approval" ? approval : undefined);
  const groups = overviewGroups(view.members);
  assert.deepEqual(groups.needs.map(({ thread }) => thread.id), ["approval", "asking", "failed", "reasking"], "an open decision outranks being resolved");
  assert.deepEqual(groups.review.map(({ thread, summary }) => [thread.id, summary]), [["review", "#212 · Checks failing"]], "its own open pull request outranks saying it is done");
  assert.deepEqual(groups.working.map(({ thread }) => thread.id), ["busy", "reworking"], "work going outranks being resolved");
  assert.deepEqual(groups.done.map(({ thread }) => thread.id), ["done", "draft", "idle"], "a draft is not ready for review");
  assert.deepEqual(groups.resolved.map(({ thread }) => thread.id), ["resolved"], "being resolved outranks a failure");
  assert.deepEqual(view.approvals.map(({ thread, approval: item }) => [thread.id, item.approvalId]), [["approval", "a1"]]);
  assert.deepEqual(view.decisions.map(({ decision }) => decision.id), ["d1", "d2"]);

  const own = { ...approval, approvalId: "a0", taskId: "lead", runId: "run-lead" };
  const state = workspace({
    threads,
    currentId: "lead",
    activeRuns: { lead: activeRun("lead", "run-lead", { status: "awaiting-approval" }), approval: activeRun("approval", "run-a", { status: "awaiting-approval" }) },
    approvals: { "run-lead": own, "run-a": approval },
  });
  assert.deepEqual(deriveView(state).coordination.approvals.map(({ approval: item }) => item.approvalId), ["a0", "a1"], "the open coordinator's own approval waits first, beside its threads'");

  const alone = coordinationView(workspace({ threads: [lead()] }), lead(), new Set(), new Set(), (id) => id === "lead" ? own : undefined);
  assert.deepEqual(alone.approvals.map(({ approval: item }) => item.approvalId), ["a0"], "a coordinator with nobody under it still answers its own approval in the card");
});

const SESSION = { continuation: { provider: "claude", value: "session" }, continuationStatus: "available" as const };

/** Sends a message and starts its run, answering with what the run is told and the state it starts in. */
function started(state: WorkspaceState, input: Extract<WorkspaceInput, { type: "task.send" }>) {
  const sending = reduce(state, input);
  const run = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  return { state: run.state, prompt: effectAt(run, "start-run").command.prompt };
}

test("a coordinator remembers and forgets what the user tells it, and a full memory says so", () => {
  const state = workspace({ threads: [lead()] });
  const remembered = reduce(state, { type: "coordination.remembered", taskId: "lead", change: { kind: "remember", text: "  Propose threads before starting them  " } }).state;
  assert.deepEqual(remembered.threads[0].memory?.notes.map(({ id, text }) => ({ id, text })), [{ id: "n1", text: "Propose threads before starting them" }]);
  assert.equal(remembered.threads[0].memory?.heard, 1, "its own note is one its session already knows");
  const purposed = reduce(remembered, { type: "coordination.remembered", taskId: "lead", change: { kind: "purpose", purpose: "Ship the v2 reader" } }).state;
  assert.equal(purposed.threads[0].memory?.purpose, "Ship the v2 reader");
  const forgot = reduce(purposed, { type: "coordination.remembered", taskId: "lead", change: { kind: "forget", noteId: "n1" } }).state;
  assert.deepEqual(forgot.threads[0].memory, { purpose: "Ship the v2 reader", notes: [], revision: 3, heard: 3 });
  const again = reduce(forgot, { type: "coordination.remembered", taskId: "lead", change: { kind: "remember", text: "Run at most two at a time" } }).state;
  assert.equal(again.threads[0].memory?.notes[0]?.id, "n4", "a note's ID is never reused");

  const notes = Array.from({ length: 30 }, (_, index) => ({ id: `n${index + 1}`, text: `Note ${index}`, at: 1 }));
  const full = workspace({ threads: [lead("lead", { memory: { notes, revision: 30, heard: 30 } })] });
  const tried = withMemoryChange(full.threads[0], { kind: "remember", text: "One more" }, 2, { heard: true });
  assert.deepEqual(tried, { error: "Memory holds at most 30 notes. Forget one first." });
  assert.deepEqual(withMemoryChange(full.threads[0], { kind: "forget", noteId: "n99" }, 2, { heard: true }), { error: "No note has the ID n99." });
  const refused = reduce(full, { type: "coordination.remembered", taskId: "lead", change: { kind: "remember", text: "One more" } });
  assert.equal(refused.state.threads, full.threads);
  assert.equal(refused.state.actionError, null, "the coordinator's tool hears the refusal, not the user");
});

test("a non-coordinator keeps no memory", () => {
  const state = workspace({ threads: [task("solo")] });
  for (const input of [
    { type: "memory.add", taskId: "solo", text: "Remember this" },
    { type: "memory.set-purpose", taskId: "solo", purpose: "Ship it" },
    { type: "coordination.remembered", taskId: "solo", change: { kind: "remember", text: "Remember this" } },
  ] satisfies WorkspaceInput[]) {
    const next = reduce(state, input);
    assert.equal(next.state.threads, state.threads);
    assert.notEqual(next.result?.ok, false);
  }
});

test("the user edits a coordinator's memory from its Overview", () => {
  const state = workspace({ threads: [lead("lead", { memory: { notes: [{ id: "n1", text: "Propose threads first", at: 1 }], revision: 1, heard: 1 } })], currentId: "lead" });
  const purposed = reduce(state, { type: "memory.set-purpose", taskId: "lead", purpose: "Ship the v2 reader" }).state;
  const added = reduce(purposed, { type: "memory.add", taskId: "lead", text: "Use Sonnet for docs" }).state;
  const edited = reduce(added, { type: "memory.edit", taskId: "lead", noteId: "n1", text: "Propose threads before starting any" }).state;
  const forgot = reduce(edited, { type: "memory.forget", taskId: "lead", noteId: "n3" }).state;
  assert.deepEqual(deriveView(forgot).coordination.memory, { purpose: "Ship the v2 reader", notes: [{ id: "n1", text: "Propose threads before starting any", at: required(forgot.threads[0].memory).notes[0]!.at }] });
  assert.equal(forgot.threads[0].memory?.heard, 1, "the coordinator's session has yet to read what the user changed");
  const cleared = reduce(forgot, { type: "memory.set-purpose", taskId: "lead", purpose: "  " }).state;
  assert.equal(cleared.threads[0].memory?.purpose, undefined, "an empty purpose clears it");
  assert.equal(reduce(cleared, { type: "memory.set-purpose", taskId: "lead", purpose: null }).state.threads, cleared.threads, "an unchanged purpose writes nothing");

  const long = reduce(state, { type: "memory.add", taskId: "lead", text: "x".repeat(501) });
  assert.equal(long.result?.ok, false);
  assert.equal(long.state.actionError, "A note can be at most 500 characters.");
  assert.equal(reduce(state, { type: "memory.set-purpose", taskId: "lead", purpose: "x".repeat(201) }).state.actionError, "A purpose can be at most 200 characters.");
  assert.equal(reduce(state, { type: "memory.edit", taskId: "lead", noteId: "n1", text: " " }).result?.ok, false, "an empty note is refused");
});

test("a thread a coordinator starts reads its purpose and memory as they stood", () => {
  const memory = { purpose: "Ship the v2 reader", notes: [{ id: "n1", text: "Use Sonnet for docs", at: 1 }], revision: 1, heard: 1 };
  const state = workspace({ threads: [lead("lead", { memory }), task("worker", { parentId: "lead" })] });
  const sending = reduce(state, { type: "task.send", text: "Fix it", coordinatorId: "lead", brief: BRIEF });
  const edited = reduce(sending.state, { type: "memory.add", taskId: "lead", text: "Added after it started" }).state;
  const run = reduce(edited, { type: "run.resolved", pendingId: effectAt(sending, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const prompt = effectAt(run, "start-run").command.prompt;
  assert.match(prompt, /Delivers: Pull request\n\nThe coordinator's purpose: Ship the v2 reader\nWhat the coordinator keeps in memory:\n- \[n1\] Use Sonnet for docs/, "the memory follows the brief");
  assert.doesNotMatch(prompt, /Added after it started/, "later edits are not sent to a thread already started");

  const fromMember = started(state, { type: "task.send", text: "Check the docs", coordinatorId: "lead", from: "worker" });
  assert.match(fromMember.prompt, /Check the docs\n\n---\nThe coordinator's purpose: Ship the v2 reader/, "a thread one of its threads starts reads the memory on its own");
  assert.doesNotMatch(fromMember.prompt, /Brief from the coordinator/);

  const moved = reduce(workspace({ threads: [lead("lead", { memory }), task("solo")] }), { type: "task.set-coordinator", taskId: "solo", coordinatorId: "lead" }).state;
  assert.doesNotMatch(started(moved, { type: "task.send", taskId: "solo", text: "Carry on" }).prompt, /coordinator's purpose/, "a thread moved under it by hand is told nothing");
});

test("a coordinator reads its memory again only after the user changes it, after a compaction, or in a fresh session", () => {
  const memory = { purpose: "Ship the v2 reader", notes: [{ id: "n1", text: "Propose threads first", at: 1 }], revision: 1, heard: 1 };
  const warm = workspace({ threads: [lead("lead", { ...SESSION, memory })], currentId: "lead" });
  assert.doesNotMatch(started(warm, { type: "task.send", taskId: "lead", text: "Next?" }).prompt, /Your memory/, "a session that read it is not sent it again");

  const edited = reduce(warm, { type: "memory.edit", taskId: "lead", noteId: "n1", text: "Propose threads before starting any" }).state;
  const told = started(edited, { type: "task.send", taskId: "lead", text: "Next?" });
  assert.match(told.prompt, /Your purpose: Ship the v2 reader\nYour memory \(the user changed it since you last read it\):\n- \[n1\] Propose threads before starting any/);
  assert.equal(told.state.threads[0].memory?.heard, 2);
  const settledRun = { ...told.state, activeRuns: {}, runStatuses: {} };
  assert.doesNotMatch(started(settledRun, { type: "task.send", taskId: "lead", text: "And now?" }).prompt, /Your memory/, "read once, it is not sent on the following run");

  const cleared = started(reduce(warm, { type: "memory.set-purpose", taskId: "lead", purpose: null }).state, { type: "task.send", taskId: "lead", text: "Next?" });
  assert.match(cleared.prompt, /Your purpose: none\nYour memory \(the user changed it since you last read it\):/, "a purpose taken off is said to be gone");
  const reread = reduce({ ...cleared.state, activeRuns: {}, runStatuses: {} }, { type: "memory.edit", taskId: "lead", noteId: "n1", text: "Propose threads first, always" }).state;
  assert.doesNotMatch(started(reread, { type: "task.send", taskId: "lead", text: "And now?" }).prompt, /Your purpose/, "a purpose it already knows is gone is not mentioned again");

  const own = reduce(warm, { type: "coordination.remembered", taskId: "lead", change: { kind: "remember", text: "Keep updates short" } }).state;
  assert.doesNotMatch(started(own, { type: "task.send", taskId: "lead", text: "Next?" }).prompt, /Your memory/, "its own writes count as read");

  const compacted = workspace({ threads: [lead("lead", { ...SESSION, memory: { ...memory, heard: undefined } })], currentId: "lead" });
  assert.match(started(compacted, { type: "task.send", taskId: "lead", text: "Next?" }).prompt, /Your memory:\n- \[n1\] Propose threads first/);

  const fresh = workspace({ threads: [lead("lead", { memory })], currentId: "lead" });
  const first = started(fresh, { type: "task.send", taskId: "lead", text: "Plan it" });
  assert.match(first.prompt, /Your purpose: Ship the v2 reader\nYour memory:\n- \[n1\] Propose threads first/, "a coordinator with no session to resume always reads it");
  assert.doesNotMatch(first.prompt, /the user changed it/);
  assert.match(coordinationContext(warm, warm.threads[0], { fresh: true }), /Your memory:/, "so does a fresh session started over an old one");
});

/** A thread under the coordinator that has finished, with what its run and a finding left behind. */
function finished(id = "worker", overrides = {}) {
  return task(id, { parentId: "lead", title: "Fix login", outcome: "finished" as const, outcomeUnread: true as const, findings: [{ id: "f1", headline: "Found it", at: 1 }], ...overrides });
}

test("the user resolves and reopens a thread, and a message reopens it but a scheduled tick does not", () => {
  const state = workspace({ threads: [lead(), finished()], currentId: "lead" });
  const resolved = reduce(state, { type: "task.resolve", taskId: "worker" }).state;
  const worker = required(resolved.threads[1]);
  assert.equal(typeof worker.resolvedAt, "number");
  assert.equal(worker.outcome, undefined, "its last run is filed away with it");
  assert.equal(worker.findings, undefined);
  assert.equal(deriveView(resolved).coordination.members[0]?.status, "resolved");
  assert.equal(reduce(resolved, { type: "task.resolve", taskId: "worker" }).state, resolved, "resolving twice changes nothing");

  const reopened = reduce(resolved, { type: "task.reopen", taskId: "worker" }).state;
  assert.equal(reopened.threads[1].resolvedAt, undefined);

  const messaged = started(resolved, { type: "task.send", taskId: "worker", text: "One more thing" }).state;
  assert.equal(messaged.threads.find((thread) => thread.id === "worker")?.resolvedAt, undefined, "a message is more work, so the thread is open again");

  const fired = reduce(resolved, { type: "automation.fired", fire: { automationId: "automation-1", taskId: "worker", runId: "run-tick", prompt: "Poll", runNumber: 2 } });
  const ticking = reduce(fired.state, { type: "run.resolved", pendingId: effectAt(fired, "resolve-run-workspace").pendingId, workspace: PROJECTLESS }).state;
  assert.equal(typeof ticking.threads[1].resolvedAt, "number", "a scheduled tick leaves it resolved");
  assert.equal(deriveView(ticking).coordination.members[0]?.status, "working", "while it works it shows as working");

  const moved = reduce(resolved, { type: "task.set-coordinator", taskId: "worker", coordinatorId: null }).state;
  assert.equal(moved.threads[1].resolvedAt, undefined, "a thread moved out from under its coordinator leaves its resolution behind");
  const other = reduce(workspace({ threads: [...resolved.threads, lead("other")] }), { type: "task.set-coordinator", taskId: "worker", coordinatorId: "other" }).state;
  assert.equal(other.threads[1].resolvedAt, undefined, "and so does one moved under another");

  const solo = workspace({ threads: [task("solo", { outcome: "finished" })] });
  assert.equal(reduce(solo, { type: "task.resolve", taskId: "solo" }).state, solo, "only a thread under a coordinator resolves");
});

test("a thread that is working or waiting on the user cannot be resolved", () => {
  const decision = { id: "d1", question: "Keep it?", options: [], raisedAt: 1 };
  const state = workspace({
    threads: [lead(), finished("busy"), finished("approval"), finished("asking", { decisions: [decision] })],
    activeRuns: { busy: activeRun("busy", "run-b"), approval: activeRun("approval", "run-a", { status: "awaiting-approval" }) },
  });
  for (const taskId of ["busy", "approval", "asking"]) {
    const refused = reduce(state, { type: "task.resolve", taskId });
    assert.equal(refused.result?.ok, false, taskId);
    assert.equal(refused.result?.ok === false && refused.result.message, "Finish or answer what this thread is waiting on first.");
    assert.equal(refused.state.threads, state.threads, taskId);
  }
});

test("a resolved thread no longer promotes its coordinator", () => {
  const state = workspace({ threads: [lead(), finished()] });
  const before = coordinationSections(state.threads, new Set(), new Set());
  assert.deepEqual(before.priority.map((thread) => thread.id), ["lead"], "a finished thread holds its coordinator up");
  const resolved = reduce(state, { type: "task.resolve", taskId: "worker" }).state;
  const after = coordinationSections(resolved.threads, new Set(), new Set());
  assert.deepEqual(after.priority.map((thread) => thread.id), []);

  const fired = reduce(resolved, { type: "automation.fired", fire: { automationId: "automation-1", taskId: "worker", runId: "run-tick", prompt: "Poll", runNumber: 2 } });
  const ticking = reduce(fired.state, { type: "run.resolved", pendingId: effectAt(fired, "resolve-run-workspace").pendingId, workspace: PROJECTLESS }).state;
  const surfaced = reduce(ticking, correlatedRunEvent("worker", "run-tick", 1, { type: "run.status", status: "succeeded" })).state;
  assert.equal(required(surfaced.threads[1]).outcome, "finished", "a tick that surfaces still leaves its verdict");
  assert.deepEqual(coordinationSections(surfaced.threads, new Set(), new Set()).priority.map((thread) => thread.id), [], "but a resolved thread is not one to lead with");
});

test("the roster lists what needs attention and counts the rest", () => {
  const done = Array.from({ length: 13 }, (_, index) => task(`done-${index}`, { parentId: "lead", title: `Done ${index}`, report: { state: "done" as const, summary: "Shipped", at: 1 }, runEndedAt: 100 + index }));
  const resolved = Array.from({ length: 2 }, (_, index) => task(`resolved-${index}`, { parentId: "lead", title: `Resolved ${index}`, resolvedAt: 1 }));
  const state = workspace({
    threads: [
      lead(),
      task("asking", { parentId: "lead", title: "Asking", decisions: [{ id: "d1", question: "Keep it?", options: [], raisedAt: 1 }] }),
      task("busy", { parentId: "lead", title: "Busy" }),
      task("review", { parentId: "lead", title: "Review", brief: BRIEF, pullRequest: { number: 212, url: "https://github.com/o/r/pull/212", title: "Fix it", state: "open", checks: "passing" } }),
      ...done,
      ...resolved,
    ],
    activeRuns: { busy: activeRun("busy", "run-b") },
  });
  const context = coordinationContext(state, state.threads[0]);
  assert.match(context, /"Asking" \[asking\] · idle · waiting on the user to decide: Keep it\?/);
  assert.match(context, /"Busy" \[busy\] · working/);
  assert.match(context, /"Review" \[review\] · idle · ready for review: #212 · Checks passing/);
  assert.match(context, /"Done 12" \[done-12\]/);
  assert.match(context, /"Done 3" \[done-3\]/, "the ten most recently active done threads are listed");
  assert.doesNotMatch(context, /"Done 2" \[done-2\]/);
  assert.doesNotMatch(context, /Resolved 0/);
  assert.match(context, /3 more finished and 2 resolved threads; read_thread reaches them\./);

  const one = workspace({ threads: [lead(), resolved[0]!] });
  assert.match(coordinationContext(one, one.threads[0]), /1 resolved thread; read_thread reaches it\./);
});

const OWN_PULL_REQUEST: PullRequestLink = { number: 212, url: "https://github.com/o/r/pull/212", title: "Fix it", state: "open" };

/** What a thread delivering a pull request is offered next, with its pull request standing as `link` says. */
function offered(link: Partial<PullRequestLink> | null, status: CoordinatedThreadStatus = "review", checkout: PullRequestAnswer | null = null) {
  const member = task("worker", { parentId: "lead", brief: BRIEF, ...(link ? { pullRequest: { ...OWN_PULL_REQUEST, ...link } } : {}) });
  return nextSteps(member, status, checkout);
}

test("a thread is offered the next steps its own pull request needs, most pressing first", () => {
  assert.deepEqual(offered({ conflicts: true, checks: "failing", review: "changes-requested" }), ["resolve-conflicts", "fix-ci", "address-comments"]);
  assert.deepEqual(offered({ checks: "failing" }), ["fix-ci"]);
  assert.deepEqual(offered({ review: "changes-requested", checks: "passing" }), ["address-comments"]);
  assert.deepEqual(offered({ review: "approved", checks: "passing" }), ["merge"], "approved and passing can merge");
  assert.deepEqual(offered({}), ["merge"], "a pull request no review is asked of can merge");
  assert.deepEqual(offered({ review: "required", checks: "passing" }), [], "one still waiting on a review cannot");
  assert.deepEqual(offered({ checks: "pending" }), [], "nor one whose checks are still going");
  assert.deepEqual(offered({ conflicts: true }), ["resolve-conflicts"]);
  assert.deepEqual(offered({ state: "draft", checks: "failing" }, "done"), ["fix-ci"], "a draft is fixed but never merged");
  assert.deepEqual(offered({ state: "draft" }, "done"), []);
  assert.deepEqual(offered({ state: "merged" }, "done"), [], "a merged pull request needs nothing more");
  for (const status of ["working", "approval", "asking", "resolved"] as const) {
    assert.deepEqual(offered({ checks: "failing" }, status), [], `nothing while it is ${status}`);
  }
  assert.deepEqual(offered({ checks: "failing" }, "blocked"), ["fix-ci"], "a thread that stopped on something can still be told what to do");

  assert.deepEqual(offered(null, "done"), [], "no pull request yet, and GitHub has not been asked");
  assert.deepEqual(offered(null, "done", { status: "none" }), ["create-pull-request"], "GitHub said it has none");
  assert.deepEqual(offered(null, "done", { status: "gh-missing" }), [], "nothing can be asked without gh");
  assert.deepEqual(offered(null, "working", { status: "none" }), []);
  const reporting = task("worker", { parentId: "lead", brief: { ...BRIEF, delivers: "report" } });
  assert.deepEqual(nextSteps(reporting, "done", { status: "none" }), [], "a thread that delivers a report is never asked for a pull request");
  assert.deepEqual(NEXT_STEPS.map(({ label }) => label), ["Resolve conflicts", "Fix CI", "Address comments", "Merge it", "Create PR"]);
});

test("a next step reaches the thread as the user's own message", () => {
  const failing = task("worker", { parentId: "lead", title: "Fix login", brief: BRIEF, pullRequest: { ...OWN_PULL_REQUEST, checks: "failing" } });
  const state = workspace({ threads: [lead(), failing], currentId: "lead" });
  assert.deepEqual(deriveView(state).coordination.members[0]?.steps, ["fix-ci"]);

  const stepping = reduce(state, { type: "coordination.next-step", taskId: "worker", step: "fix-ci" });
  const run = reduce(stepping.state, { type: "run.resolved", pendingId: effectAt(stepping, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const message = required(run.state.threads.find((thread) => thread.id === "worker")?.messages.at(-1));
  assert.equal(message.text, "The pull request's checks are failing. Find out why, fix them, and push.");
  assert.equal(message.origin, undefined, "the step is the user's word, not the coordinator's");
  assert.equal(effectAt(run, "start-run").command.taskId, "worker");

  const again = reduce(stepping.state, { type: "coordination.next-step", taskId: "worker", step: "fix-ci" });
  assert.equal(again.result?.ok === false && again.result.message, "That step is no longer offered.", "a thread already on its way is not told twice");
  assert.equal(again.state.pendingRuns, stepping.state.pendingRuns);

  const merging = reduce(state, { type: "coordination.next-step", taskId: "worker", step: "merge" });
  assert.equal(merging.result?.ok === false && merging.result.message, "That step is no longer offered.", "failing checks cannot be merged");
  assert.deepEqual(merging.effects, []);

  const solo = workspace({ threads: [{ ...failing, parentId: undefined }] });
  assert.equal(reduce(solo, { type: "coordination.next-step", taskId: "worker", step: "fix-ci" }).result?.ok, false, "only a thread under a coordinator takes a next step");
  const archived = reduce(workspace({ threads: [lead(), { ...failing, archivedAt: 5 }] }), { type: "coordination.next-step", taskId: "worker", step: "fix-ci" });
  assert.equal(archived.result?.ok, false, "an archived thread has left its coordinator's cards");
  assert.deepEqual(archived.effects, []);

  const waiting = workspace({ threads: [lead(), { ...failing, limitPause: { resetsAt: Date.now() + 86_400_000, window: "weekly", pausedAt: 1 } }] });
  const held = reduce(waiting, { type: "coordination.next-step", taskId: "worker", step: "fix-ci" });
  assert.deepEqual(held.state.queuedMessages.worker?.map(({ text, origin }) => [text, origin]), [["The pull request's checks are failing. Find out why, fix them, and push.", undefined]], "a thread waiting out its limit holds it as it would any message");
});
