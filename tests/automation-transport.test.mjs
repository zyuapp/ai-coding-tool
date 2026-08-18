import assert from "node:assert/strict";
import test from "node:test";
import { startMainProcess, waitFor } from "./support/electron-harness.mjs";

/** An hour out, so a real tick never races the manual runs these tests drive. */
const HOURLY = "0 * * * *";

/** Booting main starts a Vite server, so every test in this file shares one and works on its own task. */
let main;
test.before(async () => { main = await startMainProcess(null, "claudex-automation-"); });
test.after(async () => { await main?.dispose(); });

const draft = (taskId, overrides = {}) => ({ taskId, prompt: "Check whether PR 42 is approved", schedule: HOURLY, ...overrides });

const automationFor = async (taskId) => (await main.handlers.get("automation:list")(main.trusted)).find((view) => view.taskId === taskId);

const latestFor = (channel, taskId) => main.sentOn(channel).at(-1).filter((view) => view.taskId === taskId);

/** Stands in for the renderer: takes each tick, answers the acknowledgement, and reports how the run ended. */
function renderer(automationId) {
  const fires = () => main.sentOn("automation:fire").filter((fire) => fire.automationId === automationId);
  let handled = 0;
  return async ({ start = true, outcome = "succeeded" } = {}) => {
    await waitFor(() => fires().length > handled, "the scheduler to fire");
    const fire = fires()[handled];
    handled += 1;
    main.listeners.get("automation:ack")(main.trusted, { automationId: fire.automationId, runId: fire.runId, started: start });
    if (start) {
      main.agents[0].emit("message", { type: "run.started", taskId: fire.taskId, runId: fire.runId, sequence: 1 });
      main.agents[0].emit("message", { type: "run.status", taskId: fire.taskId, runId: fire.runId, sequence: 2, status: outcome });
    }
    return fire;
  };
}

test("the automation IPC surface rejects untrusted senders and malformed schedules", async () => {
  await assert.rejects(async () => main.handlers.get("automation:list")(main.untrusted), /Untrusted/);
  await assert.rejects(async () => main.handlers.get("automation:save")(main.untrusted, draft("task-guards")), /Untrusted/);
  await assert.rejects(async () => main.handlers.get("automation:delete")(main.untrusted, "task-guards"), /Untrusted/);

  await assert.rejects(async () => main.handlers.get("automation:save")(main.trusted, { taskId: "task-guards", prompt: "poll" }), /Invalid automation/);
  await assert.rejects(async () => main.handlers.get("automation:save")(main.trusted, draft("task-guards", { schedule: "*/10 * * * * *" })), /at most once a minute/);
  await assert.rejects(async () => main.handlers.get("automation:update")(main.trusted, "task-guards", { paused: "yes" }), /Invalid automation change/);
  await assert.rejects(async () => main.handlers.get("automation:update")(main.trusted, "task-guards", { paused: true }), /no automation/);

  assert.equal(await automationFor("task-guards"), undefined, "nothing invalid was stored");
});

test("saving an automation arms it and pushes the new state to the panel", async () => {
  const saved = await main.handlers.get("automation:save")(main.trusted, draft("task-save"));

  assert.equal(saved.runCount, 0);
  assert.ok(saved.nextRunAt > Date.now(), "a saved automation is armed");
  assert.deepEqual(latestFor("automation:changed", "task-save").map((view) => view.id), [saved.id]);

  assert.equal(await main.handlers.get("automation:delete")(main.trusted, "task-save"), true);
  assert.deepEqual(latestFor("automation:changed", "task-save"), []);
  assert.equal(await main.handlers.get("automation:delete")(main.trusted, "task-save"), false);
});

test("a tick reaches the renderer and its run outcome comes back to the scheduler", async () => {
  const saved = await main.handlers.get("automation:save")(main.trusted, draft("task-tick", { policy: "autonomous" }));
  const takeTick = renderer(saved.id);

  const running = main.handlers.get("automation:run-now")(main.trusted, "task-tick");
  const fire = await takeTick();
  assert.equal(await running, "succeeded");

  assert.equal(fire.taskId, "task-tick");
  assert.equal(fire.prompt, "Check whether PR 42 is approved");
  assert.equal(fire.policy, "autonomous", "the automation's policy travels with the tick");
  assert.equal(fire.runNumber, 1);

  const ran = await automationFor("task-tick");
  assert.equal(ran.runCount, 1);
  assert.equal(ran.lastStatus, "succeeded");

  const failing = main.handlers.get("automation:run-now")(main.trusted, "task-tick");
  assert.equal((await takeTick({ outcome: "failed" })).runNumber, 2);
  assert.equal(await failing, "failed");

  const failed = await automationFor("task-tick");
  assert.equal(failed.runCount, 2, "a failed run still counts");
  assert.ok(failed.nextRunAt > Date.now(), "and the automation keeps its schedule");
});

