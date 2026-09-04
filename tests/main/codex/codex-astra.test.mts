import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { DEVELOPER_INSTRUCTIONS } from "../../../src/main/codex/codex-session.mts";
import { harness, turn } from "../../support/codex-client.mjs";

const threadId = "thread-1";
const at = { threadId, turnId: "turn-1" };

test("Astra reaches the app server with its effort and uses the reported context window", async () => {
  const codex = harness();
  const emitted: ProviderEvent[] = [];
  const breakdown = { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 };
  const { client, result } = await turn(codex, { model: "gpt-6-astra", effort: "ultra", emit: (event) => emitted.push(event) }, (client) => {
    for (const modelContextWindow of [null, 872_000]) {
      client.notify("thread/tokenUsage/updated", { ...at, tokenUsage: { total: breakdown, last: breakdown, modelContextWindow } });
    }
  });

  assert.deepEqual(result, { status: "succeeded" });
  assert.deepEqual(client.calls("thread/start"), [{ cwd: "/tmp/project", model: "gpt-6-astra", approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user", config: { model_reasoning_effort: "ultra" }, developerInstructions: DEVELOPER_INSTRUCTIONS }]);
  assert.deepEqual(client.calls("turn/start"), [{
    threadId,
    input: [{ type: "text", text: "inspect the app", text_elements: [] }],
    model: "gpt-6-astra",
    effort: "ultra",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  }]);
  assert.deepEqual(emitted.filter((event) => event.type === "usage"), [
    { type: "usage", tokens: 1000, limit: 272_000, model: "gpt-6-astra" },
    { type: "usage", tokens: 1000, limit: 872_000, model: "gpt-6-astra" },
  ]);
  codex.provider.closeAll();
});
