import assert from "node:assert/strict";
import test from "node:test";
import { AutomationChannel } from "../dist/main/main/agent/automation-channel.mjs";
import { automationTools, findingTools } from "../dist/main/main/agent/automation-tools.mjs";

const view = (overrides = {}) => ({
  id: "automation-1",
  taskId: "task-1",
  prompt: "check whether the PR is approved",
  schedule: "* * * * *",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
  runCount: 3,
  nextRunAt: 1_700_000_060_000,
  ...overrides,
});

function fakeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    read: async () => { calls.push(["read"]); return view(); },
    list: async () => { calls.push(["list"]); return [view()]; },
    save: async (draft) => { calls.push(["save", draft]); return view(draft); },
    update: async (patch) => { calls.push(["update", patch]); return view(patch); },
    remove: async () => { calls.push(["remove"]); return true; },
    ...overrides,
  };
}

function toolNamed(bridge, name) {
  const definition = automationTools(bridge).find((entry) => entry.name === name);
  assert.ok(definition, `no ${name} tool`);
  return definition;
}

const textOf = (result) => result.content.map((block) => block.text).join("");

test("the automation tools cover the whole lifecycle and stay scoped to the running task", async () => {
  const bridge = fakeBridge();

  const scheduled = await toolNamed(bridge, "schedule").handler({ prompt: "poll the PR", schedule: "*/5 * * * *", policy: "autonomous" }, {});
  assert.match(textOf(scheduled), /Automation scheduled/);
  assert.deepEqual(bridge.calls.at(-1), ["save", { prompt: "poll the PR", schedule: "*/5 * * * *", policy: "autonomous" }]);
  assert.equal(bridge.calls.at(-1)[1].taskId, undefined, "the agent never chooses which task it schedules");

  const updated = await toolNamed(bridge, "update").handler({ paused: true }, {});
  assert.match(textOf(updated), /Automation updated/);
  assert.deepEqual(bridge.calls.at(-1), ["update", { paused: true }]);

  const status = await toolNamed(bridge, "status").handler({}, {});
  assert.match(textOf(status), /schedule: \* \* \* \* \*/);
  assert.match(textOf(status), /runs so far: 3/);

  const stopped = await toolNamed(bridge, "stop").handler({}, {});
  assert.match(textOf(stopped), /stopped and removed/);
});

test("the tools report a missing automation instead of failing the run", async () => {
  const bridge = fakeBridge({ read: async () => null, remove: async () => false, list: async () => [] });

  assert.match(textOf(await toolNamed(bridge, "status").handler({}, {})), /no automation/);
  assert.match(textOf(await toolNamed(bridge, "stop").handler({}, {})), /no automation/);
  assert.match(textOf(await toolNamed(bridge, "list_all").handler({}, {})), /No automations exist/);
});

test("a rejected schedule comes back as a tool error the model can correct", async () => {
  const bridge = fakeBridge({ save: async () => { throw new Error("Automations run at most once a minute."); } });

  const result = await toolNamed(bridge, "schedule").handler({ prompt: "poll", schedule: "* * * * * *" }, {});

  assert.equal(result.isError, true);
  assert.match(textOf(result), /at most once a minute/);
});

test("bridge calls are correlated back to the caller that made them", async () => {
  const posted = [];
  const channel = new AutomationChannel((request) => posted.push(request));
  const first = channel.bridgeFor("task-1").read();
  const second = channel.bridgeFor("task-2").remove();

  assert.deepEqual(posted.map((request) => [request.taskId, request.op]), [["task-1", "read"], ["task-2", "delete"]]);
  assert.notEqual(posted[0].requestId, posted[1].requestId);

  channel.settle({ type: "automation.response", requestId: posted[1].requestId, ok: true, result: true });
  channel.settle({ type: "automation.response", requestId: posted[0].requestId, ok: true, result: view() });

  assert.equal(await second, true);
  assert.equal((await first).taskId, "task-1");
  assert.equal(channel.settle({ type: "automation.response", requestId: posted[0].requestId, ok: true, result: null }), false, "a duplicate response is ignored");
});

