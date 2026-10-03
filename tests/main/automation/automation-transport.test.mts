import assert from "node:assert/strict";
import { test, afterAll, beforeAll } from "vitest";
import { registered, startMainProcess, waitFor, type MainHarness } from "../../support/electron-harness.mjs";
import type { AutomationRequest, AutomationResponse, StartRunCommand } from "../../../src/contracts/ipc.js";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../../src/application/workspace-reducer.js";
import type { AutomationDraft, AutomationView } from "../../../src/domain/automation.js";
import type { RunStatus } from "../../../src/domain/run.js";

/**
 * Hourly, half an hour out at the nearest, so a real tick never races the manual runs these tests
 * drive. Fixed at the top of the hour it is under a minute away whenever the suite runs at :59.
 */
const HOURLY = `${(new Date().getMinutes() + 30) % 60} * * * *`;

/** Booting main starts a Vite server, so every test in this file shares one and works on its own task. */
let main: MainHarness;
beforeAll(async () => {
  main = await startMainProcess(null, "aicodingtool-automation-", { computerUse: { computerUseForRun: async () => ({ status: "unavailable", message: "test" }), stopComputerUse: async () => {} } });
  main.desktop.send({ type: "stop-process", taskId: "test-setup", processId: "test-setup" });
  await waitFor(() => main.agents.length === 1, "the agent process to start on demand");
});
afterAll(async () => { await main?.dispose(); });

type IpcEvent = { sender: unknown };
type FinalRunStatus = Exclude<RunStatus, "running" | "awaiting-approval">;

const draft = (taskId: string, overrides: Partial<AutomationDraft> = {}): AutomationDraft => ({
  taskId,
  prompt: "Check whether PR 42 is approved",
  schedule: HOURLY,
  ...overrides,
});

const runtimeRequest = (input: WorkspaceInput) => registered<(event: IpcEvent, input?: WorkspaceInput) => Promise<WorkspaceCommandResult>>(main.handlers, "workspace-runtime:request")(main.trusted, input);

const automationFor = async (taskId: string) => (await main.desktop.listAutomations()).find((view) => view.taskId === taskId);

/** What the runtime, and so the panel, says about a task's automation. */
const latestFor = async (taskId: string) => (await main.runtimeState()).automations.filter((view) => view.taskId === taskId);

/** A thread the runtime holds, whose first run has settled, which is what a schedule is attached to. */
async function settledThread(text: string) {
  await runtimeRequest({ type: "task.new" });
  await runtimeRequest({ type: "view.set-prompt", prompt: text });
  const sent = await runtimeRequest({ type: "task.send", attachments: [] });
  assert.ok(sent.ok && sent.taskId, sent.ok ? "" : sent.message);
  const taskId = sent.taskId;
  const agent = main.agents[0];
  await waitFor(() => agent.messages.some((message) => message.type === "start" && message.taskId === taskId), "the first run reaching the agent");
  const start = agent.messages.find((message) => message.type === "start" && message.taskId === taskId) as StartRunCommand;
  agent.emit("message", { type: "run.started", taskId, runId: start.runId, sequence: 1 });
  agent.emit("message", { type: "run.status", taskId, runId: start.runId, sequence: 2, status: "succeeded" });
  await waitFor(async () => (await main.runtimeState()).threads.find((thread) => thread.id === taskId)?.outcome === "finished", "the first run settling");
  return taskId;
}

/** Takes each tick the runtime starts on the thread, and reports how the run ended. */
function ticks(taskId: string) {
  const starts = () => main.agents[0].messages.filter((message) => message.type === "start" && message.taskId === taskId && message.operation === undefined) as StartRunCommand[];
  const handled = starts().length;
  let taken = 0;
  return async ({ outcome = "succeeded" }: { outcome?: FinalRunStatus } = {}) => {
    await waitFor(() => starts().length > handled + taken, "the scheduler's run to reach the agent");
    const start = starts()[handled + taken];
    taken += 1;
    main.agents[0].emit("message", { type: "run.started", taskId, runId: start.runId, sequence: 1 });
    main.agents[0].emit("message", { type: "run.status", taskId, runId: start.runId, sequence: 2, status: outcome });
    return start;
  };
}

