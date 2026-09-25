import assert from "node:assert/strict";
import { test, afterAll, beforeAll } from "vitest";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { registered, startMainProcess, waitFor, type MainHarness } from "../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };
type Result = WorkspaceCommandResult & { revision: number };

let main: MainHarness;
beforeAll(async () => {
  main = await startMainProcess(null, "aicodingtool-notice-", { computerUse: { computerUseForRun: async () => ({ status: "unavailable", message: "test" }), stopComputerUse: async () => {} } });
});
afterAll(async () => { await main?.dispose(); });

const request = (input: WorkspaceInput) => registered<(event: IpcEvent, input?: WorkspaceInput) => Promise<Result>>(main.handlers, "workspace-runtime:request")(main.trusted, input);

/** Starts a thread and lets its run finish, which is what a notice is raised over. */
async function finishedThread(text: string) {
  await request({ type: "task.new" });
  await request({ type: "view.set-prompt", prompt: text });
  const sent = await request({ type: "task.send", attachments: [] });
  assert.ok(sent.ok && sent.taskId, sent.ok ? "" : sent.message);
  const taskId = sent.taskId;
  await waitFor(() => main.agents.at(-1)?.messages.some((message) => message.type === "start" && message.taskId === taskId), "the run reaching the agent");
  const agent = main.agents.at(-1)!;
  const start = agent.messages.findLast((message) => message.type === "start" && message.taskId === taskId) as { runId: string };
  agent.emit("message", { type: "run.started", taskId, runId: start.runId, sequence: 1 });
  agent.emit("message", { type: "assistant.delta", taskId, runId: start.runId, sequence: 2, messageId: `${taskId}-reply`, text: "5xx on checkout since 02:10" });
  agent.emit("message", { type: "run.status", taskId, runId: start.runId, sequence: 3, status: "succeeded" });
  await waitFor(async () => (await main.runtimeState()).threads.find((thread) => thread.id === taskId)?.outcome === "finished", "the run settling");
  return taskId;
}

/** Runs a settled thread again while another is on screen, and waits for the run to reach the agent. */
async function runAgain(taskId: string) {
  const agent = main.agents.at(-1)!;
  const before = agent.messages.filter((message) => message.type === "start" && message.taskId === taskId).length;
  await request({ type: "task.send", taskId, text: "Again", attachments: [] });
  await waitFor(() => agent.messages.filter((message) => message.type === "start" && message.taskId === taskId).length > before, "the second run reaching the agent");
  const start = agent.messages.findLast((message) => message.type === "start" && message.taskId === taskId) as { runId: string };
  agent.emit("message", { type: "run.started", taskId, runId: start.runId, sequence: 1 });
  agent.emit("message", { type: "run.status", taskId, runId: start.runId, sequence: 2, status: "succeeded" });
}

test("a run finishing while the user is elsewhere is carried by the desktop, and the click brings its thread back", async () => {
  await request({ type: "view.set-focused", focused: false });
  const first = await finishedThread("Watch the checkout");
  const second = await finishedThread("Watch the search");
  await request({ type: "task.select", taskId: first });
  const before = main.notifications.length;
  await runAgain(second);
  await waitFor(() => main.notifications.length > before, "the desktop notice");
  const raised = main.notifications.at(-1)!;
  assert.equal(raised.options.title, "Watch the search");
  assert.equal(raised.options.silent, true);
  assert.equal(raised.shown, true);

  const revealed: unknown[] = [];
  const focus = main.app.focus;
  main.app.focus = (options?: unknown) => { revealed.push(options); };
  try {
    raised.click();
  } finally {
    main.app.focus = focus;
  }
  assert.deepEqual(revealed, [{ steal: true }]);
  assert.equal(main.sentOn("window:open-thread").at(-1), second);
});

test("a window the user is already looking at announces nothing", async () => {
  main.window.focused = true;
  const before = main.notifications.length;
  try {
    await request({ type: "view.set-focused", focused: true });
    const first = await finishedThread("Quiet watch");
    const second = await finishedThread("Quiet watch, second thread");
    await request({ type: "task.select", taskId: first });
    await runAgain(second);
    await waitFor(async () => (await main.runtimeState()).threads.find((thread) => thread.id === second)?.outcomeUnread === true, "the run settling behind the thread on screen");
  } finally {
    main.window.focused = false;
  }
  assert.equal(main.notifications.length, before, "the user is already in front of the window");
});

test("the app icon carries the count of threads the user has not seen", async () => {
  await request({ type: "view.set-focused", focused: false });
  const first = await finishedThread("Count me");
  const second = await finishedThread("Count me too");
  await request({ type: "task.select", taskId: first });
  const before = main.badgeCounts.at(-1) ?? 0;
  await runAgain(second);
  await waitFor(() => (main.badgeCounts.at(-1) ?? 0) > before, "a mark on the icon");
  await request({ type: "task.dismiss-all" });
  await waitFor(() => main.badgeCounts.at(-1) === 0, "the mark coming off");
});
