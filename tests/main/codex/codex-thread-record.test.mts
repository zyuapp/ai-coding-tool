import assert from "node:assert/strict";
import { test } from "vitest";
import { AppServerError } from "../../../src/main/codex/app-server-client.mts";
import { completeTurn, harness, input, opened, sentBy, tick, turn } from "../../support/codex-client.mjs";

const threadId = "thread-1";
const turnId = "turn-1";

test("a resumed session receives the title saved while its previous session was closed", async () => {
  const codex = harness();
  const first = await turn(codex, { title: "Original title" });
  codex.provider.closeAll();

  assert.equal(codex.provider.labelThread("task-1", "Renamed while closed"), false);
  const resumed = await turn(codex, { title: "Renamed while closed", continuation: { provider: "codex", value: threadId } });

  assert.notEqual(resumed.client, first.client);
  assert.equal(resumed.client.calls("thread/resume").length, 1);
  assert.deepEqual(resumed.client.calls("thread/name/set"), [{ threadId, name: "Renamed while closed" }]);
  codex.provider.closeAll();
});

test("a fork receives its own saved title", async () => {
  const codex = harness();
  const { client } = await turn(codex, { title: "Review copy", continuation: { provider: "codex", value: threadId }, forkContinuation: true });

  assert.deepEqual(client.calls("thread/name/set"), [{ threadId: "thread-fork", name: "Review copy" }]);
  codex.provider.closeAll();
});

test("a failed title write is retried on the next run without failing either run", async () => {
  let attempts = 0;
  const codex = harness({
    "thread/name/set": () => {
      attempts += 1;
      if (attempts === 1) throw new AppServerError("thread/name/set", -32603, "write failed");
      return {};
    },
  });
  const first = await turn(codex, { title: "Saved title" });
  const second = await turn(codex, { title: "Saved title", continuation: { provider: "codex", value: threadId } });

  assert.deepEqual(first.result, { status: "succeeded" });
  assert.deepEqual(second.result, { status: "succeeded" });
  assert.equal(first.client, second.client);
  assert.equal(attempts, 2);
  codex.provider.closeAll();
});

test("Codex is told the thread's title and where its work belongs, once the turn has a rollout to write against", async () => {
  const codex = harness({}, { readOrigin: async () => ({ originUrl: "git@github.com:me/app.git", branch: "feature", sha: "abc123" }) });
  const { client } = await turn(codex);

  await sentBy(client, "thread/metadata/update");
  assert.deepEqual(client.calls("thread/metadata/update"), [{ threadId, gitInfo: { originUrl: "git@github.com:me/app.git", branch: "feature", sha: "abc123" } }]);
  assert.deepEqual(client.calls("thread/name/set"), [{ threadId, name: "Inspect the app" }]);

  assert.equal(codex.provider.labelThread("task-1", "Inspect the app"), true);
  await sentBy(client, "thread/name/set");
  assert.deepEqual(client.calls("thread/name/set"), [{ threadId, name: "Inspect the app" }]);

  codex.provider.labelThread("task-1", "Inspect the app");
  assert.deepEqual(client.calls("thread/name/set"), [{ threadId, name: "Inspect the app" }], "the same title is not sent twice");
  codex.provider.labelThread("task-1", "Review the app");
  const again = await turn(codex, { title: "Review the app", continuation: { provider: "codex", value: threadId } });
  assert.equal(again.client, client);
  assert.deepEqual(client.calls("thread/name/set"), [{ threadId, name: "Inspect the app" }, { threadId, name: "Review the app" }]);
  codex.provider.closeAll();
});

test("a title that lands before the first turn waits for the rollout instead of failing against it", async () => {
  let letTurnStart = () => {};
  const held = new Promise<void>((resolve) => { letTurnStart = resolve; });
  const codex = harness({
    "turn/start": async () => {
      await held;
      return { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } };
    },
  });
  const running = codex.provider.execute(input());
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  codex.provider.labelThread("task-1", "Early title");
  await tick();
  assert.deepEqual(client.calls("thread/name/set"), [], "Codex has no rollout to name until the turn has begun");

  letTurnStart();
  await sentBy(client, "thread/name/set");
  assert.deepEqual(client.calls("thread/name/set"), [{ threadId, name: "Early title" }]);
  completeTurn(client);
  await running;
  codex.provider.closeAll();
});

