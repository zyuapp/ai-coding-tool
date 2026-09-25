import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { input, queryFactory } from "../../support/claude-session.mjs";

test("API retries the SDK reports show as retries with the reason in the user's terms", async () => {
  const emitted: ProviderEvent[] = [];
  const provider = new ClaudeAgentProvider(queryFactory([
    { type: "system", subtype: "init", session_id: "session-1" },
    { type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4_000, error_status: 529, error: "overloaded" },
    { type: "system", subtype: "api_retry", attempt: 3, max_retries: 10, retry_delay_ms: 8_000, error_status: 429, error: "rate_limit" },
    { type: "system", subtype: "api_retry", attempt: 4, max_retries: 10, retry_delay_ms: 8_000, error_status: null, error: "unknown" },
    { type: "system", subtype: "api_retry", attempt: 5, max_retries: 10, retry_delay_ms: 8_000, error_status: 500, error: "server_error" },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ]));

  assert.deepEqual(await provider.execute(input({ emit: (event) => emitted.push(event) })), { status: "succeeded" });
  assert.deepEqual(emitted.filter((event) => event.type === "retry"), [
    { type: "retry", message: "Claude is overloaded.", attempt: 2, maxRetries: 10 },
    { type: "retry", message: "Claude is rate limited.", attempt: 3, maxRetries: 10 },
    { type: "retry", message: "Cannot reach Claude.", attempt: 4, maxRetries: 10 },
    { type: "retry", message: "Claude API error 500.", attempt: 5, maxRetries: 10 },
  ]);
});
