import assert from "node:assert/strict";
import test from "node:test";
import { AutomationScheduler, assertSchedule } from "../dist/main/main/automation/automation-scheduler.mjs";

function memoryStore(initial = []) {
  const rows = new Map(initial.map((automation) => [automation.id, automation]));
  return {
    rows,
    listAutomations: () => [...rows.values()],
    saveAutomation: (automation) => { rows.set(automation.id, automation); },
    deleteAutomation: (id) => { rows.delete(id); },
  };
}

function fixedClock(start = 1_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => { value += ms; },
  };
}

/** An hour out, so nothing in these tests races a real tick. */
const HOURLY = "0 * * * *";

/** Croner timers hold the event loop open, so every scheduler is torn down even when a test fails. */
function schedulerFor(t, store, dispatch, options) {
  const scheduler = new AutomationScheduler(store, dispatch, options);
  t.after(() => scheduler.stop());
  return scheduler;
}

test("schedules are rejected before they can be stored", (t) => {
  assert.throws(() => assertSchedule("*/30 * * * * *"), /at most once a minute/);
  assert.throws(() => assertSchedule("not a schedule"), /not a valid schedule/);
  assert.throws(() => assertSchedule("2020-01-01T00:00:00Z"), /no future run/);
  assert.doesNotThrow(() => assertSchedule("* * * * *"));
  assert.doesNotThrow(() => assertSchedule("0 8 * * *", "America/Los_Angeles"));
});

test("a task keeps exactly one automation and creating a second one replaces it", (t) => {
  const store = memoryStore();
  const clock = fixedClock();
  const scheduler = schedulerFor(t, store, async () => "succeeded", { now: clock.now });

  const first = scheduler.save({ taskId: "task-1", prompt: "check the PR", schedule: HOURLY });
  clock.advance(5);
  const second = scheduler.save({ taskId: "task-1", prompt: "check the PR again", schedule: "0 8 * * *" });

  assert.equal(second.id, first.id);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.updatedAt, 1_005);
  assert.equal(second.prompt, "check the PR again");
  assert.equal(scheduler.list().length, 1);
  assert.equal(store.rows.size, 1);
});

test("an invalid schedule leaves the stored automation untouched", (t) => {
  const store = memoryStore();
  const scheduler = schedulerFor(t, store, async () => "succeeded");
  scheduler.save({ taskId: "task-1", prompt: "poll", schedule: HOURLY });

  assert.throws(() => scheduler.update("task-1", { schedule: "*/5 * * * * *" }), /at most once a minute/);
  assert.equal(scheduler.forTask("task-1").schedule, HOURLY);
  assert.throws(() => scheduler.update("task-missing", { paused: true }), /no automation/);
});

test("a run records its outcome, and a skipped tick is not counted as a run", async (t) => {
  const store = memoryStore();
  const clock = fixedClock();
  let outcome = "succeeded";
  const scheduler = schedulerFor(t, store, async () => outcome, { now: clock.now });
  scheduler.save({ taskId: "task-1", prompt: "poll", schedule: HOURLY });

  clock.advance(60);
  assert.equal(await scheduler.runNow("task-1"), "succeeded");
  assert.equal(scheduler.forTask("task-1").runCount, 1);
  assert.equal(scheduler.forTask("task-1").lastRunAt, 1_060);
  assert.equal(scheduler.forTask("task-1").lastStatus, "succeeded");

  outcome = "skipped";
  clock.advance(60);
  await scheduler.runNow("task-1");
  assert.equal(scheduler.forTask("task-1").runCount, 1, "a skipped tick never ran");
  assert.equal(scheduler.forTask("task-1").lastRunAt, 1_060, "last run still points at the real run");
  assert.equal(scheduler.forTask("task-1").lastStatus, "skipped");

  outcome = "failed";
  await scheduler.runNow("task-1");
  assert.equal(scheduler.forTask("task-1").runCount, 2);
  assert.equal(store.rows.get(scheduler.forTask("task-1").id).lastStatus, "failed", "outcomes survive a restart");
});

