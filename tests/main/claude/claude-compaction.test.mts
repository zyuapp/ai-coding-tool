import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/claude/claude-agent-provider.mts";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { input, liveQueryFactory, turn, type LiveQueryCapture } from "../../support/claude-session.mjs";

test("compacting a Claude thread sends Claude Code's own command instead of the run's prompt", async () => {
  const capture: LiveQueryCapture = { opens: 0, sent: [] };
  const provider = new ClaudeAgentProvider({ queryFactory: liveQueryFactory(capture) });
  const continuation = { provider: "claude", value: "session-1" } as const;
  const emitted: ProviderEvent[] = [];
  const compacted = await turn(capture, provider.execute(input({ continuation, prompt: "", operation: { type: "compact", preTokens: 400_000 }, emit: (event) => emitted.push(event) })),
    { type: "system", subtype: "init", session_id: "session-1" },
    { type: "system", subtype: "status", status: "compacting" },
    { type: "system", subtype: "status", status: null, compact_result: "success" },
    { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 400_000, post_tokens: 30_000 } },
    { type: "user", isReplay: true, message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" }, parent_tool_use_id: null });
  assert.deepEqual(compacted, { status: "succeeded" });
  assert.deepEqual(capture.sent, ["/compact"]);
  assert.deepEqual(emitted.filter((event) => event.type !== "continuation"), [
    { type: "compaction-status", compacting: true },
    { type: "compaction-status", compacting: false },
    { type: "compaction", trigger: "manual", preTokens: 400_000, postTokens: 30_000 },
  ]);
  provider.closeAll();
});
