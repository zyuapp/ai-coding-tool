import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";
import { reduce } from "../dist/main/application/workspace-reducer.js";
import { emptyWorkspaceState } from "../dist/main/application/workspace-state.js";
import { activitySections } from "../dist/main/application/task-order.js";
import { automationRunPrompt } from "../dist/main/application/task-workspace.js";
import { automationAfterRun } from "../dist/main/domain/automation.js";
import { threadActivityAt } from "../dist/main/domain/task.js";

const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
const { AutomationPanel, automationMeta, lastRunLabel } = await vite.ssrLoadModule("/src/renderer/components/AutomationPanel.tsx");
const { answerThreadRequest } = await vite.ssrLoadModule("/src/renderer/task-workspace/thread-requests.ts");
const { ProjectSidebar } = await vite.ssrLoadModule("/src/renderer/components/ProjectSidebar.tsx");
test.after(async () => { await vite.close(); });

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

function workspace(overrides = {}) {
  return { ...emptyWorkspaceState(), ...overrides };
}

const PROJECTLESS = { id: "projectless", kind: "projectless", root: "/tmp" };

/** Runs a tick all the way to its start, which is where the run's provenance is settled. */
function fire(overrides = {}) {
  const tick = { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2, ...overrides };
  const pending = reduce(workspace({ tasks: [task("task-a")] }), { type: "automation.fired", fire: tick });
  return reduce(pending.state, { type: "run.resolved", pendingId: pending.effects[0].pendingId, workspace: PROJECTLESS });
}

test("a scheduled run is the scheduler's, unattended, and never quiet unless the tick says so", () => {
  const started = fire();

  assert.equal(started.effects[0].command.unattended, true, "nobody is watching a tick, so it may answer its own approvals");
  assert.deepEqual(started.state.activeRuns["task-a"], {
    taskId: "task-a",
    runId: "run-1",
    sequence: 0,
    status: "running",
    origin: "automation",
    quiet: false,
    notified: false,
    reportedNothing: false,
    messagesBefore: 1,
  });
  assert.equal(fire({ quiet: true }).state.activeRuns["task-a"].quiet, true);
});

test("a run the user sent is theirs, and nothing about it is inferred as quiet or unattended", () => {
  const drafted = reduce(workspace(), { type: "view.set-prompt", prompt: "Inspect the app" }).state;
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: sending.effects[0].pendingId, workspace: PROJECTLESS });

  const [{ command }] = started.effects;
  assert.equal(command.unattended, undefined);
  const active = started.state.activeRuns[command.taskId];
  assert.deepEqual([active.origin, active.quiet, active.notified, active.reportedNothing], ["composer", false, false, false]);
});

test("a turn the agent starts for itself belongs to the composer rather than to the scheduler", () => {
  const opened = reduce(workspace({ tasks: [task("task-a")] }), {
    type: "run.event",
    event: { type: "run.started", taskId: "task-a", runId: "run-x", sequence: 1, agentInitiated: true },
  });

  assert.equal(opened.state.activeRuns["task-a"].origin, "composer");
  assert.equal(opened.state.activeRuns["task-a"].quiet, false);
});

test("a human steering into a scheduled run takes it over", () => {
  const scheduled = workspace({
    tasks: [task("task-a")],
    currentId: "task-a",
    activeRuns: { "task-a": { taskId: "task-a", runId: "run-a", sequence: 0, status: "running", origin: "automation", quiet: true, notified: false, reportedNothing: false } },
    runStatuses: { "task-a": "running" },
  });
  const queued = reduce(reduce(scheduled, { type: "view.set-prompt", prompt: "What did you find?" }).state, { type: "task.send", attachments: [] }).state;
  const [message] = queued.queuedMessages["task-a"];

  const steered = reduce(queued, { type: "task.steer-queued", messageId: message.id });
  assert.equal(steered.state.activeRuns["task-a"].origin, "composer", "an answer is owed to whoever asked");

  const delivered = reduce(queued, {
    type: "run.event",
    event: { type: "queued.delivered", taskId: "task-a", runId: "run-a", sequence: 1, messageId: message.id },
  });
  assert.equal(delivered.state.activeRuns["task-a"].origin, "composer");
});