test("the window cannot reach the scheduler but through the runtime, and the scheduler refuses malformed schedules", async () => {
  const request = registered<(event: IpcEvent, input: unknown) => Promise<WorkspaceCommandResult>>(main.handlers, "workspace-runtime:request");
  await assert.rejects(async () => request(main.untrusted, { type: "automation.save", taskId: "task-guards", draft: { prompt: "poll", schedule: HOURLY } }), /Untrusted/);
  await assert.rejects(async () => request(main.trusted, { type: "automation.save", taskId: "task-guards", draft: { prompt: "poll" } }), /Invalid workspace input/);
  await assert.rejects(async () => request(main.trusted, { type: "automation.update", taskId: "task-guards", patch: { paused: "yes" } }), /Invalid workspace input/);

  await assert.rejects(async () => main.desktop.saveAutomation(draft("task-guards", { schedule: "*/10 * * * * *" })), /at most once a minute/);
  await assert.rejects(async () => main.desktop.updateAutomation("task-guards", { paused: true }), /no automation/);

  assert.equal(await automationFor("task-guards"), undefined, "nothing invalid was stored");
});

test("saving an automation arms it and pushes the new state to the panel", async () => {
  const saved = await main.desktop.saveAutomation(draft("task-save"));

  assert.equal(saved.runCount, 0);
  assert.ok(saved.nextRunAt !== null && saved.nextRunAt > Date.now(), "a saved automation is armed");
  await waitFor(async () => (await latestFor("task-save")).length === 1, "the panel hearing about the schedule");
  assert.deepEqual((await latestFor("task-save")).map((view) => view.id), [saved.id]);

  assert.equal(await main.desktop.deleteAutomation("task-save"), true);
  await waitFor(async () => (await latestFor("task-save")).length === 0, "the panel hearing about the removal");
  assert.equal(await main.desktop.deleteAutomation("task-save"), false);
});

test("a tick runs in its thread and the run's outcome comes back to the scheduler", async () => {
  const taskId = await settledThread("Watch PR 42");
  await main.desktop.saveAutomation(draft(taskId, { policy: "autonomous" }));
  const takeTick = ticks(taskId);

  const running = main.desktop.runAutomationNow(taskId);
  const start = await takeTick();
  assert.equal(await running, "succeeded");

  assert.match(start.prompt, /^Check whether PR 42 is approved/);
  assert.equal(start.policy, "autonomous", "the automation's policy travels with the tick");

  const ran = await automationFor(taskId);
  assert.ok(ran);
  assert.equal(ran.runCount, 1);
  assert.equal(ran.lastStatus, "succeeded");

  const failing = main.desktop.runAutomationNow(taskId);
  await takeTick({ outcome: "failed" });
  assert.equal(await failing, "failed");

  const failed = await automationFor(taskId);
  assert.ok(failed);
  assert.equal(failed.runCount, 2, "a failed run still counts");
  assert.ok(failed.nextRunAt !== null && failed.nextRunAt > Date.now(), "and the automation keeps its schedule");
});

test("a tick for a thread the runtime does not hold is declined and leaves the automation untouched", async () => {
  await main.desktop.saveAutomation(draft("task-declined"));

  assert.equal(await main.desktop.runAutomationNow("task-declined"), "skipped");
  const view = await automationFor("task-declined");
  assert.ok(view);
  assert.equal(view.runCount, 0);
  assert.equal(view.lastStatus, "skipped");
  assert.ok(view.nextRunAt !== null && view.nextRunAt > Date.now(), "a declined tick does not disarm the automation");
});

