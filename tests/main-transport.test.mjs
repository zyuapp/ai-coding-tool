import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { startMainProcess, tick, waitFor } from "./support/electron-harness.mjs";

test("main transport validates, correlates, cancels, supersedes per task, and fails runs", async (t) => {
  const { userData, handlers, listeners, agents, protocolHandlers, window, trusted, untrusted } = await startMainProcess(t, "claudex-main-");

  const runCommand = listeners.get("run:command");
  const saved = await handlers.get("attachment:save")(trusted, Buffer.from([1, 2, 3]).toString("base64"));
  assert.equal(path.dirname(saved), path.join(userData, "attachments"));
  await assert.rejects(handlers.get("attachment:save")(untrusted, "AQID"));
  await assert.rejects(handlers.get("attachment:save")(trusted, "not base64!"));

  const serve = protocolHandlers.get("attachment");
  assert.equal((await serve({ url: `attachment://file/${path.basename(saved)}` })).status, 200);
  assert.equal((await serve({ url: "attachment://file/%2E%2E%2Fworkspaces.v1.json" })).status, 404);

  const projectless = await handlers.get("workspace:projectless")(trusted);
  assert.equal((await handlers.get("workspace:changed-files")(untrusted, projectless.id)).status, "error");
  assert.equal((await handlers.get("workspace:changed-files")(trusted, "")).status, "error");

  const command = (taskId, runId) => ({ type: "start", channel: "main", taskId, runId, prompt: "work", workspaceId: projectless.id, policy: "confirm", model: "opus", effort: "high" });
  runCommand(untrusted, command("ignored", "ignored"));
  runCommand(trusted, command("cancelled", "run-cancelled"));
  runCommand(trusted, { type: "cancel", taskId: "cancelled", runId: "run-cancelled" });
  await tick();
  assert.equal(agents[0].messages.some((message) => message.runId === "run-cancelled"), false);

  runCommand(trusted, command("concurrent-a", "run-concurrent-a"));
  runCommand(trusted, command("concurrent-b", "run-concurrent-b"));
  await waitFor(() => ["run-concurrent-a", "run-concurrent-b"].every((runId) => agents[0].messages.some((message) => message.runId === runId)));

  runCommand(trusted, command("resubmitted", "run-old"));
  runCommand(trusted, command("resubmitted", "run-new"));
  await waitFor(() => agents[0].messages.some((message) => message.runId === "run-new"));
  assert.equal(agents[0].messages.some((message) => message.runId === "run-old"), false);
  assert.equal(agents[0].messages.some((message) => message.runId === "run-new"), true);

  runCommand(trusted, { ...command("missing", "run-missing"), workspaceId: "unknown" });
  const sent = () => window.webContents.sent.map(({ event }) => event);
  await waitFor(() => sent().some((event) => event.runId === "run-missing" && event.type === "run.status" && event.status === "failed"));
  assert.deepEqual(sent().filter((event) => event.runId === "run-cancelled" && event.type === "run.status").map((event) => event.status), ["cancelled"]);
  assert.deepEqual(sent().filter((event) => event.runId === "run-old" && event.type === "run.status").map((event) => event.status), ["cancelled"]);
  assert.deepEqual(sent().filter((event) => event.runId === "run-missing" && event.type === "run.status").map((event) => event.status), ["failed"]);

  agents[0].emit("exit", 9);
  assert.deepEqual(sent().filter((event) => event.runId === "run-new" && event.type === "run.status").map((event) => event.status), ["failed"]);

  runCommand(trusted, command("post", "run-post"));
  await waitFor(() => agents[1]?.messages.some((message) => message.runId === "run-post"));
  agents[1].throwOnPost = true;
  runCommand(trusted, { type: "cancel", taskId: "post", runId: "run-post" });
  assert.equal(window.webContents.sent.map(({ event }) => event).some((event) => event.runId === "run-post" && event.type === "run.status" && event.status === "failed"), true);
});

test("thread requests are relayed to the window and only its answers reach the agent", async (t) => {
  const { listeners, agents, window, trusted, untrusted } = await startMainProcess(t, "claudex-threads-");
  const request = { type: "thread.request", requestId: "request-1", taskId: "task-caller", op: "list" };

  agents[0].emit("message", { type: "thread.request", requestId: "malformed", taskId: "task-caller", op: "list", limit: -1 });
  agents[0].emit("message", request);
  await tick();
  const relayed = window.webContents.sent.filter(({ channel }) => channel === "thread:request").map(({ event }) => event);
  assert.deepEqual(relayed, [request], "only the valid request reached the window");

  const answer = listeners.get("thread:answer");
  answer(untrusted, { type: "thread.response", requestId: "request-1", ok: true, result: [] });
  answer(trusted, { type: "thread.response", requestId: "unknown", ok: true, result: [] });
  answer(trusted, { type: "thread.response", requestId: "request-1", ok: true, result: [{ id: "task-1" }] });
  answer(trusted, { type: "thread.response", requestId: "request-1", ok: true, result: [{ id: "task-1" }] });

  const answered = agents[0].messages.filter((message) => message.type === "thread.response");
  assert.deepEqual(answered.map((message) => message.result), [[{ id: "task-1" }]], "an answer settles its request once");
});

test("⌘W is taken from the window's menu and handed to whatever is in front", async (t) => {
  const { window, listeners, trusted, untrusted } = await startMainProcess(t, "claudex-close-");

  const beforeInput = window.webContents.listeners.get("before-input-event");
  const press = (input) => {
    let prevented = false;
    beforeInput({ preventDefault: () => { prevented = true; } }, { type: "keyDown", key: "w", meta: true, control: false, alt: false, shift: false, ...input });
    return prevented;
  };

  assert.equal(press({}), true, "the window must not act on ⌘W before the app has");
  assert.equal(window.webContents.sent.filter((message) => message.channel === "window:close-tab").length, 1);

  assert.equal(press({ shift: true }), false, "⇧⌘W stays the window's own");
  assert.equal(press({ key: "t" }), false);
  assert.equal(press({ meta: false }), false);
  assert.equal(press({ type: "keyUp" }), false);
  assert.equal(window.webContents.sent.filter((message) => message.channel === "window:close-tab").length, 1);

  let closed = 0;
  window.close = () => { closed += 1; };
  listeners.get("window:close")(untrusted);
  assert.equal(closed, 0, "only the window's own renderer may close it");
  listeners.get("window:close")(trusted);
  assert.equal(closed, 1);
});