test("what the automation last did names the moment of the status, not of the last run", () => {
  const at = Date.parse("2026-08-17T09:00:00Z");
  const clock = (moment) => new Date(moment).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const automation = { runCount: 2, lastRunAt: at - 600_000, lastStatusAt: at - 600_000, lastStatus: "succeeded" };

  assert.equal(lastRunLabel({ runCount: 0 }, at), "never run");
  assert.equal(lastRunLabel(automation, at), `succeeded at ${clock(at - 600_000)}`);
  /** A skip moves the status without running, so the clock follows the skip rather than the run. */
  assert.equal(lastRunLabel({ ...automation, lastStatus: "skipped", lastStatusAt: at - 60_000 }, at), `skipped at ${clock(at - 60_000)}`);
  assert.match(lastRunLabel({ ...automation, lastStatusAt: at - 3 * 86_400_000 }, at), /succeeded at \w+ \d+/, "days back, a bare clock time would read as today");
});

/** A thread mid-tick, with the provenance the scheduler gave the run. */
function midRun(run = {}, taskOverrides = {}) {
  return workspace({
    tasks: [task("task-a", {
      createdAt: 10,
      messages: [{ id: "label", kind: "user", text: "Poll", detail: "Automation run #2", quiet: true, at: 10 }],
      ...taskOverrides,
    })],
    activeRuns: { "task-a": { taskId: "task-a", runId: "run-1", sequence: 0, status: "running", origin: "automation", quiet: true, notified: false, reportedNothing: false, messagesBefore: 1, ...run } },
    runStatuses: { "task-a": "running" },
  });
}

const settleRun = (state, status = "succeeded", sequence = 5) => reduce(state, {
  type: "run.event",
  event: { type: "run.status", taskId: "task-a", runId: "run-1", sequence, status },
});

/** What the run said before it settled, said the way the agent's tools say it. */
const said = (state, input) => reduce(state, input).state;

test("only a quiet scheduled run that succeeded saying it found nothing settles unseen", () => {
  for (const origin of ["composer", "automation"]) {
    for (const quiet of [false, true]) {
      for (const status of ["succeeded", "failed", "cancelled"]) {
        for (const notified of [false, true]) {
          for (const reportedNothing of [false, true]) {
            const settled = settleRun(midRun({ origin, quiet, notified, reportedNothing }), status);
            const [thread] = settled.state.tasks;
            const row = `${origin} quiet=${quiet} ${status} notified=${notified} reportedNothing=${reportedNothing}`;
            const unseen = origin === "automation" && quiet && status === "succeeded" && reportedNothing && !notified;
            const expected = status === "cancelled" || unseen ? undefined : status === "succeeded" ? "finished" : "failed";
            assert.equal(thread.outcome, expected, row);
            assert.equal(thread.outcomeUnread, expected === undefined ? undefined : true, row);
            assert.equal(thread.runEndedAt === undefined, unseen, `${row}: only an unseen tick puts the thread's ending back`);
          }
        }
      }
    }
  }
});

test("a tick that surfaced nothing leaves the thread exactly where it stood", () => {
  const before = midRun({ reportedNothing: true }, { runEndedAt: 500 });
  const working = reduce(before, {
    type: "run.event",
    event: { type: "assistant.delta", taskId: "task-a", runId: "run-1", sequence: 2, messageId: "reply", text: "Datadog is clean." },
  }).state;
  const settled = settleRun(working).state;
  const [thread] = settled.tasks;

  assert.equal(thread.runEndedAt, 500, "the ending the last audible run stamped on is put back");
  assert.deepEqual(thread.messages.map((message) => message.quiet), [true, true], "everything the tick wrote is quiet, its own reply included");
  assert.equal(threadActivityAt(thread), 500, "so nothing about the thread moved");
  assert.deepEqual(activitySections(settled.tasks, new Set(), new Set()).threads.map((item) => item.id), ["task-a"]);
});

test("a quiet tick that found something bumps the thread and leads the list", () => {
  const raised = said(midRun(), { type: "automation.notify", taskId: "task-a", headline: "5xx on checkout" });
  const settled = settleRun(said(raised, { type: "automation.nothing-to-report", taskId: "task-a" })).state;
  const [thread] = settled.tasks;

  assert.equal(thread.outcome, "finished", "a run that spoke cannot be retracted into silence");
  assert.ok(thread.runEndedAt > 0);
  assert.equal(threadActivityAt(thread), thread.runEndedAt);
  assert.deepEqual(activitySections(settled.tasks, new Set(), new Set()).priority.map((item) => item.id), ["task-a"]);
});