test("a dispatch that throws settles the run as failed instead of wedging the automation", async (t) => {
  const scheduler = schedulerFor(t, memoryStore(), async () => { throw new Error("renderer is gone"); });
  scheduler.save({ taskId: "task-1", prompt: "poll", schedule: HOURLY });

  assert.equal(await scheduler.runNow("task-1"), "failed");
  assert.equal(await scheduler.runNow("task-1"), "failed", "the automation still accepts the next tick");
});

test("a second run is refused while the first is still in flight", async (t) => {
  const releases = [];
  const scheduler = schedulerFor(t, memoryStore(), () => new Promise((resolve) => releases.push(resolve)));
  scheduler.save({ taskId: "task-1", prompt: "poll", schedule: HOURLY });

  const running = scheduler.runNow("task-1");
  assert.equal(await scheduler.runNow("task-1"), "busy");
  assert.equal(releases.length, 1, "the refused tick never reached the renderer");

  releases[0]("succeeded");
  assert.equal(await running, "succeeded");

  const next = scheduler.runNow("task-1");
  assert.equal(releases.length, 2, "the next tick runs once the previous one settles");
  releases[1]("succeeded");
  assert.equal(await next, "succeeded");
});

test("a run that meets its stop condition deletes the automation and is not resurrected", async (t) => {
  const store = memoryStore();
  const scheduler = schedulerFor(t, store, async (automation) => {
    scheduler.remove(automation.taskId);
    return "succeeded";
  });
  scheduler.save({ taskId: "task-1", prompt: "watch the PR until it is approved", schedule: HOURLY });

  await scheduler.runNow("task-1");

  assert.equal(scheduler.forTask("task-1"), null);
  assert.equal(scheduler.list().length, 0);
  assert.equal(store.rows.size, 0, "the deleted automation is not rewritten by the run's bookkeeping");
});

test("a one-shot automation fires at its scheduled time and then retires itself", async (t) => {
  const store = memoryStore();
  const when = new Date(Math.ceil((Date.now() + 1_200) / 1_000) * 1_000).toISOString();
  let fired;
  const ran = new Promise((resolve) => { fired = resolve; });
  const scheduler = schedulerFor(t, store, async () => { fired(); return "succeeded"; });
  scheduler.save({ taskId: "task-1", prompt: "ship the release", schedule: when });
  assert.equal(scheduler.forTask("task-1").nextRunAt, Date.parse(when));

  await ran;
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(scheduler.forTask("task-1"), null, "a spent one-shot does not linger in the panel");
  assert.equal(store.rows.size, 0);
});

test("a one-shot whose moment is skipped is kept and marked missed, not deleted", async (t) => {
  const store = memoryStore();
  const when = new Date(Math.ceil((Date.now() + 1_200) / 1_000) * 1_000).toISOString();
  let declined;
  const refused = new Promise((resolve) => { declined = resolve; });
  const scheduler = schedulerFor(t, store, async () => { declined(); return "skipped"; });
  scheduler.save({ taskId: "task-1", prompt: "ship the release", schedule: when });

  await refused;
  await new Promise((resolve) => setTimeout(resolve, 50));

  const missed = scheduler.forTask("task-1");
  assert.ok(missed, "a one-shot that never ran is not thrown away");
  assert.equal(missed.lastStatus, "missed");
  assert.equal(missed.runCount, 0);
  assert.equal(missed.nextRunAt, null);
  assert.equal(store.rows.size, 1, "and it survives a restart so the user can re-arm it");
});

test("a one-shot missed while the app was closed reloads as missed rather than armed", (t) => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const store = memoryStore([
    { id: "gone", taskId: "task-past", prompt: "ship the release", schedule: past, paused: false, createdAt: 1, updatedAt: 1, runCount: 0 },
  ]);
  const scheduler = schedulerFor(t, store, async () => "succeeded");

  scheduler.start();

  const reloaded = scheduler.forTask("task-past");
  assert.equal(reloaded.lastStatus, "missed");
  assert.equal(reloaded.nextRunAt, null);
  assert.equal(store.rows.get("gone").lastStatus, "missed", "the verdict is written down, not recomputed every launch");
});

