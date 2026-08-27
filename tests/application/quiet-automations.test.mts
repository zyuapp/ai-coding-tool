import assert from "node:assert/strict";
import { test, afterAll } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { whyTickCannotRun } from "../../src/application/findings.ts";
import { whyRunSurfaces } from "../../src/application/run-testimony.ts";
import { reduce, type WorkspaceEffect, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { activitySections } from "../../src/application/task-order.ts";
import { automationRunPrompt, type ActiveRun } from "../../src/application/task-workspace.ts";
import type { AutomationFire, RunEvent } from "../../src/contracts/ipc.ts";
import type { FindingReport, FindingResult, ThreadRequest } from "../../src/contracts/threads.ts";
import { isNews, issueState } from "../../src/domain/attention.ts";
import { automationAfterRun, type AutomationPatch, type AutomationView } from "../../src/domain/automation.ts";
import { threadActivityAt, type Task, type TaskFinding } from "../../src/domain/task.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { AutomationPanelProps } from "../../src/renderer/components/AutomationPanel.tsx";
import type { ProjectSidebarProps } from "../../src/renderer/components/ProjectSidebar.tsx";
import type { ThreadRequestHost } from "../../src/renderer/task-workspace/thread-requests.ts";

const { AutomationPanel, automationMeta, lastRunLabel } = await import("../../src/renderer/components/AutomationPanel.tsx");
const { answerThreadRequest } = await import("../../src/renderer/task-workspace/thread-requests.ts");
const { ProjectSidebar } = await import("../../src/renderer/components/ProjectSidebar.tsx");

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return { ...emptyWorkspaceState(), ...overrides };
}

function activeRun(overrides: Partial<ActiveRun> = {}): ActiveRun {
  return {
    taskId: "task-a",
    runId: "run-1",
    sequence: 0,
    status: "running",
    origin: "automation",
    quiet: true,
    notified: false,
    acknowledged: false,
    reportedIssues: [],
    messagesBefore: 1,
    before: { updatedAt: 1 },
    ...overrides,
  };
}

function automationView(overrides: Partial<AutomationView> = {}): AutomationView {
  return {
    id: "automation-1",
    taskId: "task-a",
    prompt: "Poll",
    schedule: "* * * * *",
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    runCount: 0,
    nextRunAt: null,
    ...overrides,
  };
}

function effectAt<T extends WorkspaceEffect["type"]>(effects: WorkspaceEffect[], index: number, type: T): Extract<WorkspaceEffect, { type: T }> {
  const effect = effects[index];
  assert.equal(effect?.type, type);
  return effect as Extract<WorkspaceEffect, { type: T }>;
}

function findingsOf(value: Task): TaskFinding[] {
  assert.ok(value.findings);
  return value.findings;
}

function item<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

const PROJECTLESS: WorkspaceRecord = { id: "projectless", kind: "projectless", root: "/tmp" };