test("what a run found outlives every run after it, unlike the verdict beside it", () => {
  const found = said(midRun(), { type: "automation.notify", taskId: "task-a", headline: "Disk at 91%", detail: "`/dev/disk1` is nearly full." });
  const settled = settleRun(found).state;
  assert.equal(settled.tasks[0].outcome, "finished");

  const again = reduce(settled, { type: "automation.fired", fire: { automationId: "automation-1", taskId: "task-a", runId: "run-2", prompt: "Poll", runNumber: 3 } });
  const started = reduce(again.state, { type: "run.resolved", pendingId: again.effects[0].pendingId, workspace: PROJECTLESS }).state;
  const [thread] = started.tasks;

  assert.equal(thread.outcome, undefined, "the next run supersedes the last one's verdict");
  assert.equal(thread.findings.length, 1, "and leaves what the last one found alone");
  assert.equal(thread.findings[0].headline, "Disk at 91%");
  assert.match(thread.messages.map((message) => message.text).join("\n"), /Disk at 91%/, "the finding is said in the thread as well");
});

test("landing on a thread reads its findings and keeps them; dismissing files them away", () => {
  const found = said(midRun(), { type: "automation.notify", taskId: "task-a", headline: "Two alerts firing" }).tasks[0];
  const holding = workspace({ tasks: [found] });

  assert.equal(activitySections(holding.tasks, new Set(), new Set()).priority.length, 1);
  const read = reduce(holding, { type: "task.select", taskId: "task-a" }).state;
  assert.deepEqual(read.tasks[0].findings.map((finding) => finding.read), [true], "seen, but still there");
  assert.equal(activitySections(read.tasks, new Set(), new Set()).priority.length, 1, "a read finding keeps its place");

  const dismissed = reduce(read, { type: "task.dismiss", taskId: "task-a" }).state;
  assert.equal(dismissed.tasks[0].findings, undefined);
  assert.deepEqual(activitySections(dismissed.tasks, new Set(), new Set()).threads.map((item) => item.id), ["task-a"]);
  assert.deepEqual(reduce(read, { type: "task.dismiss-all" }).state.tasks[0].findings, undefined, "dismissing everything reaches a thread with no verdict too");
});

test("a finding raised on the thread the user is watching is not marked unread", () => {
  const watched = { ...midRun(), currentId: "task-a", focused: true };
  const seen = said(watched, { type: "automation.notify", taskId: "task-a", headline: "Nothing they can miss" });
  assert.deepEqual(seen.tasks[0].findings.map((finding) => finding.read), [true]);

  const away = said({ ...watched, focused: false }, { type: "automation.notify", taskId: "task-a", headline: "Behind the browser" });
  assert.equal(away.tasks[0].findings[0].read, undefined);
});

test("a raised finding goes out to the desktop, and one the thread already carries does not", () => {
  const raised = reduce(midRun(), { type: "automation.notify", taskId: "task-a", headline: "5xx on checkout", key: "checkout" });
  assert.deepEqual(raised.effects, [{ type: "announce-finding", notice: { taskId: "task-a", title: "task-a", headline: "5xx on checkout" } }]);

  const again = reduce(raised.state, { type: "automation.notify", taskId: "task-a", headline: "5xx again", key: "checkout" });
  assert.deepEqual(again.effects, [], "nothing was written, so there is nothing to announce");

  const attended = reduce(midRun({ origin: "composer" }), { type: "automation.notify", taskId: "task-a", headline: "Ignore me" });
  assert.deepEqual(attended.effects, []);

  const watched = reduce({ ...midRun(), currentId: "task-a", focused: true }, { type: "automation.notify", taskId: "task-a", headline: "Right there" });
  assert.equal(watched.effects[0].type, "announce-finding", "main is the one that knows where the user is looking");
});

test("a turn that is not a scheduled run raises nothing at all", () => {
  const attended = midRun({ origin: "composer" });
  const asked = said(attended, { type: "automation.notify", taskId: "task-a", headline: "Ignore me" });
  assert.equal(asked.tasks[0].findings, undefined);
  assert.equal(asked.activeRuns["task-a"].notified, false);
  assert.equal(said(attended, { type: "automation.nothing-to-report", taskId: "task-a" }).activeRuns["task-a"].reportedNothing, false);
});

/** The window answering the two tools, which is where their wording is decided. */
function toolHost(initial) {
  let state = initial;
  return {
    state: () => state,
    dispatch: (input) => { state = reduce(state, input).state; },
    waiters: { current: [] },
    task: () => state.tasks[0],
    run: () => state.activeRuns["task-a"],
  };
}

