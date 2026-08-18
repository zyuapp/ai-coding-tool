import assert from "node:assert/strict";
import test from "node:test";
import { ThreadChannel } from "../dist/main/main/agent/thread-channel.mjs";
import { threadTools } from "../dist/main/main/agent/thread-tools.mjs";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

const summary = (overrides = {}) => ({
  id: "task-1",
  title: "Rework the sidebar",
  projectId: "project-app",
  projectRoot: "/code/app",
  status: "idle",
  archived: false,
  createdAt: NOW - 5 * HOUR,
  lastActivityAt: NOW - 4 * HOUR,
  messageCount: 12,
  ...overrides,
});

function fakeBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    list: async (query) => { calls.push(["list", query]); return [summary()]; },
    read: async (threadId, limit) => {
      calls.push(["read", threadId, limit]);
      return { thread: summary({ id: threadId }), messages: [{ kind: "user", text: "how do we do it", at: NOW }], omitted: 4 };
    },
    command: async (command) => { calls.push(["command", command]); return { thread: summary({ id: command.taskId ?? "task-new" }) }; },
    ...overrides,
  };
}

function toolNamed(bridge, name) {
  const definition = threadTools(bridge, () => NOW).find((entry) => entry.name === name);
  assert.ok(definition, `no ${name} tool`);
  return definition;
}

const textOf = (result) => result.content.map((block) => block.text).join("");

test("listing threads turns minutes into a query and reports each thread on one line", async () => {
  const bridge = fakeBridge();

  const listed = await toolNamed(bridge, "list_threads").handler({ project: "all", idleMinutes: 180 }, {});
  assert.deepEqual(bridge.calls.at(-1), ["list", { project: "all", idleForMs: 3 * HOUR, limit: 20 }]);
  assert.match(textOf(listed), /Rework the sidebar \[task-1\] · \/code\/app · idle · 12 messages · idle 4h/);

  await toolNamed(bridge, "list_threads").handler({ archived: true, search: "sidebar", limit: 5 }, {});
  assert.deepEqual(bridge.calls.at(-1), ["list", { archived: true, search: "sidebar", limit: 5 }]);

  const empty = await toolNamed(fakeBridge({ list: async () => [] }), "list_threads").handler({}, {});
  assert.match(textOf(empty), /No thread matches/);
});

test("reading a thread says what it left out rather than dumping the transcript", async () => {
  const bridge = fakeBridge();

  const read = await toolNamed(bridge, "read_thread").handler({ threadId: "task-7", limit: 2 }, {});
  assert.deepEqual(bridge.calls.at(-1), ["read", "task-7", 2]);
  assert.match(textOf(read), /\(4 earlier messages not shown\)/);
  assert.match(textOf(read), /\[user\] how do we do it/);
});

test("starting, messaging, archiving and stopping go through the command surface", async () => {
  const bridge = fakeBridge();

  const started = await toolNamed(bridge, "start_thread").handler({ prompt: "Implement item 1", projectId: "project-app" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "task.send", text: "Implement item 1", projectId: "project-app" }]);
  assert.match(textOf(started), /^Started Rework the sidebar \[task-new\]/);

  await toolNamed(bridge, "message_thread").handler({ threadId: "task-2", text: "also update the README", steer: true }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "task.send", taskId: "task-2", text: "also update the README", steer: true }]);

  await toolNamed(bridge, "archive_thread").handler({ threadId: "task-3" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "task.archive", taskId: "task-3" }]);

  await toolNamed(bridge, "stop_thread").handler({ threadId: "task-4" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "run.cancel", taskId: "task-4" }]);
});

test("a refused request comes back as a tool error the model can correct", async () => {
  const bridge = fakeBridge({ read: async () => { throw new Error("No thread has the ID ghost."); } });

  const failed = await toolNamed(bridge, "read_thread").handler({ threadId: "ghost" }, {});
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /Thread error: No thread has the ID ghost/);
});

test("the channel scopes each bridge to the thread that is running and times a lost answer out", async () => {
  const posted = [];
  const channel = new ThreadChannel((request) => posted.push(request), 10);
  const bridge = channel.bridgeFor("task-caller");

  const listing = bridge.list({ project: "current", limit: 3 });
  assert.equal(posted[0].taskId, "task-caller", "the agent never chooses which thread is asking");
  assert.deepEqual(posted[0].op, "list");
  channel.settle({ type: "thread.response", requestId: posted[0].requestId, ok: true, result: [summary()] });
  assert.deepEqual((await listing).map((thread) => thread.id), ["task-1"]);

  const refused = bridge.command({ type: "task.archive", taskId: "task-1" });
  channel.settle({ type: "thread.response", requestId: posted[1].requestId, ok: false, message: "No thread has the ID task-1." });
  await assert.rejects(refused, /No thread has the ID task-1/);

  await assert.rejects(bridge.read("task-1"), /did not answer the thread "read" request/);
  assert.equal(channel.settle({ type: "thread.response", requestId: "unknown", ok: true, result: null }), false);
});
