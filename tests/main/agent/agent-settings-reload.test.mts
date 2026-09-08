import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionPool } from "../../../src/main/agent/session-pool.mts";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { harness, turn } from "../../support/codex-client.mts";
import { poolQueryFactory, poolTurn, tick, type PoolCapture } from "../../support/claude-session.mts";

test("Codex reload closes the old app server and resumes its conversation in a fresh one", async () => {
  const pool = new SessionPool();
  const codex = harness({}, { pool });
  try {
    const first = await turn(codex);
    await pool.reloadSettings();
    assert.equal(first.client.closed, true);
    const next = await turn(codex, { continuation: { provider: "codex", value: "thread-1" } });
    assert.notEqual(next.client, first.client);
    assert.equal(next.result.status, "succeeded");
    assert.equal(next.client.calls("thread/resume").length, 1);
    assert.equal(next.client.calls("thread/start").length, 0);
  } finally { pool.closeAll(); }
});

test("Claude reload waits for background work and resumes the conversation with fresh options", async () => {
  const pool = new SessionPool();
  const capture: PoolCapture = { sessions: [] };
  const provider = new ClaudeAgentProvider(poolQueryFactory(capture), pool);
  try {
    const { session } = await poolTurn(provider, capture, {},
      { type: "system", subtype: "init", session_id: "existing-claude" },
      { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "shell-1", task_type: "local_bash", description: "Build" }] });
    let finished = false;
    const reload = pool.reloadSettings().then(() => { finished = true; });
    await tick();
    assert.equal(session.closed, false);
    assert.equal(finished, false);
    session.emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    await reload;
    assert.equal(session.closed, true);
    const next = await poolTurn(provider, capture, { continuation: { provider: "claude", value: "existing-claude" } });
    assert.notEqual(next.session, session);
    assert.equal(next.session.options.options?.resume, "existing-claude");
    assert.equal(next.result.status, "succeeded");
  } finally { pool.closeAll(); }
});