const answer = async (host, request) => answerThreadRequest(host, { type: "thread.request", requestId: "r", taskId: "task-a", ...request });

test("notify accumulates, says how much the thread now carries, and never raises the same key twice", async () => {
  const host = toolHost(midRun());

  const first = await answer(host, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  assert.equal(first.ok, true);
  assert.equal(first.result.recorded, true);
  assert.match(first.result.note, /1 unread finding\b/);

  const second = await answer(host, { op: "notify", report: { headline: "Latency doubled", key: "latency" } });
  assert.match(second.result.note, /2 unread findings/, "a second finding is added, not swapped in");
  assert.deepEqual(host.task().findings.map((finding) => finding.headline), ["5xx on checkout", "Latency doubled"]);

  const repeat = await answer(host, { op: "notify", report: { headline: "5xx on checkout again", key: "checkout" } });
  assert.equal(repeat.result.recorded, false);
  assert.match(repeat.result.note, /already carries an unread finding keyed "checkout"/);
  assert.equal(host.task().findings.length, 2);
});

test("a run that has spoken cannot be talked back into silence", async () => {
  const host = toolHost(midRun());
  await answer(host, { op: "notify", report: { headline: "Something is on fire" } });

  const retracted = await answer(host, { op: "nothing-to-report", checked: "the alert feed" });
  assert.equal(retracted.result.recorded, false);
  assert.match(retracted.result.note, /already raised a finding/);
  assert.equal(host.run().notified, true);
  assert.equal(settleRun(host.state()).state.tasks[0].outcome, "finished");
});

test("nothing_to_report says what silence it bought, and buys none on a loud automation", async () => {
  const quiet = toolHost(midRun());
  const spoken = await answer(quiet, { op: "nothing-to-report", checked: "the last hour of logs" });
  assert.equal(spoken.result.recorded, true);
  assert.match(spoken.result.note, /settles without reaching the user/);
  assert.equal(quiet.run().reportedNothing, true);

  const loud = toolHost(midRun({ quiet: false }));
  const heard = await answer(loud, { op: "nothing-to-report", checked: "the last hour of logs" });
  assert.match(heard.result.note, /every run of it surfaces/);
  assert.equal(settleRun(loud.state()).state.tasks[0].outcome, "finished");
});

test("both tools teach rather than fail when the turn is nobody's schedule", async () => {
  const host = toolHost(midRun({ origin: "composer" }));

  for (const request of [{ op: "notify", report: { headline: "Found it" } }, { op: "nothing-to-report", checked: "everything" }]) {
    const answered = await answer(host, request);
    assert.equal(answered.ok, true, "an ordinary turn is not an error");
    assert.equal(answered.result.recorded, false);
    assert.match(answered.result.note, /not a scheduled run/);
  }
  assert.equal(host.task().findings, undefined);
});

test("a thread already full of unread findings fails the call rather than losing one, and still surfaces", async () => {
  const host = toolHost(midRun());
  for (let index = 0; index < 10; index += 1) await answer(host, { op: "notify", report: { headline: `Finding ${index}`, key: `k${index}` } });

  const over = await answer(host, { op: "notify", report: { headline: "One too many", key: "k10" } });
  assert.equal(over.ok, false, "a finding that cannot be kept is never quietly downgraded to nothing");
  assert.match(over.message, /already carrying 10 unread findings/);
  assert.equal(host.task().findings.length, 10);
  assert.equal(host.run().notified, true, "the run spoke, so it surfaces either way");
  assert.equal(settleRun(said(host.state(), { type: "automation.nothing-to-report", taskId: "task-a" })).state.tasks[0].outcome, "finished");
});

test("a quiet tick carries what it surfaces for, and the two tools that answer it, into its own prompt", () => {
  const loud = automationRunPrompt("Poll Datadog", 7);
  assert.match(loud, /automated run #7/);
  assert.doesNotMatch(loud, /notify/, "a loud automation is framed exactly as it always was");

  const quiet = automationRunPrompt("Poll Datadog", 7, "an error was caused by the user's own code.");
  assert.match(quiet, /automated run #7/);
  assert.match(quiet, /Surface it when: an error was caused by the user's own code\./);
  assert.match(quiet, /notify tool with a headline/);
  assert.match(quiet, /nothing_to_report/);
  assert.match(quiet, /Call neither and the run surfaces/);
});

test("a tick the scheduler said is quiet labels its own message quiet from the start", () => {
  const fired = reduce(workspace({ tasks: [task("task-a", { createdAt: 5, updatedAt: 5 })] }), {
    type: "automation.fired",
    fire: { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2, quiet: true, surfaceWhen: "there is an error." },
  });
  const started = reduce(fired.state, { type: "run.resolved", pendingId: fired.effects[0].pendingId, workspace: PROJECTLESS });
  const [label] = started.state.tasks[0].messages;

  assert.equal(label.quiet, true);
  assert.equal(threadActivityAt(started.state.tasks[0]), 5, "the label alone does not count as the thread doing something");
  assert.match(started.effects[0].command.prompt, /Surface it when: there is an error\./, "the tick's sentence reaches the run that has to honour it");
});

/** Fires a tick at a thread that cannot take it, with the scheduler's count of the ones before it. */
function declined(consecutiveDeclines) {
  const automation = { id: "automation-1", taskId: "task-a", prompt: "Poll", schedule: "* * * * *", paused: false, createdAt: 100, updatedAt: 100, runCount: 4, lastRunAt: 900, consecutiveDeclines };
  const busy = workspace({
    tasks: [task("task-a")],
    automations: [{ ...automation, nextRunAt: null }],
    activeRuns: { "task-a": { taskId: "task-a", runId: "other", sequence: 0, status: "running", origin: "composer", quiet: false, notified: false, reportedNothing: false, messagesBefore: 0 } },
    runStatuses: { "task-a": "running" },
  });
  return reduce(busy, { type: "automation.fired", fire: { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 5 } });
}

test("a schedule turned away three times running says so out loud on its thread", () => {
  for (const before of [0, 1]) {
    const early = declined(before);
    assert.deepEqual(early.effects.map((effect) => effect.type), ["automation.ack"], `${before} declines before is not yet worth saying`);
    assert.equal(early.state.tasks[0].findings, undefined);
  }

  const third = declined(2);
  assert.deepEqual(third.effects.map((effect) => effect.type), ["automation.ack", "announce-finding"]);
  assert.equal(third.effects[0].ack.started, false, "the tick is still turned away");
  const [finding] = third.state.tasks[0].findings;
  assert.match(finding.headline, /has not been able to run since/);
  assert.equal(finding.key, "declined:automation-1");
  assert.equal(third.effects[1].notice.headline, finding.headline);

  const fourth = declined(3);
  assert.equal(fourth.state.tasks[0].findings, undefined, "it is said once, not on every tick after");
});

test("what the scheduler counts about declines is reset by a run that actually happened", () => {
  const automation = { id: "a", taskId: "t", prompt: "p", schedule: "* * * * *", paused: false, createdAt: 1, updatedAt: 1, runCount: 2 };

  const once = automationAfterRun(automation, "skipped", 10);
  assert.equal(once.consecutiveDeclines, 1);
  assert.equal(once.runCount, 2, "a tick that never ran is not a run");
  assert.equal(automationAfterRun(once, "skipped", 20).consecutiveDeclines, 2);
  assert.equal(automationAfterRun(once, "succeeded", 30).consecutiveDeclines, undefined);
  assert.equal(automationAfterRun(once, "failed", 30).consecutiveDeclines, undefined, "a run that failed still ran");
  assert.equal(automationAfterRun(once, "missed", 30).consecutiveDeclines, 1, "a one-shot whose moment passed was never turned away");
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "navigator", "innerWidth", "innerHeight"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
dom.window.Element.prototype.getAnimations = () => [];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
test.after(() => dom.window.close());

async function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function sidebar(overrides) {
  return React.createElement(ProjectSidebar, {
    open: true,
    inactive: false,
    projects: [{ id: "project-1", root: "/work/api" }],
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "activity",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onRenameTask() {}, onDismissTask() {}, onDismissAll() {},
    onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
    ...overrides,
  });
}

test("a priority row says what was found rather than where it lives and when it last moved", async () => {
  const found = task("task-a", {
    projectId: "project-1",
    findings: [{ id: "f1", headline: "Checkout is returning 5xx", at: 1 }],
  });
  const view = await mount(sidebar({ activityTasks: { priority: [found], running: [], threads: [] } }));

  assert.equal(view.container.querySelector(".task-row-text small").textContent, "Checkout is returning 5xx");
  assert.equal(view.container.querySelector(".task-attention").getAttribute("aria-label"), "Checkout is returning 5xx", "a screen reader hears the reason, not \"Finished\"");

  const read = { ...found, findings: [{ ...found.findings[0], read: true }] };
  await view.render(sidebar({ activityTasks: { priority: [read], running: [], threads: [] } }));
  assert.equal(view.container.querySelector(".task-attention"), null, "read takes the dot off");
  assert.match(view.container.querySelector(".task-row-text small").textContent, /^api · /, "and the row goes back to saying where it lives");
  await view.unmount();
});

test("priority says when it holds nothing, speaks its changes, and running does neither", async () => {
  const view = await mount(sidebar({}));

  const [priority, running] = [...view.container.querySelectorAll(".activity-group")];
  assert.equal(priority.querySelector(".sidebar-empty").textContent, "Nothing waiting");
  assert.equal(running.querySelector(".sidebar-empty"), null, "only priority has anything to say when empty");
  assert.equal(view.container.querySelector('[aria-label="Priority"]').getAttribute("aria-live"), "polite");
  assert.equal(view.container.querySelector('[aria-label="Running"]').getAttribute("aria-live"), null, "a spinner appearing is not news");
  await view.unmount();
});

test("the schedule mark and the dismiss button both say what state the schedule is in", async () => {
  const scheduled = task("task-a", { outcome: "finished", outcomeUnread: true });
  const marks = (schedule) => sidebar({
    activityTasks: { priority: [scheduled], running: [], threads: [] },
    schedules: new Map([["task-a", { paused: false, nextRunAt: 2, ...schedule }]]),
  });
  const view = await mount(marks({}));
  const label = () => view.container.querySelector(".task-automation").getAttribute("aria-label");

  assert.equal(label(), "Runs on a schedule");
  assert.equal(view.container.querySelector(".task-dismiss").getAttribute("aria-label"), "Dismiss task-a, which keeps running on its schedule");
  await view.render(marks({ paused: true }));
  assert.equal(label(), "Schedule paused");
  await view.render(marks({ nextRunAt: null }));
  assert.equal(label(), "Schedule missed its run");
  await view.render(marks({ lastStatus: "failed" }));
  assert.equal(label(), "Runs on a schedule, and its last run failed");
  await view.render(marks({ lastStatus: "skipped" }));
  assert.equal(label(), "Runs on a schedule, and its last tick could not run");
  await view.unmount();
});

test("the automation panel says whether the schedule is alive and whether it has ever found anything", async () => {
  const at = Date.parse("2026-08-17T09:00:00Z");
  const automation = { id: "a", taskId: "task-a", prompt: "Poll", schedule: "*/30 * * * *", paused: false, createdAt: 1, updatedAt: 1, runCount: 48, lastRunAt: at - 60_000, lastStatusAt: at - 60_000, lastStatus: "succeeded", nextRunAt: at + 60_000, overrunCount: 2 };

  assert.match(automationMeta(automation, null, at), /^48 runs · succeeded at .* · nothing found yet · 2 dropped for overrunning$/);
  assert.match(automationMeta(automation, { id: "f", headline: "5xx", at: at - 120_000 }, at), /found something /);
});

test("the panel shows what a quiet schedule surfaces for, and lets the user take the quiet away", async () => {
  const patches = [];
  const automation = { id: "a", taskId: "task-a", prompt: "Poll", schedule: "*/30 * * * *", paused: false, createdAt: 1, updatedAt: 1, runCount: 3, nextRunAt: Date.now() + 60_000 };
  const panel = (surfaceWhen) => React.createElement(AutomationPanel, {
    automation: surfaceWhen === undefined ? automation : { ...automation, surfaceWhen },
    lastFinding: null,
    onUpdate: (patch) => patches.push(patch),
    onDelete() {}, onRunNow() {},
  });

  const view = await mount(panel(undefined));
  const toggle = () => view.container.querySelector(".automation-quiet");
  assert.equal(toggle().getAttribute("aria-pressed"), "false");
  assert.equal(view.container.querySelector(".automation-quiet-sentence"), null);
  await act(async () => { toggle().click(); });
  assert.match(patches[0].surfaceWhen, /finds something/);

  await view.render(panel("an error was caused by the user's own code."));
  assert.equal(toggle().getAttribute("aria-pressed"), "true");
  assert.equal(view.container.querySelector(".automation-quiet-sentence").textContent, "Surfaces when: an error was caused by the user's own code.");
  await act(async () => { toggle().click(); });
  assert.deepEqual(patches[1], { surfaceWhen: "" }, "an empty sentence is what makes it loud again");
  await view.unmount();
});