test("re-running a missed one-shot by hand retires it", async (t) => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const store = memoryStore([
    { id: "gone", taskId: "task-past", prompt: "ship the release", schedule: past, paused: false, createdAt: 1, updatedAt: 1, runCount: 0 },
  ]);
  const scheduler = schedulerFor(t, store, async () => "succeeded");
  scheduler.start();

  assert.equal(await scheduler.runNow("task-past"), "succeeded");

  assert.equal(scheduler.forTask("task-past"), null);
  assert.equal(store.rows.size, 0);
});

test("running a one-shot early leaves it armed for its real time", async (t) => {
  const store = memoryStore();
  const when = new Date(Math.floor((Date.now() + 3_600_000) / 1_000) * 1_000).toISOString();
  const scheduler = schedulerFor(t, store, async () => "succeeded");
  scheduler.save({ taskId: "task-1", prompt: "ship the release", schedule: when });

  await scheduler.runNow("task-1");

  assert.equal(scheduler.forTask("task-1").runCount, 1);
  assert.equal(scheduler.forTask("task-1").nextRunAt, Date.parse(when));
});

test("pausing stops the countdown without discarding the automation", (t) => {
  const store = memoryStore();
  const scheduler = schedulerFor(t, store, async () => "succeeded");
  scheduler.save({ taskId: "task-1", prompt: "poll", schedule: HOURLY });
  assert.notEqual(scheduler.forTask("task-1").nextRunAt, null);

  const paused = scheduler.update("task-1", { paused: true });
  assert.equal(paused.paused, true);
  assert.equal(paused.nextRunAt, null);
  assert.equal(store.rows.size, 1);

  assert.notEqual(scheduler.update("task-1", { paused: false }).nextRunAt, null);
});

test("stored automations are rearmed on start and broadcast to the panel on every change", (t) => {
  const store = memoryStore([{
    id: "automation-1",
    taskId: "task-1",
    prompt: "poll",
    schedule: HOURLY,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    runCount: 4,
  }]);
  const broadcasts = [];
  const scheduler = schedulerFor(t, store, async () => "succeeded", { onChange: (views) => broadcasts.push(views) });

  scheduler.start();
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0][0].runCount, 4);
  assert.notEqual(broadcasts[0][0].nextRunAt, null, "a reloaded automation is armed again");

  scheduler.remove("task-1");
  assert.deepEqual(broadcasts.at(-1), []);
});

test("a stored schedule this build cannot parse is skipped instead of blocking startup", (t) => {
  const store = memoryStore([
    { id: "broken", taskId: "task-broken", prompt: "poll", schedule: "nonsense", paused: false, createdAt: 1, updatedAt: 1, runCount: 0 },
    { id: "sound", taskId: "task-sound", prompt: "poll", schedule: HOURLY, paused: false, createdAt: 1, updatedAt: 1, runCount: 0 },
  ]);
  const scheduler = schedulerFor(t, store, async () => "succeeded");

  assert.doesNotThrow(() => scheduler.start());

  assert.equal(scheduler.forTask("task-broken").nextRunAt, null, "the broken automation is never armed");
  assert.notEqual(scheduler.forTask("task-sound").nextRunAt, null, "and it does not take the others down with it");
});

test("a paused automation stays paused across a restart", (t) => {
  const store = memoryStore();
  const first = schedulerFor(t, store, async () => "succeeded");
  first.save({ taskId: "task-1", prompt: "poll", schedule: HOURLY, paused: true });
  first.stop();

  const second = schedulerFor(t, store, async () => "succeeded");
  second.start();
  assert.equal(second.forTask("task-1").paused, true);
  assert.equal(second.forTask("task-1").nextRunAt, null);
});
