import assert from "node:assert/strict";
import { chmod, readFile } from "node:fs/promises";
import { test } from "vitest";
import type { WorkspaceCommandResult, WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { TaskDatabase } from "../../src/main/task-database.mts";
import { registered, startMainProcess, waitFor, type MainHarness } from "../support/electron-harness.mjs";

type IpcEvent = { sender: unknown };
type Result = WorkspaceCommandResult & { revision: number };

function requester(main: MainHarness) {
  const request = registered<(event: IpcEvent, input?: WorkspaceInput) => Promise<Result>>(main.handlers, "workspace-runtime:request");
  return (input: WorkspaceInput) => request(main.trusted, input);
}

/** Starts a thread in no project, which is the least a persisted thread takes. */
async function startThread(main: MainHarness, text: string) {
  const request = requester(main);
  await request({ type: "task.new" });
  await request({ type: "view.set-prompt", prompt: text });
  const sent = await request({ type: "task.send", attachments: [] });
  assert.ok(sent.ok, sent.ok ? "" : sent.message);
  await waitFor(() => main.agents.length > 0, "an agent process for the run");
  const state = await main.runtimeState();
  const thread = state.threads.find((item) => item.messages.some((message) => message.text === text));
  assert.ok(thread, "the thread the send created");
  return thread;
}

test("quit waits for the runtime's writes and leaves storage open for them", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-quit-", { computerUse: { computerUseForRun: async () => ({ status: "unavailable", message: "test" }), stopComputerUse: async () => {} } });
  const thread = await startThread(main, "Before quit");
  await requester(main)({ type: "task.rename", taskId: thread.id, title: "Renamed on the way out" });

  main.app.quit();
  main.app.quit();
  await waitFor(() => main.completedQuits() === 1);

  const reopened = new TaskDatabase(`${main.userData}/tasks.v3.sqlite`);
  try {
    const stored = reopened.load()!.tasks.find((task) => task.id === thread.id);
    assert.equal(stored?.title, "Renamed on the way out");
    assert.deepEqual(reopened.loadThreadMessages(thread.id).map((message) => message.text), ["Before quit"]);
  } finally {
    reopened.close();
  }
});

test("a refused write keeps the app usable and lets quit be tried again", { skip: process.platform === "win32" }, async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-flush-failure-", { computerUse: { computerUseForRun: async () => ({ status: "unavailable", message: "test" }), stopComputerUse: async () => {} } });
  const thread = await startThread(main, "Before the disk filled");
  const agent = main.agents[0]!;
  let killed = 0;
  agent.kill = () => { killed += 1; };
  /** A folder that takes no new files refuses the file a draft is written through, which is what a full disk looks like. */
  await chmod(main.userData, 0o500);
  t.onTestFinished(() => chmod(main.userData, 0o700));
  await requester(main)({ type: "view.set-prompt", taskId: thread.id, prompt: "Typed while refused" });

  main.app.quit();
  await waitFor(() => main.messageBoxes.length > 0, "the error box");
  assert.equal(main.messageBoxes[0].title, "Could not save the workspace");
  assert.equal(main.completedQuits(), 0);
  assert.equal(killed, 0, "the agent keeps running for a quit that did not happen");
  assert.equal(main.window.isVisible(), true);

  await chmod(main.userData, 0o700);
  main.app.quit();
  await waitFor(() => main.completedQuits() === 1);
  assert.ok(killed >= 1, "the agent is stopped by the shutdown that did happen");
  const drafts = JSON.parse(await readFile(`${main.userData}/window.v1.json`, "utf8")) as Record<string, string>;
  assert.equal(JSON.parse(drafts["aicodingtool.draft-prompts.v1"]!)[thread.id], "Typed while refused", "the draft lands once the disk takes it");
});

test("run events keep reaching the runtime while the visible view is unavailable", async (t) => {
  const main = await startMainProcess(t, "aicodingtool-runtime-events-", { computerUse: { computerUseForRun: async () => ({ status: "unavailable", message: "test" }), stopComputerUse: async () => {} } });
  const thread = await startThread(main, "Background work");
  const agent = main.agents[0]!;
  const command = agent.messages.find((message) => message.type === "start") as { runId: string } | undefined;
  assert.ok(command);
  main.window.destroyed = true;
  agent.emit("message", { type: "run.started", taskId: thread.id, runId: command.runId, sequence: 1 });
  agent.emit("message", { type: "assistant.delta", taskId: thread.id, runId: command.runId, sequence: 2, messageId: "reply", text: "Done while hidden" });
  agent.emit("message", { type: "run.status", taskId: thread.id, runId: command.runId, sequence: 3, status: "succeeded" });
  main.window.destroyed = false;
  await waitFor(async () => (await main.runtimeState()).threads.find((item) => item.id === thread.id)?.messages.some((message) => message.text === "Done while hidden"), "the reply landing in the transcript");
});
