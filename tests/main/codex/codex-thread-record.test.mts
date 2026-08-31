import assert from "node:assert/strict";
import { test } from "vitest";
import { AppServerError } from "../../../src/main/codex/app-server-client.mts";
import { harness, turn } from "../../support/codex-client.mjs";

const threadId = "thread-1";

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