test("a failed or undeliverable request rejects instead of hanging the tool call", async () => {
  const posted = [];
  const channel = new AutomationChannel((request) => posted.push(request));

  const rejected = channel.bridgeFor("task-1").save({ prompt: "poll", schedule: "bad" });
  channel.settle({ type: "automation.response", requestId: posted[0].requestId, ok: false, message: "not a valid schedule" });
  await assert.rejects(rejected, /not a valid schedule/);

  const undeliverable = new AutomationChannel(() => { throw new Error("port closed"); });
  await assert.rejects(undeliverable.bridgeFor("task-1").read(), /port closed/);

  const silent = new AutomationChannel(() => {}, 20);
  await assert.rejects(silent.bridgeFor("task-1").read(), /did not answer the automation "read" request/);
});

test("a settled request stops its own timeout from firing later", async () => {
  const posted = [];
  const channel = new AutomationChannel((request) => posted.push(request), 20);

  const answered = channel.bridgeFor("task-1").read();
  channel.settle({ type: "automation.response", requestId: posted[0].requestId, ok: true, result: view() });
  assert.equal((await answered).taskId, "task-1");

  await new Promise((resolve) => setTimeout(resolve, 40));
});

function findingToolNamed(bridge, name) {
  const definition = findingTools(bridge).find((entry) => entry.name === name);
  assert.ok(definition, `no ${name} tool`);
  return definition;
}

test("the two reporting tools name nothing about the run: the window is what knows which one is calling", async () => {
  const calls = [];
  const bridge = {
    notify: async (report) => { calls.push(["notify", report]); return { recorded: true, note: "Raised. This thread now carries 1 unread finding." }; },
    nothingToReport: async (checked) => { calls.push(["nothing", checked]); return { recorded: true, note: "Noted. This run settles without reaching the user." }; },
  };

  const raised = await findingToolNamed(bridge, "notify").handler({ headline: "5xx on checkout", detail: "12 in an hour", key: "checkout" }, {});
  assert.match(textOf(raised), /1 unread finding/);
  assert.deepEqual(calls.at(-1), ["notify", { headline: "5xx on checkout", detail: "12 in an hour", key: "checkout" }]);

  const silent = await findingToolNamed(bridge, "nothing_to_report").handler({ checked: "the alert feed" }, {});
  assert.match(textOf(silent), /settles without reaching the user/);
  assert.deepEqual(calls.at(-1), ["nothing", "the alert feed"]);
});

test("a report the window cannot keep is a tool error rather than a silent downgrade to nothing", async () => {
  const bridge = {
    notify: async () => { throw new Error("This thread is already carrying 10 unread findings"); },
    nothingToReport: async () => ({ recorded: false, note: "no" }),
  };

  const result = await findingToolNamed(bridge, "notify").handler({ headline: "One too many" }, {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /already carrying 10 unread findings/);
});

test("the reporting tools are offered only where a finding could be read", async () => {
  const bare = automationTools(fakeBridge()).map((entry) => entry.name);
  assert.deepEqual(bare, ["schedule", "status", "update", "stop", "list_all"], "a run with no window to report to is offered neither");
  assert.deepEqual(findingTools({}).map((entry) => entry.name), ["notify", "nothing_to_report"]);
});

test("a schedule says for itself when it is worth surfacing, and can be made loud again", async () => {
  const bridge = fakeBridge();

  await toolNamed(bridge, "schedule").handler({ prompt: "poll Datadog", schedule: "*/30 * * * *", surfaceWhen: "an error was caused by the user's own code." }, {});
  assert.equal(bridge.calls.at(-1)[1].surfaceWhen, "an error was caused by the user's own code.");

  await toolNamed(bridge, "update").handler({ surfaceWhen: "" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["update", { surfaceWhen: "" }]);

  const status = await toolNamed(bridge, "status").handler({}, {});
  assert.doesNotMatch(textOf(status), /surfaces when/, "a loud automation says nothing about surfacing");
  const quiet = await toolNamed(fakeBridge({ read: async () => view({ surfaceWhen: "there is an error." }) }), "status").handler({}, {});
  assert.match(textOf(quiet), /surfaces when: there is an error\./);
});