test("the agent process schedules and stops automations for the task it is running", async () => {
  const agent = main.agents[0];
  const respondTo = async (request: AutomationRequest): Promise<AutomationResponse> => {
    const before = agent.messages.length;
    agent.emit("message", request);
    await waitFor(() => agent.messages.length > before, `a response to ${request.op}`);
    const response = agent.messages.at(-1);
    assert.ok(response);
    assert.equal(response.type, "automation.response");
    return response as AutomationResponse;
  };

  const resultOf = <T,>(response: AutomationResponse): T => {
    if (!response.ok) assert.fail(response.message);
    return response.result as T;
  };

  const workspace = await main.call("projectlessWorkspace");
  main.desktop.send({
    type: "start", channel: "main", taskId: "task-agent", runId: "run-agent", title: "Work", prompt: "work", workspaceId: workspace.id, policy: "confirm", engine: "claude", model: "opus", effort: "high",
  });
  await waitFor(() => agent.messages.some((message) => message.type === "start" && message.taskId === "task-agent"));
  const scheduled = await respondTo({ type: "automation.request", requestId: "request-1", taskId: "task-agent", runId: "run-agent", op: "save", draft: { prompt: "Babysit PR 42", schedule: HOURLY } });
  assert.equal(scheduled.type, "automation.response");
  assert.equal(scheduled.requestId, "request-1");
  assert.equal(scheduled.ok, true);
  assert.equal(resultOf<AutomationView>(scheduled).taskId, "task-agent", "the agent's automation is bound to its own task");
  await waitFor(async () => (await latestFor("task-agent")).length === 1, "the panel hearing about the agent's schedule");
  assert.deepEqual((await latestFor("task-agent")).map((view) => view.prompt), ["Babysit PR 42"]);

  for (const request of [
    { type: "automation.request", requestId: "escalate-save", taskId: "task-agent", runId: "run-agent", op: "save", draft: { prompt: "unsafe", schedule: HOURLY, policy: "bypass" } },
    { type: "automation.request", requestId: "escalate-update", taskId: "task-agent", runId: "run-agent", op: "update", patch: { policy: "autonomous" } },
    { type: "automation.request", requestId: "stale-update", taskId: "task-agent", runId: "old-run", op: "update", patch: { prompt: "unsafe" } },
    { type: "automation.request", requestId: "unknown-save", taskId: "unknown-task", runId: "run-agent", op: "save", draft: { prompt: "unsafe", schedule: HOURLY } },
  ] satisfies AutomationRequest[]) {
    const result = await respondTo(request);
    assert.equal(result.ok, false);
  }
  assert.equal((await automationFor("task-agent"))?.prompt, "Babysit PR 42");
  assert.equal((await automationFor("task-agent"))?.policy, "confirm");

  const read = await respondTo({ type: "automation.request", requestId: "request-2", taskId: "task-agent", op: "read" });
  assert.equal(resultOf<AutomationView>(read).prompt, "Babysit PR 42");

  const other = await respondTo({ type: "automation.request", requestId: "request-3", taskId: "task-unrelated", op: "read" });
  assert.equal(resultOf<null>(other), null, "a run cannot read another task's automation");

  const rejected = await respondTo({ type: "automation.request", requestId: "request-4", taskId: "task-agent", runId: "run-agent", op: "update", patch: { schedule: "nonsense" } });
  if (rejected.ok) assert.fail("expected the invalid schedule to be rejected");
  assert.match(rejected.message, /not a valid schedule/);

  const stopped = await respondTo({ type: "automation.request", requestId: "request-5", taskId: "task-agent", op: "delete" });
  assert.equal(resultOf<boolean>(stopped), true);
  assert.equal(await automationFor("task-agent"), undefined, "the stop condition ends the automation");
  await waitFor(async () => (await latestFor("task-agent")).length === 0, "the panel hearing about the stop");
});

test("a run that stops its own automation mid-tick is not resurrected by the tick's bookkeeping", async () => {
  const taskId = await settledThread("Stop yourself");
  await main.desktop.saveAutomation(draft(taskId));
  const agent = main.agents[0];
  const starts = () => agent.messages.filter((message) => message.type === "start" && message.taskId === taskId) as StartRunCommand[];
  const before = starts().length;

  const running = main.desktop.runAutomationNow(taskId);
  await waitFor(() => starts().length === before + 1, "the scheduler's run to reach the agent");
  const start = starts()[before];

  agent.emit("message", { type: "run.started", taskId, runId: start.runId, sequence: 1 });
  agent.emit("message", { type: "automation.request", requestId: "stop-request", taskId, op: "delete" });
  await waitFor(() => agent.messages.some((message) => message.requestId === "stop-request"), "the stop response");
  agent.emit("message", { type: "run.status", taskId, runId: start.runId, sequence: 2, status: "succeeded" });

  assert.equal(await running, "succeeded");
  assert.equal(await automationFor(taskId), undefined);
});

test("automations survive a restart of the app", async (t) => {
  const saved = await main.desktop.saveAutomation(draft("task-restart", { paused: true }));

  const { TaskDatabase } = await import("../../../src/main/task-database.mts");
  const { AutomationScheduler } = await import("../../../src/main/automation/automation-scheduler.mts");
  const database = new TaskDatabase(`${main.userData}/tasks.v3.sqlite`);
  const scheduler = new AutomationScheduler(database, async () => "succeeded");
  t.onTestFinished(() => { scheduler.stop(); database.close(); });
  await scheduler.start();

  const reloaded = scheduler.forThread("task-restart");
  assert.ok(reloaded);
  assert.equal(reloaded.id, saved.id);
  assert.equal(reloaded.prompt, "Check whether PR 42 is approved");
  assert.equal(reloaded.paused, true, "a paused automation does not wake up on restart");
});
