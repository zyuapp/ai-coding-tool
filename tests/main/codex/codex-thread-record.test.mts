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
