import assert from "node:assert/strict";
import { test } from "vitest";
import type { WorkspaceCommandResult } from "../../src/application/workspace-reducer.ts";
import type { LoadedTaskStore, PersistedTask, TaskStoreDelta } from "../../src/contracts/task-store.ts";
import type { WorkspaceRequest, WorkspaceResponse } from "../../src/contracts/workspace-runtime.ts";
import type { AutomationView } from "../../src/domain/automation.ts";
import { TaskDatabase } from "../../src/main/task-database.mts";
import { registered, startMainProcess, waitFor, type MainHarness } from "../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };

function holdRuntimeFlushes(main: MainHarness) {
  const runtime = main.runtimeViews[0];
  assert.ok(runtime);
  const requests: WorkspaceRequest[] = [];
  const send = runtime.webContents.send;
  runtime.webContents.send = (channel, event) => {
    if (channel === "workspace-runtime:request" && (event as WorkspaceRequest).flush) {
      runtime.webContents.sent.push({ channel, event });
      requests.push(event as WorkspaceRequest);
      return;
    }
    send(channel, event);
  };
  const respond = registered<(event: IpcEvent, response: WorkspaceResponse) => void>(main.listeners, "workspace-runtime:response");
  return {
    runtime,
    requests,
    acknowledge: (index: number, result: WorkspaceCommandResult = { ok: true }) => {
      assert.ok(requests[index]);
      respond({ sender: runtime.webContents }, { id: requests[index].id, result: { ...result, revision: 0 } });
    },
  };
}

async function agentFor(main: MainHarness) {
  registered<(event: IpcEvent, command: unknown) => void>(main.listeners, "run:command")(
    { sender: main.runtimeViews[0].webContents },
    { type: "stop-process", taskId: "test", processId: "test" },
  );
  await waitFor(() => main.agents.length > 0);
  return main.agents[0];
}

const task: PersistedTask = {
  id: "saved", title: "Pending messages", engine: "claude", executionPolicy: "confirm", continuationStatus: "none",
  lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
};

test("quit waits for both runtime flushes and leaves storage open for their final writes", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-quit-", { computerUse: { stopComputerUse: async () => {} } });
  const held = holdRuntimeFlushes(main);
  const agent = await agentFor(main);
  let killed = 0;
  agent.kill = () => { killed += 1; };
  const event = { sender: held.runtime.webContents };
  const persist = registered<(event: IpcEvent, delta: TaskStoreDelta) => Promise<void>>(main.handlers, "task-store:persist");
  const load = registered<(event: IpcEvent) => Promise<LoadedTaskStore | null>>(main.handlers, "task-store:load");

  main.app.quit();
  await waitFor(() => held.requests.length === 1);
  assert.equal(killed, 0);
  assert.equal(main.completedQuits(), 0);
  await persist(event, { tasks: [{ task, messages: [{ index: 0, message: { id: "before", kind: "assistant", text: "Before cleanup", at: 1 } }] }] });
  assert.equal((await load(event))!.tasks[0].historySummary!.messageCount, 1);
  main.app.quit();
  assert.equal(held.requests.length, 1, "repeated quit requests share the outstanding flush");

  held.acknowledge(0);
  await waitFor(() => held.requests.length === 2);
  assert.equal(killed, 1);
  assert.equal(main.completedQuits(), 0);
  await persist(event, { tasks: [{ task, messages: [{ index: 1, message: { id: "after", kind: "system", text: "After cleanup", at: 2 } }] }] });
  assert.equal((await load(event))!.tasks[0].historySummary!.messageCount, 2);
  held.acknowledge(1);
  await waitFor(() => main.completedQuits() === 1);

  const reopened = new TaskDatabase(`${main.userData}/tasks.v3.sqlite`);
  try {
    assert.deepEqual(reopened.loadThreadMessages(task.id).map((message) => message.text), ["Before cleanup", "After cleanup"]);
  } finally {
    reopened.close();
  }
});

test("a refused initial flush keeps the app and its agent usable and allows quit to be retried", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-flush-failure-", { computerUse: { stopComputerUse: async () => {} } });
  const held = holdRuntimeFlushes(main);
  const agent = await agentFor(main);
  let killed = 0;
  agent.kill = () => { killed += 1; };
  main.app.quit();
  await waitFor(() => held.requests.length === 1);
  held.acknowledge(0, { ok: false, message: "disk full" });
  await waitFor(() => main.messageBoxes.some((box) => box.content === "disk full"));
  assert.equal(main.completedQuits(), 0);
  assert.equal(killed, 0);
  assert.equal(main.window.isVisible(), true);
  const persist = registered<(event: IpcEvent, delta: TaskStoreDelta) => Promise<void>>(main.handlers, "task-store:persist");
  await persist({ sender: held.runtime.webContents }, { tasks: [] });

  main.app.quit();
  await waitFor(() => held.requests.length === 2);
  held.acknowledge(1);
  await waitFor(() => held.requests.length === 3);
  held.acknowledge(2);
  await waitFor(() => main.completedQuits() === 1);
});

test("a refused final flush keeps storage open and restores scheduled work", async (t) => {
  let computerUseResumed = false;
  const main = await startMainProcess(t, "aicodingtool-runtime-final-flush-", { computerUse: { stopComputerUse: async () => {}, resumeComputerUse: () => { computerUseResumed = true; } } });
  const held = holdRuntimeFlushes(main);
  const event = { sender: held.runtime.webContents };
  const saveAutomation = registered<(event: IpcEvent, draft: unknown) => Promise<AutomationView>>(main.handlers, "automation:save");
  const listAutomations = registered<(event: IpcEvent) => AutomationView[]>(main.handlers, "automation:list");
  await saveAutomation(event, { taskId: "scheduled", prompt: "Poll", schedule: `${(new Date().getMinutes() + 30) % 60} * * * *` });
  main.app.quit();
  await waitFor(() => held.requests.length === 1);
  held.acknowledge(0);
  await waitFor(() => held.requests.length === 2);
  held.acknowledge(1, { ok: false, message: "final save failed" });
  await waitFor(() => main.messageBoxes.some((box) => box.content === "final save failed"));
  assert.equal(main.completedQuits(), 0);
  assert.equal(main.window.isVisible(), true);
  const restored = listAutomations(event)[0];
  assert.ok(restored);
  assert.notEqual(restored.nextRunAt, null, "aborting quit must rearm the schedules stopped during cleanup");
  assert.equal(computerUseResumed, true, "canceling shutdown allows new computer-use runs");
  const load = registered<(event: IpcEvent) => Promise<LoadedTaskStore | null>>(main.handlers, "task-store:load");
  await assert.doesNotReject(load(event));
});

test("run events continue reaching the runtime while the visible view is unavailable", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-events-", { computerUse: { stopComputerUse: async () => {} } });
  const runtime = main.runtimeViews[0];
  const agent = await agentFor(main);
  main.window.destroyed = true;
  try {
    const started = { type: "run.started", taskId: "background", runId: "run", sequence: 1 };
    const reply = { type: "assistant.delta", taskId: "background", runId: "run", sequence: 2, messageId: "message", text: "Still running" };
    agent.emit("message", started);
    agent.emit("message", reply);
    const events = runtime.webContents.sent.filter((entry) => entry.channel === "run:event").map((entry) => entry.event);
    assert.deepEqual(events.slice(-2), [started, reply]);
    assert.equal(main.window.webContents.sent.some((entry) => entry.channel === "run:event"), false);
  } finally {
    main.window.destroyed = false;
  }
});
