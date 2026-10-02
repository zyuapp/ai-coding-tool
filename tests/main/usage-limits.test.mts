import assert from "node:assert/strict";
import { test } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider } from "../../src/main/agent/claude-agent-provider.mts";
import { input as claudeInput, queryFactory } from "../support/claude-session.mjs";
import { completeTurn, harness, input as codexInput, opened, sentBy } from "../support/codex-client.mjs";

const at = { threadId: "thread-1", turnId: "turn-1" };

test("a turn the plan's usage limit stops says when the limit lifts, and extra usage is no limit", async () => {
  const rejected = (info: Record<string, unknown>) => ({ type: "rate_limit_event", uuid: "limit-1", session_id: "session-1", rate_limit_info: { status: "rejected", resetsAt: 1_900_000_000, ...info } });
  const failed = { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" };
  const run = (messages: unknown[]) => new ClaudeAgentProvider(queryFactory(messages as SDKMessage[])).execute(claudeInput());
  assert.deepEqual(await run([rejected({ rateLimitType: "five_hour" }), failed]), { status: "failed", message: "You've hit your limit", limit: { resetsAt: 1_900_000_000_000, window: "session" } });
  assert.deepEqual(await run([rejected({ rateLimitType: "seven_day" }), failed]), { status: "failed", message: "You've hit your limit", limit: { resetsAt: 1_900_000_000_000, window: "weekly" } });
  assert.deepEqual(await run([rejected({ rateLimitType: "five_hour", overageStatus: "allowed" }), failed]), { status: "failed", message: "You've hit your limit" });
  assert.deepEqual(await run([{ ...rejected({}), rate_limit_info: { status: "allowed" } }, failed]), { status: "failed", message: "You've hit your limit" });
});

test("a turn stopped by the plan's usage limit says when the limit lifts", async () => {
  const window = (usedPercent: number, windowDurationMins: number, resetsAt: number) => ({ usedPercent, windowDurationMins, resetsAt });
  const snapshot = (primary: ReturnType<typeof window>, secondary: ReturnType<typeof window>) => ({ limitId: "codex", limitName: null, normalModelSlug: null, primary, secondary, credits: null, individualLimit: null, spendControlReached: null, planType: null, rateLimitReachedType: null });
  const codex = harness({
    "account/rateLimits/read": () => ({
      ordinaryUsageAllowed: false,
      rateLimits: snapshot(window(100, 300, 1_900_000_000), window(40, 10_080, 1_900_500_000)),
      /** Another bucket used up for the week never holds an ordinary turn. */
      rateLimitsByLimitId: { review: { ...snapshot(window(10, 300, 1_900_000_000), window(100, 10_080, 1_900_900_000)), limitId: "review" } },
      rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
    }),
  });
  const running = codex.provider.execute(codexInput());
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  client.notify("error", { ...at, error: { message: "usage limit reached", codexErrorInfo: "usageLimitExceeded", additionalDetails: null, misalignment: null }, willRetry: false });
  completeTurn(client, "failed");
  assert.deepEqual(await running, { status: "failed", message: "usage limit reached", limit: { resetsAt: 1_900_000_000_000, window: "session" } });
  codex.provider.closeAll();
});