test("archiving lets the thread's session go before a server of its own files the thread away, and restoring brings it back", async () => {
  const codex = harness({ "thread/archive": () => ({}) });
  const { client: session } = await turn(codex);
  const continuation = { provider: "codex", value: threadId };

  assert.equal(codex.provider.archiveThread("task-1", continuation, true), true);
  for (let waited = 0; codex.clients.length < 2; waited += 1) {
    if (waited > 100) throw new Error("no archiving server was opened");
    await tick();
  }
  const archiver = codex.latest();
  await sentBy(archiver, "thread/archive");
  assert.equal(session.closed, true, "the session holding the thread is gone first");
  assert.deepEqual(archiver.calls("thread/archive"), [{ threadId }]);
  await archiver.exited;

  codex.provider.archiveThread("task-1", continuation, false);
  for (let waited = 0; codex.clients.length < 3; waited += 1) {
    if (waited > 100) throw new Error("no restoring server was opened");
    await tick();
  }
  await sentBy(codex.latest(), "thread/unarchive");
  assert.deepEqual(codex.latest().calls("thread/unarchive"), [{ threadId }]);
  assert.equal(codex.provider.archiveThread("task-1", { provider: "claude", value: "session" }, true), false);
  codex.provider.closeAll();
});

test("a run on a thread still being archived waits for the filing before its session opens", async () => {
  let letArchive = () => {};
  const held = new Promise<void>((resolve) => { letArchive = resolve; });
  const codex = harness({ "thread/archive": async () => { await held; return {}; } });
  const continuation = { provider: "codex", value: threadId };

  codex.provider.archiveThread("task-1", continuation, true);
  await opened(codex);
  const archiver = codex.latest();
  await sentBy(archiver, "thread/archive");
  const running = codex.provider.execute(input({ continuation }));
  await tick();
  assert.equal(codex.clients.length, 1, "no session opens while the thread is being filed away");

  letArchive();
  for (let waited = 0; codex.clients.length < 2; waited += 1) {
    if (waited > 100) throw new Error("the run never opened its session");
    await tick();
  }
  const session = codex.latest();
  await sentBy(session, "turn/start");
  completeTurn(session);
  assert.deepEqual(await running, { status: "succeeded" });
  codex.provider.closeAll();
});

test("archiving waits for the thread's session process to exit, which is when Codex lets go of the thread", async () => {
  const codex = harness({ "thread/archive": () => ({}) });
  const { client: session } = await turn(codex);
  let exit = () => {};
  const exiting = new Promise<void>((resolve) => { exit = resolve; });
  const close = session.close.bind(session);
  session.close = async () => { await exiting; return close(); };

  codex.provider.archiveThread("task-1", { provider: "codex", value: threadId }, true);
  for (let waited = 0; waited < 20; waited += 1) await tick();
  assert.equal(codex.clients.length, 1, "no archiving server while the session's process is still up");

  exit();
  for (let waited = 0; codex.clients.length < 2; waited += 1) {
    if (waited > 100) throw new Error("no archiving server was opened");
    await tick();
  }
  await sentBy(codex.latest(), "thread/archive");
  codex.provider.closeAll();
});

test("a thread archived before Codex named it to the app is filed under the name its session holds", async () => {
  const codex = harness({ "thread/archive": () => ({}) });
  assert.equal(codex.provider.archiveThread("task-1", undefined, true), false, "no session, nothing to file");
  const { client: session } = await turn(codex);

  assert.equal(codex.provider.archiveThread("task-1", undefined, true), true);
  for (let waited = 0; codex.clients.length < 2; waited += 1) {
    if (waited > 100) throw new Error("no archiving server was opened");
    await tick();
  }
  await sentBy(codex.latest(), "thread/archive");
  assert.equal(session.closed, true);
  assert.deepEqual(codex.latest().calls("thread/archive"), [{ threadId }]);
  assert.equal(codex.provider.archiveThread("task-1", undefined, false), false, "nothing named to bring back");
  codex.provider.closeAll();
});