/** Runs a tick all the way to its start, which is where the run's provenance is settled. */
function fire(overrides: Partial<AutomationFire> = {}) {
  const tick: AutomationFire = { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2, unattended: true, ...overrides };
  const pending = reduce(workspace({ tasks: [task("task-a")] }), { type: "automation.fired", fire: tick });
  return reduce(pending.state, { type: "run.resolved", pendingId: effectAt(pending.effects, 0, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
}

test("a scheduled run is the scheduler's, unattended, and never quiet unless the tick says so", () => {
  const started = fire();

  assert.equal(effectAt(started.effects, 0, "start-run").command.unattended, true, "nobody is watching a tick, so it may answer its own approvals");
  assert.deepEqual(started.state.activeRuns["task-a"], {
    taskId: "task-a",
    runId: "run-1",
    sequence: 0,
    status: "running",
    origin: "automation",
    quiet: false,
    notified: false,
    acknowledged: false,
    reportedIssues: [],
    messagesBefore: 1,
    before: { updatedAt: 1 },
  });
  assert.equal(fire({ quiet: true }).state.activeRuns["task-a"].quiet, true);
});

test("a tick the user pressed the button for is watched, so its approvals stay theirs to answer", () => {
  const pressed = fire({ unattended: undefined });

  assert.equal(effectAt(pressed.effects, 0, "start-run").command.unattended, undefined);
});

test("a run the user sent is theirs, and nothing about it is inferred as quiet or unattended", () => {
  const drafted = reduce(workspace(), { type: "view.set-prompt", prompt: "Inspect the app" }).state;
  const sending = reduce(drafted, { type: "task.send", attachments: [] });
  const started = reduce(sending.state, { type: "run.resolved", pendingId: effectAt(sending.effects, 0, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });

  const { command } = effectAt(started.effects, 0, "start-run");
  assert.equal(command.unattended, undefined);
  const active = started.state.activeRuns[command.taskId];
  assert.deepEqual([active.origin, active.quiet, active.notified, active.acknowledged], ["composer", false, false, false]);
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
    activeRuns: { "task-a": activeRun({ runId: "run-a" }) },
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
  const clock = (moment: number) => new Date(moment).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const automation = automationView({ runCount: 2, lastRunAt: at - 600_000, lastStatusAt: at - 600_000, lastStatus: "succeeded" });

  assert.equal(lastRunLabel(automationView(), at), "never run");
  assert.equal(lastRunLabel(automation, at), `succeeded at ${clock(at - 600_000)}`);
  /** A skip moves the status without running, so the clock follows the skip rather than the run. */
  assert.equal(lastRunLabel({ ...automation, lastStatus: "skipped", lastStatusAt: at - 60_000 }, at), `skipped at ${clock(at - 60_000)}`);
  assert.match(lastRunLabel({ ...automation, lastStatusAt: at - 3 * 86_400_000 }, at), /succeeded at \w+ \d+/, "days back, a bare clock time would read as today");
});

/** A thread mid-tick, with the provenance the scheduler gave the run. */
function midRun(run: Partial<ActiveRun> = {}, taskOverrides: Partial<Task> = {}): WorkspaceState {
  const started = task("task-a", {
    createdAt: 10,
    messages: [{ id: "label", kind: "user", text: "Poll", detail: "Automation run #2", withdrawn: true, at: 10 }],
    ...taskOverrides,
  });
  /** What the tick found the thread looking like, which is what an unseen one puts back. */
  const before = {
    updatedAt: started.updatedAt,
    ...(started.runEndedAt === undefined ? {} : { runEndedAt: started.runEndedAt }),
    ...(started.outcome === undefined ? {} : { outcome: started.outcome }),
    ...(started.outcomeUnread ? { outcomeUnread: true as const } : {}),
  };
  return workspace({
    tasks: [started],
    activeRuns: { "task-a": activeRun({ before, ...run }) },
    runStatuses: { "task-a": "running" },
  });
}

type RunStatusEvent = Extract<RunEvent, { type: "run.status" }>;

const settleRun = (state: WorkspaceState, status: RunStatusEvent["status"] = "succeeded", sequence = 5) => reduce(state, {
  type: "run.event",
  event: { type: "run.status", taskId: "task-a", runId: "run-1", sequence, status },
});

/** What the run said before it settled, said the way the agent's tools say it. */
const said = (state: WorkspaceState, input: WorkspaceInput) => reduce(state, input).state;

test("only a quiet scheduled run that succeeded saying it found nothing settles unseen", () => {
  for (const origin of ["composer", "automation"] as const) {
    for (const quiet of [false, true]) {
      for (const status of ["succeeded", "failed", "cancelled"] as const) {
        for (const notified of [false, true]) {
          for (const acknowledged of [false, true]) {
            const settled = settleRun(midRun({ origin, quiet, notified, acknowledged }), status);
            const [thread] = settled.state.tasks;
            const row = `${origin} quiet=${quiet} ${status} notified=${notified} acknowledged=${acknowledged}`;
            const unseen = origin === "automation" && quiet && status === "succeeded" && acknowledged && !notified;
            const expected = unseen ? undefined : status === "succeeded" ? "finished" : status === "failed" ? "failed" : "stopped";
            assert.equal(thread.outcome, expected, row);
            assert.equal(thread.outcomeUnread, expected === undefined ? undefined : true, row);
            assert.equal(thread.runEndedAt === undefined, unseen, `${row}: only an unseen tick puts the thread's ending back`);
          }
        }
      }
    }
  }
});

test("a run that surfaces says which one thing broke its silence", () => {
  const tick = activeRun({ acknowledged: true });
  const ending = (status: RunStatusEvent["status"]): RunStatusEvent => ({ type: "run.status", taskId: "task-a", runId: "run-1", sequence: 5, status });

  assert.equal(whyRunSurfaces(tick, ending("succeeded")), null, "it looked, it answered, and it found nothing");
  assert.equal(whyRunSurfaces(tick, ending("failed")), "failed");
  assert.equal(whyRunSurfaces(tick, ending("cancelled")), "cancelled");
  assert.equal(whyRunSurfaces({ ...tick, origin: "composer" }, ending("succeeded")), "attended");
  assert.equal(whyRunSurfaces({ ...tick, quiet: false }, ending("succeeded")), "loud");
  assert.equal(whyRunSurfaces({ ...tick, acknowledged: false }, ending("succeeded")), "no-answer");
  assert.equal(whyRunSurfaces({ ...tick, notified: true }, ending("succeeded")), "reported");
});

test("a tick that surfaced nothing leaves the thread exactly where it stood", () => {
  const before = midRun({ acknowledged: true }, { runEndedAt: 500 });
  const working = reduce(before, {
    type: "run.event",
    event: { type: "assistant.delta", taskId: "task-a", runId: "run-1", sequence: 2, messageId: "reply", text: "Datadog is clean." },
  }).state;
  const settled = settleRun(working).state;
  const [thread] = settled.tasks;

  assert.equal(thread.runEndedAt, 500, "the ending the last audible run stamped on is put back");
  assert.deepEqual(thread.messages.map((message) => message.withdrawn), [true, true], "everything the tick wrote is withdrawn, its own reply included");
  assert.equal(threadActivityAt(thread), 500, "so nothing about the thread moved");
  assert.deepEqual(activitySections(settled.tasks, new Set(), new Set()).threads.map((item) => item.id), ["task-a"]);
});

test("what a silent tick looked at is kept, since it is all such a schedule ever shows", () => {
  const settled = settleRun(said(midRun(), { type: "automation.nothing-to-report", taskId: "task-a", checked: "the last hour of Datadog errors" })).state;
  const [thread] = settled.tasks;
  const lastChecked = thread.lastChecked;
  assert.ok(lastChecked);

  assert.equal(lastChecked.note, "the last hour of Datadog errors");
  assert.ok(lastChecked.at > 0);
  assert.equal(thread.outcome, undefined, "keeping what it checked is not the same as surfacing");
  assert.match(automationMeta(automationView({ runCount: 3, lastStatus: "succeeded", lastStatusAt: lastChecked.at }), null, lastChecked, lastChecked.at),
    /nothing found yet · checked the last hour of Datadog errors /);
});

test("a quiet tick that found something bumps the thread and leads the list", () => {
  const raised = said(midRun(), { type: "automation.notify", taskId: "task-a", headline: "5xx on checkout" });
  const settled = settleRun(said(raised, { type: "automation.nothing-to-report", taskId: "task-a", checked: "the last hour of errors" })).state;
  const [thread] = settled.tasks;

  assert.equal(thread.outcome, "finished", "a run that spoke cannot be retracted into silence");
  const runEndedAt = thread.runEndedAt;
  assert.ok(runEndedAt !== undefined && runEndedAt > 0);
  assert.equal(threadActivityAt(thread), runEndedAt);
  assert.deepEqual(activitySections(settled.tasks, new Set(), new Set()).priority.map((item) => item.id), ["task-a"]);
});

test("what a run found outlives every run after it, unlike the verdict beside it", () => {
  const found = said(midRun(), { type: "automation.notify", taskId: "task-a", headline: "Disk at 91%", detail: "`/dev/disk1` is nearly full." });
  const settled = settleRun(found).state;
  assert.equal(settled.tasks[0].outcome, "finished");

  const again = reduce(settled, { type: "automation.fired", fire: { automationId: "automation-1", taskId: "task-a", runId: "run-2", prompt: "Poll", runNumber: 3 } });
  const started = reduce(again.state, { type: "run.resolved", pendingId: effectAt(again.effects, 0, "resolve-run-workspace").pendingId, workspace: PROJECTLESS }).state;
  const [thread] = started.tasks;
  const findings = findingsOf(thread);

  assert.equal(thread.outcome, undefined, "the next run supersedes the last one's verdict");
  assert.equal(findings.length, 1, "and leaves what the last one found alone");
  assert.equal(findings[0].headline, "Disk at 91%");
  assert.match(thread.messages.map((message) => message.text).join("\n"), /Disk at 91%/, "the finding is said in the thread as well");
});

test("landing on a thread reads its findings and keeps them; dismissing files them away", () => {
  const found = said(midRun(), { type: "automation.notify", taskId: "task-a", headline: "Two alerts firing" }).tasks[0];
  const holding = workspace({ tasks: [found] });

  assert.equal(activitySections(holding.tasks, new Set(), new Set()).priority.length, 1);
  const read = reduce(holding, { type: "task.select", taskId: "task-a" }).state;
  assert.deepEqual(findingsOf(read.tasks[0]).map((finding) => finding.read), [true], "seen, but still there");
  assert.equal(activitySections(read.tasks, new Set(), new Set()).priority.length, 1, "a read finding keeps its place");

  const dismissed = reduce(read, { type: "task.dismiss", taskId: "task-a" }).state;
  assert.equal(dismissed.tasks[0].findings, undefined);
  assert.deepEqual(activitySections(dismissed.tasks, new Set(), new Set()).threads.map((item) => item.id), ["task-a"]);
  assert.deepEqual(reduce(read, { type: "task.dismiss-all" }).state.tasks[0].findings, undefined, "dismissing everything reaches a thread with no verdict too");
});

test("a finding raised on the thread the user is watching is not marked unread", () => {
  const watched = { ...midRun(), currentId: "task-a", focused: true };
  const seen = said(watched, { type: "automation.notify", taskId: "task-a", headline: "Nothing they can miss" });
  assert.deepEqual(findingsOf(seen.tasks[0]).map((finding) => finding.read), [true]);

  const away = said({ ...watched, focused: false }, { type: "automation.notify", taskId: "task-a", headline: "Behind the browser" });
  assert.equal(findingsOf(away.tasks[0])[0].read, undefined);
});

test("a raised finding goes out to the desktop, and one the thread already carries does not", () => {
  const raised = reduce(midRun(), { type: "automation.notify", taskId: "task-a", headline: "5xx on checkout", key: "checkout" });
  assert.deepEqual(raised.effects, [{ type: "announce-thread", notice: { taskId: "task-a", title: "task-a", headline: "5xx on checkout" } }]);

  const again = reduce(raised.state, { type: "automation.notify", taskId: "task-a", headline: "5xx again", key: "checkout" });
  assert.deepEqual(again.effects, [], "nothing was written, so there is nothing to announce");

  const attended = reduce(midRun({ origin: "composer" }), { type: "automation.notify", taskId: "task-a", headline: "Ignore me" });
  assert.deepEqual(attended.effects, []);

  const watched = reduce({ ...midRun(), currentId: "task-a", focused: true }, { type: "automation.notify", taskId: "task-a", headline: "Right there" });
  assert.equal(watched.effects[0].type, "announce-thread", "main is the one that knows where the user is looking");
});

test("a turn that is not a scheduled run raises nothing at all", () => {
  const attended = midRun({ origin: "composer" });
  const asked = said(attended, { type: "automation.notify", taskId: "task-a", headline: "Ignore me" });
  assert.equal(asked.tasks[0].findings, undefined);
  assert.equal(asked.activeRuns["task-a"].notified, false);
  assert.equal(said(attended, { type: "automation.nothing-to-report", taskId: "task-a", checked: "" }).activeRuns["task-a"].acknowledged, false);
});

/** The window answering the two tools, which is where their wording is decided. */
type ToolHost = ThreadRequestHost & {
  task: () => Task;
  run: () => ActiveRun;
};

function toolHost(initial: WorkspaceState): ToolHost {
  let state = initial;
  return {
    state: () => state,
    dispatch: (input: WorkspaceInput) => { state = reduce(state, input).state; },
    waiters: { current: [] },
    task: () => state.tasks[0],
    run: () => state.activeRuns["task-a"],
  };
}

type FindingToolRequest =
  | { op: "notify"; report: FindingReport }
  | { op: "nothing-to-report"; checked: string };

type FindingToolResponse = {
  type: "thread.response";
  requestId: string;
  ok: true;
  result: FindingResult;
};

function isFindingResult(value: unknown): value is FindingResult {
  if (!value || typeof value !== "object") return false;
  return "recorded" in value && typeof value.recorded === "boolean"
    && "note" in value && typeof value.note === "string";
}

async function answer(host: ThreadRequestHost, request: FindingToolRequest): Promise<FindingToolResponse> {
  const fullRequest: ThreadRequest = { type: "thread.request", requestId: "r", taskId: "task-a", ...request };
  const response = await answerThreadRequest(host, fullRequest);
  assert.equal(response.ok, true);
  assert.ok(isFindingResult(response.result));
  return { ...response, result: response.result };
}

test("a tick that only found what the thread already knows settles unseen", async () => {
  const host = toolHost(midRun());
  await answer(host, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  const spoke = settleRun(host.state()).state;
  assert.equal(spoke.tasks[0].outcome, "finished", "the first sighting is news");

  /** The next tick, on a thread that already carries it: the same alert must not wake the user again. */
  const again = toolHost(midRun({}, { findings: spoke.tasks[0].findings, lastFindingAt: spoke.tasks[0].lastFindingAt }));
  const repeat = await answer(again, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  assert.equal(repeat.result.recorded, false);
  const settled = settleRun(again.state()).state;
  assert.equal(settled.tasks[0].outcome, undefined, "nothing new means nothing to surface");
  assert.equal(findingsOf(settled.tasks[0]).length, 1, "and nothing to add");
});

test("dismissing a finding files it away rather than asking to be told again", async () => {
  const host = toolHost(midRun());
  await answer(host, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  const spoke = settleRun(host.state()).state;

  const filed = reduce(spoke, { type: "task.dismiss", taskId: "task-a" }).state;
  assert.equal(filed.tasks[0].findings, undefined, "the row is gone from Priority");
  assert.deepEqual(filed.tasks[0].handledIssues, ["checkout"], "but what it was about is remembered");

  /** The next tick, still finding it: handled means handled. */
  const next = toolHost(midRun({}, { handledIssues: ["checkout"] }));
  const repeat = await answer(next, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  assert.equal(repeat.result.recorded, false, "a dismissal is not a request to be told again");
  assert.equal(settleRun(next.state()).state.tasks[0].outcome, undefined, "so the tick stays quiet");
});

test("a filed-away finding surfaces again once a run stops finding it", async () => {
  const gone = toolHost(midRun({}, { handledIssues: ["checkout"] }));
  await answer(gone, { op: "nothing-to-report", checked: "the alert log, empty" });
  const cleared = settleRun(gone.state()).state;
  assert.equal(cleared.tasks[0].handledIssues, undefined, "the run stopped finding it, so it is over");

  const back = toolHost(midRun({}, { handledIssues: cleared.tasks[0].handledIssues }));
  const again = await answer(back, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  assert.equal(again.result.recorded, true, "the same trouble returning is news again");
});

test("a run that still reports a filed-away finding keeps it filed", async () => {
  const host = toolHost(midRun({}, { handledIssues: ["checkout", "latency"] }));
  await answer(host, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  const settled = settleRun(host.state()).state;

  assert.deepEqual(settled.tasks[0].handledIssues, ["checkout"], "the one it still finds stays filed, the one it did not is closed");
});

test("where a keyed issue stands with a thread has three answers", () => {
  const carrying = task("task-a", {
    findings: [{ id: "f1", headline: "5xx on checkout", key: "checkout", at: 5 }],
    handledIssues: ["latency"],
  });

  assert.equal(issueState(carrying, "checkout"), "carried");
  assert.equal(issueState(carrying, "latency"), "handled");
  assert.equal(issueState(carrying, "disk"), "unknown");
  assert.equal(issueState(carrying, undefined), "unknown", "an unkeyed report is never a second sighting");
  assert.deepEqual(["checkout", "latency", "disk", undefined].map((key) => isNews(carrying, key)), [false, false, true, true]);
});

test("a key holds against a finding the user has read, not only an unread one", async () => {
  const seen = midRun({}, { findings: [{ id: "f1", headline: "5xx on checkout", key: "checkout", at: 5, read: true }] });
  const host = toolHost(seen);

  const repeat = await answer(host, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  assert.equal(repeat.result.recorded, false, "reading a finding is not handling it");
  assert.equal(findingsOf(host.task()).length, 1);
});

test("notify accumulates, says how much the thread now carries, and never raises the same key twice", async () => {
  const host = toolHost(midRun());

  const first = await answer(host, { op: "notify", report: { headline: "5xx on checkout", key: "checkout" } });
  assert.equal(first.ok, true);
  assert.equal(first.result.recorded, true);
  assert.match(first.result.note, /1 unread finding\b/);

  const second = await answer(host, { op: "notify", report: { headline: "Latency doubled", key: "latency" } });
  assert.match(second.result.note, /2 unread findings/, "a second finding is added, not swapped in");
  assert.deepEqual(findingsOf(host.task()).map((finding) => finding.headline), ["5xx on checkout", "Latency doubled"]);

  const repeat = await answer(host, { op: "notify", report: { headline: "5xx on checkout again", key: "checkout" } });
  assert.equal(repeat.result.recorded, false);
  assert.match(repeat.result.note, /already carries a finding keyed "checkout"/);
  assert.equal(findingsOf(host.task()).length, 2);
});

test("a report the thread dropped is never answered as raised", async () => {
  const waiting = { ...midRun({ status: "awaiting-approval" }), currentId: "task-a" };
  const host = toolHost({ ...waiting, approvals: { "run-1": { approvalId: "ap1", taskId: "task-a", runId: "run-1", title: "Run tests", description: "", toolName: "Bash", input: {} } } });
  /** The user answers the run's question in the moment the report is going in, which takes the run over. */
  const joined = host.dispatch;
  host.dispatch = (input) => { joined({ type: "run.decide", taskId: "task-a", allow: true }); joined(input); };

  const answered = await answer(host, { op: "notify", report: { headline: "Disk at 91%", key: "disk" } });
  assert.equal(host.task().findings, undefined, "a run the user joined answers them rather than raising");
  assert.equal(answered.result.recorded, false, "so the run is never told it was raised");
  assert.match(answered.result.note, /joined this run/);
});

test("a blank key is no key at all, rather than one nothing will ever match", async () => {
  const host = toolHost(midRun());

  const first = await answer(host, { op: "notify", report: { headline: "Something", key: "" } });
  assert.equal(first.result.recorded, true);
  assert.equal(findingsOf(host.task())[0].key, undefined, "a blank is not stored as a key");
  assert.equal(isNews(host.task(), ""), true, "and asking about it reads as the unkeyed report it is");
});

test("a run that has spoken cannot be talked back into silence", async () => {
  const host = toolHost(midRun());
  await answer(host, { op: "notify", report: { headline: "Something is on fire" } });

  const retracted = await answer(host, { op: "nothing-to-report", checked: "the alert feed" });
  assert.equal(retracted.result.recorded, false);
  assert.match(retracted.result.note, /already raised something new/);
  assert.equal(host.run().notified, true);
  assert.equal(settleRun(host.state()).state.tasks[0].outcome, "finished");
});

test("nothing_to_report says what silence it bought, and buys none on a loud automation", async () => {
  const quiet = toolHost(midRun());
  const spoken = await answer(quiet, { op: "nothing-to-report", checked: "the last hour of logs" });
  assert.equal(spoken.result.recorded, true);
  assert.match(spoken.result.note, /settles without reaching the user/);
  assert.equal(quiet.run().acknowledged, true);

  const loud = toolHost(midRun({ quiet: false }));
  const heard = await answer(loud, { op: "nothing-to-report", checked: "the last hour of logs" });
  assert.match(heard.result.note, /every run of it surfaces/);
  assert.equal(settleRun(loud.state()).state.tasks[0].outcome, "finished");
});

test("both tools teach rather than fail when the turn is nobody's schedule", async () => {
  const host = toolHost(midRun({ origin: "composer" }));

  for (const request of [{ op: "notify", report: { headline: "Found it" } }, { op: "nothing-to-report", checked: "everything" }] as const satisfies readonly FindingToolRequest[]) {
    const answered = await answer(host, request);
    assert.equal(answered.ok, true, "an ordinary turn is not an error");
    assert.equal(answered.result.recorded, false);
    assert.match(answered.result.note, /not a scheduled run/);
  }
  assert.equal(host.task().findings, undefined);
});

test("a thread at its fill takes the newest finding and lets the oldest go", async () => {
  const host = toolHost(midRun());
  for (let index = 0; index < 10; index += 1) await answer(host, { op: "notify", report: { headline: `Finding ${index}`, key: `k${index}` } });

  const over = await answer(host, { op: "notify", report: { headline: "One too many", key: "k10" } });
  assert.equal(over.ok, true);
  assert.equal(over.result.recorded, true);
  const carried = findingsOf(host.task()).map((finding) => finding.headline);
  assert.equal(carried.length, 10);
  assert.equal(carried.at(-1), "One too many");
  assert.equal(carried[0], "Finding 1", "the oldest made way for it");
  assert.equal(settleRun(host.state()).state.tasks[0].outcome, "finished");
});

test("what an earlier run filled the thread with cannot silence what this one found", async () => {
  const carried = Array.from({ length: 10 }, (_, index) => ({ id: `f${index}`, headline: `Old ${index}`, key: `k${index}`, at: 5 }));
  const host = toolHost(midRun({}, { findings: carried }));

  const raised = await answer(host, { op: "notify", report: { headline: "The database is down", key: "db" } });
  assert.equal(raised.result.recorded, true);
  assert.equal(host.run().notified, true);
  const settled = settleRun(host.state()).state.tasks[0];
  assert.equal(settled.outcome, "finished", "a quiet tick that found something new still surfaces");
  assert.ok(findingsOf(settled).some((finding) => finding.key === "db"));
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

test("a tick the scheduler said is quiet withdraws its own label from the start", () => {
  const fired = reduce(workspace({ tasks: [task("task-a", { createdAt: 5, updatedAt: 5 })] }), {
    type: "automation.fired",
    fire: { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 2, quiet: true, surfaceWhen: "there is an error." },
  });
  const started = reduce(fired.state, { type: "run.resolved", pendingId: effectAt(fired.effects, 0, "resolve-run-workspace").pendingId, workspace: PROJECTLESS });
  const [label] = started.state.tasks[0].messages;

  assert.equal(label.withdrawn, true);
  assert.equal(threadActivityAt(started.state.tasks[0]), 5, "the label alone does not count as the thread doing something");
  assert.match(effectAt(started.effects, 0, "start-run").command.prompt, /Surface it when: there is an error\./, "the tick's sentence reaches the run that has to honour it");
});

/** Fires a tick at a thread that cannot take it, with the scheduler's count of the ones before it. */
function declined(consecutiveDeclines: number, tasks: Task[] = [task("task-a")], origin: ActiveRun["origin"] = "automation") {
  const automation = automationView({ createdAt: 100, updatedAt: 100, runCount: 4, lastRunAt: 900, consecutiveDeclines });
  const busy = workspace({
    tasks,
    automations: [automation],
    activeRuns: { "task-a": activeRun({ runId: "other", origin, quiet: false, messagesBefore: 0 }) },
    runStatuses: { "task-a": "running" },
  });
  return reduce(busy, { type: "automation.fired", fire: { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 5 } });
}

test("a tick that cannot run says which thread turned it away", () => {
  const fire: AutomationFire = { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 5 };
  const idle = workspace({ tasks: [task("task-a")] });
  const [waiting] = idle.tasks;
  const busy = (origin: ActiveRun["origin"]): WorkspaceState => workspace({
    ...idle,
    activeRuns: { "task-a": activeRun({ runId: "other", origin, quiet: false }) },
  });
  const sending = workspace({ ...idle, pendingRuns: { "pending-1": { id: "pending-1", runId: "run-2", origin: "composer", taskId: "task-a", text: "Hi", prompt: "Hi", attachments: [] } } });
  const filed = task("task-a", { archivedAt: 5 });
  const inProject = task("task-a", { projectId: "project-1" });

  assert.equal(whyTickCannotRun(idle, fire, waiting), null, "an idle thread takes it");
  assert.equal(whyTickCannotRun(idle, fire, undefined), "no-thread");
  assert.equal(whyTickCannotRun(idle, fire, filed), "archived");
  assert.equal(whyTickCannotRun(busy("automation"), fire, waiting), "busy-agent");
  assert.equal(whyTickCannotRun(busy("composer"), fire, waiting), "busy-user");
  assert.equal(whyTickCannotRun(sending, fire, waiting), "busy-user", "a send still resolving is the user too");
  assert.equal(whyTickCannotRun(busy("composer"), fire, filed), "busy-user", "the user being here is answered before anything else");
  assert.equal(whyTickCannotRun(idle, fire, inProject, undefined), "no-workspace");
  assert.equal(whyTickCannotRun(idle, fire, inProject, { id: "project-1", root: "/work/api", workspaceId: "workspace-1" }), null);
});

test("a schedule turned away three times running says so out loud on its thread", () => {
  for (const before of [0, 1]) {
    const early = declined(before);
    assert.deepEqual(early.effects.map((effect) => effect.type), ["automation.ack"], `${before} declines before is not yet worth saying`);
    assert.equal(early.state.tasks[0].findings, undefined);
  }

  const third = declined(2);
  assert.deepEqual(third.effects.map((effect) => effect.type), ["automation.ack", "announce-thread"]);
  assert.equal(effectAt(third.effects, 0, "automation.ack").ack.started, false, "the tick is still turned away");
  const [finding] = findingsOf(third.state.tasks[0]);
  assert.match(finding.headline, /has not been able to run since/);
  assert.equal(finding.key, "declined:automation-1");
  assert.equal(effectAt(third.effects, 1, "announce-thread").notice.headline, finding.headline);

  const chatting = declined(2, [task("task-a")], "composer");
  assert.deepEqual(chatting.effects.map((effect) => effect.type), ["automation.ack"], "a thread its own user is working in is not a broken schedule");
  assert.equal(chatting.state.tasks[0].findings, undefined);

  const fourth = declined(3, third.state.tasks);
  assert.deepEqual(fourth.effects.map((effect) => effect.type), ["automation.ack"], "it is said once, not on every tick after");
  assert.equal(findingsOf(fourth.state.tasks[0]).length, 1);
});

test("a tick waits behind messages the user has queued, and does not call that a broken schedule", () => {
  const waiting = workspace({
    tasks: [task("task-a")],
    automations: [{ id: "automation-1", taskId: "task-a", prompt: "Poll", schedule: "* * * * *", paused: false, createdAt: 100, updatedAt: 100, runCount: 4, lastRunAt: 900, consecutiveDeclines: 2, nextRunAt: null }],
    queuedMessages: { "task-a": [{ id: "q1", text: "do the thing", prompt: "do the thing", attachments: [] }] },
  });

  const fired = reduce(waiting, { type: "automation.fired", fire: { automationId: "automation-1", taskId: "task-a", runId: "run-1", prompt: "Poll", runNumber: 5 } });
  assert.deepEqual(fired.effects.map((effect) => effect.type), ["automation.ack", "announce-thread"], "a thread queued behind its own run has no turn to give the tick");
  assert.equal(effectAt(fired.effects, 0, "automation.ack").ack.started, false);
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
Object.defineProperty(dom.window.Element.prototype, "getAnimations", { configurable: true, value: () => [] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(() => dom.window.close());

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next: React.ReactNode) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function sidebar(overrides: Partial<ProjectSidebarProps> = {}) {
  return React.createElement(ProjectSidebar, {
    open: true,
    inactive: false,
    projects: [{ id: "project-1", root: "/work/api" }],
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set<string>(),
    runningTaskIds: new Set<string>(),
    blockedTaskIds: new Set<string>(),
    schedules: new Map<string, AutomationView>(),
    worktreeGroups: [],
    worktreeTaskIds: new Set<string>(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "activity",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRenameProject() {}, onEditProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onRenameTask() {}, onDismissTask() {}, onDismissAll() {},
    onMoveTask() {}, onForkTask() {}, onMoveProject() {}, onOpenSettings() {},
    ...overrides,
  });
}

function query<E extends Element = HTMLElement>(container: ParentNode, selector: string): E {
  const element = container.querySelector<E>(selector);
  assert.ok(element, `Expected ${selector}`);
  return element;
}

test("a priority row says what was found rather than where it lives and when it last moved", async () => {
  const found = task("task-a", {
    projectId: "project-1",
    findings: [{ id: "f1", headline: "Checkout is returning 5xx", at: 1 }],
  });
  const view = await mount(sidebar({ activityTasks: { priority: [found], running: [], threads: [] } }));

  assert.equal(query(view.container, ".task-row-text small").textContent, "Checkout is returning 5xx");
  assert.equal(query(view.container, ".task-attention").getAttribute("aria-label"), "Checkout is returning 5xx", "a screen reader hears the reason, not \"Finished\"");

  const read: Task = { ...found, findings: [{ ...item(found.findings?.[0]), read: true }] };
  await view.render(sidebar({ activityTasks: { priority: [read], running: [], threads: [] } }));
  assert.equal(view.container.querySelector(".task-attention"), null, "read takes the dot off");
  assert.match(query(view.container, ".task-row-text small").textContent ?? "", /^api · /, "and the row goes back to saying where it lives");
  await view.unmount();
});

test("priority says when it holds nothing, speaks its changes, and running does neither", async () => {
  const view = await mount(sidebar({}));

  const [priority, running] = [...view.container.querySelectorAll(".activity-group")];
  assert.equal(query(item(priority), ".sidebar-empty").textContent, "Nothing waiting");
  assert.ok(running);
  assert.equal(running.querySelector(".sidebar-empty"), null, "only priority has anything to say when empty");
  assert.equal(query(view.container, '[aria-label="Priority"]').getAttribute("aria-live"), "polite");
  assert.equal(query(view.container, '[aria-label="Running"]').getAttribute("aria-live"), null, "a spinner appearing is not news");
  await view.unmount();
});

test("the schedule mark and the dismiss button both say what state the schedule is in", async () => {
  const scheduled = task("task-a", { outcome: "finished", outcomeUnread: true });
  const marks = (schedule: Partial<AutomationView>) => sidebar({
    activityTasks: { priority: [scheduled], running: [], threads: [] },
    schedules: new Map([["task-a", automationView({ nextRunAt: 2, ...schedule })]]),
  });
  const view = await mount(marks({}));
  const label = () => query(view.container, ".task-automation").getAttribute("aria-label");

  assert.equal(label(), "Runs on a schedule");
  assert.equal(query(view.container, ".task-dismiss").getAttribute("aria-label"), "Dismiss task-a, which keeps running on its schedule");
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
  const automation = automationView({ id: "a", schedule: "*/30 * * * *", runCount: 48, lastRunAt: at - 60_000, lastStatusAt: at - 60_000, lastStatus: "succeeded", nextRunAt: at + 60_000, overrunCount: 2 });

  assert.match(automationMeta(automation, null, null, at), /^48 runs · succeeded at .* · nothing found yet · 2 dropped for overrunning$/);
  assert.match(automationMeta(automation, at - 120_000, null, at), /found something /);
});

test("the panel keeps the sentence a schedule surfaces for, rather than trading it for a default", async () => {
  const patches: AutomationPatch[] = [];
  const automation = automationView({ id: "a", schedule: "*/30 * * * *", runCount: 3, nextRunAt: Date.now() + 60_000 });
  const panel = (surfaceWhen?: string) => React.createElement(AutomationPanel, {
    /** A record only ever changes with its moment, which is what the panel reloads its fields on. */
    automation: surfaceWhen === undefined ? automation : { ...automation, surfaceWhen, updatedAt: 2 },
    engineLabel: "Claude",
    lastFoundAt: null,
    lastChecked: null,
    onUpdate: (patch) => patches.push(patch),
    onDelete() {}, onRunNow() {},
  } satisfies AutomationPanelProps);

  const field = () => query<HTMLTextAreaElement>(view.container, "[aria-label='What a run of this automation surfaces for']");
  const save = () => item([...view.container.querySelectorAll("button")].find((button) => button.textContent === "Save"));

  const view = await mount(panel(undefined));
  assert.equal(field().value, "", "a schedule that never said what it surfaces for is loud");
  assert.equal(save().disabled, true);

  await view.render(panel("an error was caused by the user's own code."));
  assert.equal(field().value, "an error was caused by the user's own code.", "the sentence the schedule carries is the one shown");
  assert.equal(save().disabled, true, "showing it is not changing it");

  await act(async () => { field().click(); });
  await view.unmount();
});
