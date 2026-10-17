import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { harness, turn } from "../../support/codex-client.mjs";

const turnId = "turn-1";

test("a resumed Codex thread counts only what this turn spent", async () => {
  const spent: ProviderEvent[] = [];
  const codex = harness();
  const continuation = { provider: "codex" as const, value: "thread-9" };
  const totals = (total: number, last: number) => {
    const breakdown = (totalTokens: number) => ({ totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
    return { threadId: "thread-9", turnId, tokenUsage: { total: breakdown(total), last: breakdown(last), modelContextWindow: 272_000 } };
  };
  const { client } = await turn(codex, { continuation, emit: (event) => { if (event.type === "spend") spent.push(event); } }, (client) => {
    client.notify("thread/tokenUsage/updated", totals(480_000, 1_200));
    client.notify("thread/tokenUsage/updated", totals(481_000, 1_000));
  });
  client.notify("thread/tokenUsage/updated", totals(483_000, 2_000));
  await turn(codex, { continuation, emit: (event) => { if (event.type === "spend") spent.push(event); } }, (client) => {
    client.notify("thread/tokenUsage/updated", totals(483_500, 500));
  });

  assert.deepEqual(spent, [{ type: "spend", tokens: 1_200 }, { type: "spend", tokens: 1_000 }, { type: "spend", tokens: 500 }], "neither the history it resumed nor what it spent between runs counts");
  codex.provider.closeAll();
});
