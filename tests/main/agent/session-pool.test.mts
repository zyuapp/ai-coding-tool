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
  rest() { this.hooks.rested(); }
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

for (const name of ["claude", "codex"] as const) {
  test(`${name} reload releases idle sessions and resumes the same conversation on a fresh session`, async () => {
    const pool = new SessionPool();
    const opened: FakeSession[] = [];
    const run = engine(name, pool, opened);
    await run(input({ taskId: "reload" }));
    opened[0].continuation = "existing-conversation";
    await pool.reloadSettings();
    assert.equal(opened[0].live, false);
    let resumed: string | undefined;
    await pool.execute(input({ engine: name, taskId: "reload", continuation: { provider: name, value: "existing-conversation" } }), `${name}-key`, {
      open: (hooks) => {
        const session = new FakeSession(`${name}-key`, name, hooks);
        session.run = async (next) => { resumed = next.continuation?.value; return { status: "succeeded" }; };
        return session;
      },
    });
    assert.equal(resumed, "existing-conversation");
    pool.closeAll();
  });
}

test("reload waits for an active run and its background work, while new sessions remain warm", async () => {
  const pool = new SessionPool();
  const opened: FakeSession[] = [];
  let finish!: (result: ProviderResult) => void;
  const running = pool.execute(input({ taskId: "busy" }), "codex-key", {
    open: (hooks) => {
      const session = new FakeSession("codex-key", "codex", hooks);
      session.busy = true;
      session.answering = true;
      session.run = () => new Promise((resolve) => { finish = resolve; });
      opened.push(session);
      return session;
    },
  });
  let reloaded = false;
  const reload = pool.reloadSettings().then(() => { reloaded = true; });
  await Promise.resolve();
  assert.equal(reloaded, false);
  assert.equal(opened[0].live, true);
  opened[0].answering = false;
  finish({ status: "succeeded" });
  assert.equal((await running).status, "succeeded");
  assert.equal(reloaded, false, "background work still owns the session");
  await engine("claude", pool, opened)(input({ taskId: "new" }));
  opened[0].busy = false;
  opened[0].rest();
  await reload;
  assert.equal(opened[0].live, false);
  assert.equal(opened[1].live, true, "a session launched after reload already has fresh settings");
  pool.closeAll();
});

test("repeated reloads wait for the same busy session and settle if it exits", async () => {
  const pool = new SessionPool();
  const opened: FakeSession[] = [];
  await engine("codex", pool, opened)(input({ taskId: "busy" }));
  opened[0].busy = true;
  const first = pool.reloadSettings();
  const second = pool.reloadSettings();
  opened[0].close();
  await Promise.all([first, second]);
  assert.equal(pool.liveSession("busy"), undefined);
  await pool.reloadSettings();
});
