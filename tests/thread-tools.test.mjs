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
  attachmentCount: 0,
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
    wait: async (threadId, timeoutMs) => { calls.push(["wait", threadId, timeoutMs]); return { thread: summary({ id: threadId }), timedOut: false, reply: "on branch main" }; },
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

test("threads with images are asked for by name and say how many messages carry one", async () => {
  const queries = [];
  const bridge = fakeBridge({ list: async (query) => { queries.push(query); return [summary({ attachmentCount: 3 })]; } });

  const listed = await toolNamed(bridge, "list_threads").handler({ hasImages: true }, {});
  assert.deepEqual(queries.at(-1), { attachments: true, limit: 20 });
  assert.match(textOf(listed), /12 messages · 3 with images · idle 4h/);

  const plain = await toolNamed(fakeBridge(), "list_threads").handler({}, {});
  assert.doesNotMatch(textOf(plain), /with images/, "a thread without images says nothing about them");
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

  const started = await toolNamed(bridge, "start_thread").handler({ prompt: "Implement item 1", project: "app" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "task.send", text: "Implement item 1", project: "app" }]);
  assert.match(textOf(started), /^Started Rework the sidebar \[task-new\]/);

  await toolNamed(bridge, "start_thread").handler({ prompt: "Take the other half", worktree: true, worktreeId: "wt1" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "task.send", text: "Take the other half", worktreeId: "wt1" }], "a checkout that already exists is entered rather than a second one being made");

  await toolNamed(bridge, "message_thread").handler({ threadId: "task-2", text: "also update the README", steer: true }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "task.send", taskId: "task-2", text: "also update the README", steer: true }]);

  await toolNamed(bridge, "archive_thread").handler({ threadId: "task-3" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "task.archive", taskId: "task-3" }]);

  await toolNamed(bridge, "stop_thread").handler({ threadId: "task-4" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["command", { type: "run.cancel", taskId: "task-4" }]);
});

test("waiting reports what the thread said, or that it is still going", async () => {
  const bridge = fakeBridge();

  const finished = await toolNamed(bridge, "wait_for_thread").handler({ threadId: "task-5" }, {});
  assert.deepEqual(bridge.calls.at(-1), ["wait", "task-5", 5 * 60_000], "the default wait is five minutes");
  assert.match(textOf(finished), /^Finished: Rework the sidebar \[task-5\]/);
  assert.match(textOf(finished), /on branch main/);

  await toolNamed(bridge, "wait_for_thread").handler({ threadId: "task-5", timeoutSeconds: 4_000 }, {});
  assert.deepEqual(bridge.calls.at(-1), ["wait", "task-5", 15 * 60_000], "a wait longer than the cap is clamped");

  const patient = fakeBridge({ wait: async () => ({ thread: summary(), timedOut: true, reply: null }) });
  const running = await toolNamed(patient, "wait_for_thread").handler({ threadId: "task-1", timeoutSeconds: 30 }, {});
  assert.match(textOf(running), /^Still working after 30s: /);
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

  const waiting = bridge.wait("task-1", 50);
  assert.equal(posted[1].op, "wait");
  channel.settle({ type: "thread.response", requestId: posted[1].requestId, ok: true, result: { thread: summary(), timedOut: false, reply: "done" } });
  assert.equal((await waiting).reply, "done");

  const refused = bridge.command({ type: "task.archive", taskId: "task-1" });
  channel.settle({ type: "thread.response", requestId: posted[2].requestId, ok: false, message: "No thread has the ID task-1." });
  await assert.rejects(refused, /No thread has the ID task-1/);

  await assert.rejects(bridge.read("task-1"), /did not answer the thread "read" request/);
  assert.equal(channel.settle({ type: "thread.response", requestId: "unknown", ok: true, result: null }), false);
});