test("a renderer that declines the tick leaves the automation untouched", async () => {
  const saved = await main.handlers.get("automation:save")(main.trusted, draft("task-declined"));

  const running = main.handlers.get("automation:run-now")(main.trusted, "task-declined");
  await renderer(saved.id)({ start: false });

  assert.equal(await running, "skipped");
  const view = await automationFor("task-declined");
  assert.equal(view.runCount, 0);
  assert.equal(view.lastStatus, "skipped");
  assert.ok(view.nextRunAt > Date.now(), "a declined tick does not disarm the automation");
});

test("the agent process schedules and stops automations for the task it is running", async () => {
  const agent = main.agents[0];
  const respondTo = async (request) => {
    const before = agent.messages.length;
    agent.emit("message", request);
    await waitFor(() => agent.messages.length > before, `a response to ${request.op}`);
    return agent.messages.at(-1);
  };

  const scheduled = await respondTo({ type: "automation.request", requestId: "request-1", taskId: "task-agent", op: "save", draft: { prompt: "Babysit PR 42", schedule: HOURLY } });
  assert.equal(scheduled.type, "automation.response");
  assert.equal(scheduled.requestId, "request-1");
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.result.taskId, "task-agent", "the agent's automation is bound to its own task");
  assert.deepEqual(latestFor("automation:changed", "task-agent").map((view) => view.prompt), ["Babysit PR 42"]);

  const read = await respondTo({ type: "automation.request", requestId: "request-2", taskId: "task-agent", op: "read" });
  assert.equal(read.result.prompt, "Babysit PR 42");

  const other = await respondTo({ type: "automation.request", requestId: "request-3", taskId: "task-unrelated", op: "read" });
  assert.equal(other.result, null, "a run cannot read another task's automation");

  const rejected = await respondTo({ type: "automation.request", requestId: "request-4", taskId: "task-agent", op: "update", patch: { schedule: "nonsense" } });
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /not a valid schedule/);

  const stopped = await respondTo({ type: "automation.request", requestId: "request-5", taskId: "task-agent", op: "delete" });
  assert.equal(stopped.result, true);
  assert.equal(await automationFor("task-agent"), undefined, "the stop condition ends the automation");
  assert.deepEqual(latestFor("automation:changed", "task-agent"), []);
});

test("a run that stops its own automation mid-tick is not resurrected by the tick's bookkeeping", async () => {
  const saved = await main.handlers.get("automation:save")(main.trusted, draft("task-stop"));
  const agent = main.agents[0];
  const fires = () => main.sentOn("automation:fire").filter((fire) => fire.automationId === saved.id);

  const running = main.handlers.get("automation:run-now")(main.trusted, "task-stop");
  await waitFor(() => fires().length === 1, "the scheduler to fire");
  const fire = fires()[0];
  main.listeners.get("automation:ack")(main.trusted, { automationId: fire.automationId, runId: fire.runId, started: true });

  agent.emit("message", { type: "run.started", taskId: fire.taskId, runId: fire.runId, sequence: 1 });
  agent.emit("message", { type: "automation.request", requestId: "stop-request", taskId: "task-stop", op: "delete" });
  await waitFor(() => agent.messages.some((message) => message.requestId === "stop-request"), "the stop response");
  agent.emit("message", { type: "run.status", taskId: fire.taskId, runId: fire.runId, sequence: 2, status: "succeeded" });

  assert.equal(await running, "succeeded");
  assert.equal(await automationFor("task-stop"), undefined);
});

test("automations survive a restart of the app", async (t) => {
  const saved = await main.handlers.get("automation:save")(main.trusted, draft("task-restart", { paused: true }));

  const { TaskDatabase } = await import("../dist/main/main/task-database.mjs");
  const { AutomationScheduler } = await import("../dist/main/main/automation/automation-scheduler.mjs");
  const database = new TaskDatabase(`${main.userData}/tasks.v3.sqlite`);
  const scheduler = new AutomationScheduler(database, async () => "succeeded");
  t.after(() => { scheduler.stop(); database.close(); });
  scheduler.start();

  const reloaded = scheduler.forTask("task-restart");
  assert.equal(reloaded.id, saved.id);
  assert.equal(reloaded.prompt, "Check whether PR 42 is approved");
  assert.equal(reloaded.paused, true, "a paused automation does not wake up on restart");
});
