import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { readCodexSubagentMetadata } from "../../../src/main/codex/codex-subagent-metadata.mts";
import { FakeCodexClient, tick } from "../../support/codex-client.mjs";

test("inspecting a saved child reads settings without resuming or loading turns", async () => {
  const clients: FakeCodexClient[] = [];
  const read = () => readCodexSubagentMetadata("ui-smoke", (command) => {
    const client = new FakeCodexClient(command, { "thread/read": () => ({ thread: { id: "ui-smoke", model: "gpt-5.6-sol", reasoningEffort: "medium" } }) });
    clients.push(client);
    return client;
  });
  const first = read();
  assert.equal(read(), first, "concurrent inspections share the request");
  assert.deepEqual(await first, { model: "gpt-5.6-sol", effort: "medium" });
  assert.deepEqual(clients[0].calls("thread/read"), [{ threadId: "ui-smoke", includeTurns: false }]);
  assert.equal(clients[0].closed, true);
  assert.equal(clients[0].calls("thread/resume").length, 0);
});

test("missing saved children and timed-out reads close the connection and preserve unknown settings", async () => {
  for (const hangs of [false, true]) {
    let client: FakeCodexClient | undefined;
    const details = await readCodexSubagentMetadata(`missing-${hangs}`, (command) => {
      client = new FakeCodexClient(command, { "thread/read": () => { if (hangs) return new Promise(() => {}); throw new Error("not found"); } });
      return client;
    }, 5);
    assert.deepEqual(details, {});
    assert.equal(client?.closed, true);
  }
});

test("unavailable settings are cached briefly and can be recovered later", async () => {
  let reads = 0;
  const read = () => readCodexSubagentMetadata("cache-child", (command) => new FakeCodexClient(command, {
    "thread/read": () => { reads += 1; return { thread: { id: "cache-child", model: null, reasoningEffort: null } }; },
  }));
  await read();
  await read();
  assert.equal(reads, 1);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
  try { await read(); } finally { clock.mockRestore(); }
  assert.equal(reads, 2);
});

test("inspecting many saved children limits simultaneous app-server reads", async () => {
  const pending: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  const reads = Array.from({ length: 10 }, (_, index) => readCodexSubagentMetadata(`batch-${index}`, (command) => new FakeCodexClient(command, {
    "thread/read": () => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      pending.push(() => { active -= 1; resolve({ thread: { id: `batch-${index}`, model: "gpt-5.6-sol", reasoningEffort: "medium" } }); });
    }),
  })));
  await tick();
  assert.equal(pending.length, 4);
  while (pending.length) {
    pending.shift()!();
    await tick();
  }
  await Promise.all(reads);
  assert.equal(peak, 4);
});
