import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { SIDE_CHAT_BOUNDARY } from "../../../src/main/agent/side-chat-instructions.mts";
import { input, liveQueryFactory, turn, type LiveQueryCapture } from "../../support/claude-session.mjs";

test("Claude separates inherited history in the first question without an extra turn or resetting follow-ups", async () => {
  for (const fork of [false, true]) {
    const capture: LiveQueryCapture = { opens: 0, sent: [] };
    const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
    const prompt = "Why are those tests needed?";
    const continuation = { provider: "claude", value: "side-session" } as const;
    try {
      await turn(capture, provider.execute(input({
        channel: "side", prompt,
        ...(fork ? { continuation: { provider: "claude" as const, value: "parent-running" }, forkContinuation: true } : {}),
      })), { type: "system", subtype: "init", session_id: continuation.value });
      assert.deepEqual(capture.sent, [`${SIDE_CHAT_BOUNDARY}\n\nSide-chat request:\n${prompt}`], "one input means one turn, with the question after the history boundary");
      await turn(capture, provider.execute(input({ channel: "side", continuation, prompt: "okay" })));
      assert.equal(capture.opens, 1);
      assert.deepEqual(capture.sent.slice(1), ["okay"], "follow-ups remain after the original boundary");
      provider.closeAll();
      await turn(capture, provider.execute(input({ channel: "side", continuation, prompt: "Explain that last point" })));
      assert.equal(capture.opens, 2);
      assert.equal(capture.sent.at(-1), "Explain that last point", "reopening preserves the side chat's own assignments");
    } finally {
      provider.closeAll();
    }
  }
});
