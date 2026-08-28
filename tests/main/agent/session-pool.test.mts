import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderResult, ProviderRunInput } from "../../../src/main/agent/agent-provider.mts";
import { SessionPool, type PooledSession, type SessionHooks } from "../../../src/main/agent/session-pool.mts";
import { input } from "../../support/codex-client.mjs";

class FakeSession implements PooledSession {
  live = true;
  busy = false;
  answering = false;
  continuation?: string;
  constructor(readonly key: string, readonly engine: string, private readonly hooks: SessionHooks) {}
  continues(continuation: string | undefined) {
    return continuation === undefined || continuation === this.continuation;
  }
  async run(run: ProviderRunInput): Promise<ProviderResult> {
    return { status: "succeeded", message: `${this.engine}:${run.taskId}` };
  }
  close() {
    this.live = false;
    this.hooks.ended();
  }
}

/** Each engine opens its own sessions on the one pool, the way a channel's providers do. */
function engine(name: string, pool: SessionPool, opened: FakeSession[]) {
  return (run: ProviderRunInput) => pool.execute(run, `${name}-key`, { open: (hooks) => { const session = new FakeSession(`${name}-key`, name, hooks); opened.push(session); return session; } });
}

test("engines sharing a pool share its cap, and the coldest idle session goes whichever engine holds it", async () => {
  const pool = new SessionPool();
  const opened: FakeSession[] = [];
  const claude = engine("claude", pool, opened);
  const codex = engine("codex", pool, opened);

  assert.deepEqual(await claude(input({ engine: "claude", taskId: "a" })), { status: "succeeded", message: "claude:a" });
  await codex(input({ taskId: "b" }));
  await claude(input({ engine: "claude", taskId: "c" }));
  await codex(input({ taskId: "d" }));
  assert.equal(opened.length, 4);
  assert.ok(opened.every((session) => session.live));

  await codex(input({ taskId: "e" }));
  assert.equal(opened.length, 5);
  assert.deepEqual(opened.map((session) => session.live), [false, true, true, true, true], "the Claude session of thread a was the coldest");

  await claude(input({ engine: "claude", taskId: "c" }));
  assert.equal(opened.length, 5, "thread c's session is warm and reused");
  assert.equal(pool.liveSession("c"), opened[2]);
  assert.equal(pool.liveSession("a"), undefined);

  pool.closeAll();
  assert.ok(opened.every((session) => !session.live));
});

test("the pool runs a session's start once it holds the session, so a session that ends at once is already forgotten", async () => {
  const pool = new SessionPool();
  const seen: Array<boolean | undefined> = [];
  const result = await pool.execute(input({ taskId: "t" }), "key", {
    open: (hooks) => new FakeSession("key", "codex", hooks),
    start: (session) => {
      seen.push(pool.liveSession("t") === session);
      session.close();
      seen.push(pool.liveSession("t")?.live);
    },
  });
  assert.deepEqual(seen, [true, undefined]);
  assert.equal(result.status, "succeeded");
});
