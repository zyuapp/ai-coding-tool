import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { input, liveQueryFactory, turn, type LiveQueryCapture } from "../../support/claude-session.mjs";
import { harness, turn as codexTurn } from "../../support/codex-client.mjs";

test("a fresh Claude run opens a session that resumes nothing, even with one warm for the thread", async () => {
  const capture: LiveQueryCapture = { opens: 0, sent: [] };
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  await turn(capture, provider.execute(input()), { type: "system", subtype: "init", session_id: "session-1" });

  const fresh = await turn(capture, provider.execute(input({ freshSession: true, prompt: "start over" })), { type: "system", subtype: "init", session_id: "session-2" });
  assert.deepEqual(fresh, { status: "succeeded" });
  assert.equal(capture.opens, 2, "the warm session is not the one this run asked for");
  assert.equal(capture.options?.options?.resume, undefined);
  assert.equal(capture.options?.options?.forkSession, undefined);
  assert.equal(capture.sent.at(-1), "start over");
  provider.closeAll();
});

test("a fresh Codex run starts a new thread rather than resuming the warm one", async () => {
  const codex = harness();
  const { client } = await codexTurn(codex);
  const fresh = await codexTurn(codex, { freshSession: true, prompt: "start over" });
  assert.notEqual(fresh.client, client, "the warm session is let go rather than continued");
  assert.equal(client.closed, true);
  assert.equal(fresh.client.calls("thread/start").length, 1);
  assert.equal(fresh.client.calls("thread/resume").length, 0);
  assert.equal(fresh.client.calls("thread/fork").length, 0);
  assert.equal(client.calls("thread/archive").length, 0, "the old thread is left as it was, not archived");
  codex.provider.closeAll();
});
