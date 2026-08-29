import assert from "node:assert/strict";
import { test, afterAll, beforeAll } from "vitest";
import { registered, startMainProcess, waitFor, type MainHarness } from "../../support/electron-harness.mjs";
import type { AutomationAck, AutomationFire, AutomationRequest, AutomationResponse } from "../../../src/contracts/ipc.js";
import type { AutomationDraft, AutomationRunStatus, AutomationView } from "../../../src/domain/automation.js";
import type { RunStatus } from "../../../src/domain/run.js";

/**
 * Hourly, half an hour out at the nearest, so a real tick never races the manual runs these tests
 * drive. Fixed at the top of the hour it is under a minute away whenever the suite runs at :59.
 */
const HOURLY = `${(new Date().getMinutes() + 30) % 60} * * * *`;

/** Booting main starts a Vite server, so every test in this file shares one and works on its own task. */
let main: MainHarness;
beforeAll(async () => {
  main = await startMainProcess(null, "aicodingtool-automation-");
  registered<(event: { sender: unknown }, payload: unknown) => void>(main.listeners, "run:command")(
    main.trusted,
    { type: "stop-process", taskId: "test-setup", processId: "test-setup" },
  );
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

const listAutomations = () => registered<(event: IpcEvent) => Promise<AutomationView[]>>(main.handlers, "automation:list");
const saveAutomation = () => registered<(event: IpcEvent, draft: unknown) => Promise<AutomationView>>(main.handlers, "automation:save");
const updateAutomation = () => registered<(event: IpcEvent, taskId: unknown, patch: unknown) => Promise<AutomationView>>(main.handlers, "automation:update");
const deleteAutomation = () => registered<(event: IpcEvent, taskId: unknown) => Promise<boolean>>(main.handlers, "automation:delete");
const runAutomation = () => registered<(event: IpcEvent, taskId: unknown) => Promise<AutomationRunStatus>>(main.handlers, "automation:run-now");
const acknowledgeAutomation = () => registered<(event: IpcEvent, ack: AutomationAck) => void>(main.listeners, "automation:ack");

const automationFor = async (taskId: string) => (await listAutomations()(main.trusted)).find((view) => view.taskId === taskId);

const latestFor = (taskId: string) => (main.sentOn<AutomationView[]>("automation:changed").at(-1) ?? []).filter((view) => view.taskId === taskId);

/** Stands in for the renderer: takes each tick, answers the acknowledgement, and reports how the run ended. */
function renderer(automationId: string) {
  const fires = () => main.sentOn<AutomationFire>("automation:fire").filter((fire) => fire.automationId === automationId);
  let handled = 0;
  return async ({ start = true, outcome = "succeeded" }: { start?: boolean; outcome?: FinalRunStatus } = {}) => {
    await waitFor(() => fires().length > handled, "the scheduler to fire");
    const fire = fires()[handled];
    handled += 1;
    acknowledgeAutomation()(main.trusted, { automationId: fire.automationId, runId: fire.runId, started: start });
    if (start) {
      main.agents[0].emit("message", { type: "run.started", taskId: fire.taskId, runId: fire.runId, sequence: 1 });
      main.agents[0].emit("message", { type: "run.status", taskId: fire.taskId, runId: fire.runId, sequence: 2, status: outcome });
    }
    return fire;
  };
}

test("the automation IPC surface rejects untrusted senders and malformed schedules", async () => {
  await assert.rejects(async () => listAutomations()(main.untrusted), /Untrusted/);
  await assert.rejects(async () => saveAutomation()(main.untrusted, draft("task-guards")), /Untrusted/);
  await assert.rejects(async () => deleteAutomation()(main.untrusted, "task-guards"), /Untrusted/);

  await assert.rejects(async () => saveAutomation()(main.trusted, { taskId: "task-guards", prompt: "poll" }), /Invalid automation/);
  await assert.rejects(async () => saveAutomation()(main.trusted, draft("task-guards", { schedule: "*/10 * * * * *" })), /at most once a minute/);
  await assert.rejects(async () => updateAutomation()(main.trusted, "task-guards", { paused: "yes" }), /Invalid automation change/);
  await assert.rejects(async () => updateAutomation()(main.trusted, "task-guards", { paused: true }), /no automation/);

  assert.equal(await automationFor("task-guards"), undefined, "nothing invalid was stored");
});

test("saving an automation arms it and pushes the new state to the panel", async () => {
  const saved = await saveAutomation()(main.trusted, draft("task-save"));

  assert.equal(saved.runCount, 0);
  assert.ok(saved.nextRunAt !== null && saved.nextRunAt > Date.now(), "a saved automation is armed");
  assert.deepEqual(latestFor("task-save").map((view) => view.id), [saved.id]);

  assert.equal(await deleteAutomation()(main.trusted, "task-save"), true);
  assert.deepEqual(latestFor("task-save"), []);
  assert.equal(await deleteAutomation()(main.trusted, "task-save"), false);
});

test("a tick reaches the renderer and its run outcome comes back to the scheduler", async () => {
  const saved = await saveAutomation()(main.trusted, draft("task-tick", { policy: "autonomous" }));
  const takeTick = renderer(saved.id);

  const running = runAutomation()(main.trusted, "task-tick");
  const fire = await takeTick();
  assert.equal(await running, "succeeded");

  assert.equal(fire.taskId, "task-tick");
  assert.equal(fire.prompt, "Check whether PR 42 is approved");
  assert.equal(fire.policy, "autonomous", "the automation's policy travels with the tick");
  assert.equal(fire.runNumber, 1);

  const ran = await automationFor("task-tick");
  assert.ok(ran);
  assert.equal(ran.runCount, 1);
  assert.equal(ran.lastStatus, "succeeded");

  const failing = runAutomation()(main.trusted, "task-tick");
  assert.equal((await takeTick({ outcome: "failed" })).runNumber, 2);
  assert.equal(await failing, "failed");

  const failed = await automationFor("task-tick");
  assert.ok(failed);
  assert.equal(failed.runCount, 2, "a failed run still counts");
  assert.ok(failed.nextRunAt !== null && failed.nextRunAt > Date.now(), "and the automation keeps its schedule");
});

test("a renderer that declines the tick leaves the automation untouched", async () => {
  const saved = await saveAutomation()(main.trusted, draft("task-declined"));

  const running = runAutomation()(main.trusted, "task-declined");
  await renderer(saved.id)({ start: false });

  assert.equal(await running, "skipped");
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

  const scheduled = await respondTo({ type: "automation.request", requestId: "request-1", taskId: "task-agent", op: "save", draft: { prompt: "Babysit PR 42", schedule: HOURLY } });
  assert.equal(scheduled.type, "automation.response");
  assert.equal(scheduled.requestId, "request-1");
  assert.equal(scheduled.ok, true);
  assert.equal(resultOf<AutomationView>(scheduled).taskId, "task-agent", "the agent's automation is bound to its own task");
  assert.deepEqual(latestFor("task-agent").map((view) => view.prompt), ["Babysit PR 42"]);

  const read = await respondTo({ type: "automation.request", requestId: "request-2", taskId: "task-agent", op: "read" });
  assert.equal(resultOf<AutomationView>(read).prompt, "Babysit PR 42");

  const other = await respondTo({ type: "automation.request", requestId: "request-3", taskId: "task-unrelated", op: "read" });
  assert.equal(resultOf<null>(other), null, "a run cannot read another task's automation");

  const rejected = await respondTo({ type: "automation.request", requestId: "request-4", taskId: "task-agent", op: "update", patch: { schedule: "nonsense" } });
  if (rejected.ok) assert.fail("expected the invalid schedule to be rejected");
  assert.match(rejected.message, /not a valid schedule/);

  const stopped = await respondTo({ type: "automation.request", requestId: "request-5", taskId: "task-agent", op: "delete" });
  assert.equal(resultOf<boolean>(stopped), true);
  assert.equal(await automationFor("task-agent"), undefined, "the stop condition ends the automation");
  assert.deepEqual(latestFor("task-agent"), []);
});

test("a run that stops its own automation mid-tick is not resurrected by the tick's bookkeeping", async () => {
  const saved = await saveAutomation()(main.trusted, draft("task-stop"));
  const agent = main.agents[0];
  const fires = () => main.sentOn<AutomationFire>("automation:fire").filter((fire) => fire.automationId === saved.id);

  const running = runAutomation()(main.trusted, "task-stop");
  await waitFor(() => fires().length === 1, "the scheduler to fire");
  const fire = fires()[0];
  acknowledgeAutomation()(main.trusted, { automationId: fire.automationId, runId: fire.runId, started: true });

  agent.emit("message", { type: "run.started", taskId: fire.taskId, runId: fire.runId, sequence: 1 });
  agent.emit("message", { type: "automation.request", requestId: "stop-request", taskId: "task-stop", op: "delete" });
  await waitFor(() => agent.messages.some((message) => message.requestId === "stop-request"), "the stop response");
  agent.emit("message", { type: "run.status", taskId: fire.taskId, runId: fire.runId, sequence: 2, status: "succeeded" });

  assert.equal(await running, "succeeded");
  assert.equal(await automationFor("task-stop"), undefined);
});

test("automations survive a restart of the app", async (t) => {
  const saved = await saveAutomation()(main.trusted, draft("task-restart", { paused: true }));

  const { TaskDatabase } = await import("../../../src/main/task-database.mts");
  const { AutomationScheduler } = await import("../../../src/main/automation/automation-scheduler.mts");
  const database = new TaskDatabase(`${main.userData}/tasks.v3.sqlite`);
  const scheduler = new AutomationScheduler(database, async () => "succeeded");
  t.onTestFinished(() => { scheduler.stop(); database.close(); });
  scheduler.start();

  const reloaded = scheduler.forThread("task-restart");
  assert.ok(reloaded);
  assert.equal(reloaded.id, saved.id);
  assert.equal(reloaded.prompt, "Check whether PR 42 is approved");
  assert.equal(reloaded.paused, true, "a paused automation does not wake up on restart");
});
