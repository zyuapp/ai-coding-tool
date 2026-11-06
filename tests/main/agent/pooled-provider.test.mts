import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderResult, ProviderRunInput } from "../../../src/main/agent/agent-provider.mts";
import { PooledProvider } from "../../../src/main/agent/pooled-provider.mts";
import { SessionPool, type PooledSession, type SessionHooks } from "../../../src/main/agent/session-pool.mts";
import { input } from "../../support/codex-client.mjs";

class FakeSession implements PooledSession {
  live = true;
  busy = false;
  answering = false;
  constructor(readonly key: string, private readonly hooks: SessionHooks, private readonly log: string[]) {}
  continues() {
    return true;
  }
  async run(run: ProviderRunInput): Promise<ProviderResult> {
    this.log.push(`run ${run.taskId}`);
    return { status: "succeeded" };
  }
  close() {
    this.live = false;
    this.hooks.ended();
  }
}

class OwnSession extends FakeSession {}
class OtherSession extends FakeSession {}

/** A stand-in engine: it opens sessions of one kind, and a filing waits until the test lets it land. */
class Provider<S extends FakeSession = OwnSession> extends PooledProvider<S> {
  readonly log: string[] = [];
  constructor(pool: SessionPool, private readonly made: new (key: string, hooks: SessionHooks, log: string[]) => S = OwnSession as never) {
    super(pool, made);
  }
  execute(run: ProviderRunInput) {
    return this.run(run, "key", { open: (hooks) => new this.made("key", hooks, this.log) });
  }
  own(taskId: string) {
    return this.session(taskId);
  }
  archive(taskId: string, landed: Promise<void>, name: string) {
    this.file(taskId, async () => {
      this.log.push(`filing ${name}`);
      await landed;
      this.log.push(`filed ${name}`);
    });
  }
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

test("a run waits for the thread's filings, which land in the order asked", async () => {
  const provider = new Provider(new SessionPool());
  const first = gate();
  provider.archive("t", first.opened, "archive");
  provider.archive("t", Promise.resolve(), "restore");
  const running = provider.execute(input({ taskId: "t" }));
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(provider.log, ["filing archive"]);

  first.open();
  await running;
  assert.deepEqual(provider.log, ["filing archive", "filed archive", "filing restore", "filed restore", "run t"]);
});

test("a filing that fails holds up neither the next filing nor the run", async () => {
  const provider = new Provider(new SessionPool());
  provider.archive("t", Promise.reject(new Error("offline")), "archive");
  provider.archive("t", Promise.resolve(), "restore");
  await provider.execute(input({ taskId: "t" }));
  assert.deepEqual(provider.log, ["filing archive", "filing restore", "filed restore", "run t"]);
});

test("a thread with no filing runs at once", () => {
  const provider = new Provider(new SessionPool());
  void provider.execute(input({ taskId: "t" }));
  assert.deepEqual(provider.log, ["run t"]);
});

test("a provider reads back only a live session of its own engine", async () => {
  const pool = new SessionPool();
  const own = new Provider(pool);
  const other = new Provider(pool, OtherSession);
  await own.execute(input({ taskId: "mine" }));
  await other.execute(input({ taskId: "theirs" }));
  assert.ok(own.own("mine") instanceof OwnSession);
  assert.equal(own.own("theirs"), undefined, "the other engine's session is not this one's");
  assert.ok(other.own("theirs") instanceof OtherSession);

  own.closeAll();
  assert.equal(own.own("mine"), undefined);
  assert.equal(other.own("theirs"), undefined, "the engines share one pool, so closing it closes both");
});
