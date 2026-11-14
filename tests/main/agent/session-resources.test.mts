import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { test } from "vitest";
import { SessionPool, type PooledSession } from "../../../src/main/agent/session-pool.mts";
import { registerSessionProcess, reportSessionResources } from "../../../src/main/agent/session-resources.mts";
import type { SessionResourceMessage } from "../../../src/contracts/session-resources.ts";
import { input } from "../../support/codex-client.mjs";

test("a warm session retains process ownership across turns; stale termination cannot close its replacement", async () => {
  const events: SessionResourceMessage[] = [];
  const pool = new SessionPool();
  const opened: PooledSession[] = [];
  reportSessionResources(event => { events.push(event); });
  const execute = (fresh = false) => pool.execute(input({ taskId: "a", ...(fresh ? { freshSession: true } : {}) }), "engine", {
    open: hooks => {
      const session: PooledSession = { key: "engine", live: true, busy: true, answering: false, continues: () => true, run: async () => ({ status: "succeeded" }), close: () => { hooks.ended(); } };
      opened.push(session);
      return session;
    },
    start: () => {
      const child = Object.assign(new EventEmitter(), { pid: 100 + opened.length }) as ChildProcess;
      registerSessionProcess(child);
    },
  });
  try {
    await execute();
    await execute();
    const first = events.find(event => event.type === "session.process")!;
    assert.equal(opened.length, 1);
    assert.equal(pool.terminate("other", first.sessionId), false);
    assert.equal(pool.terminate("a", first.sessionId, true), false, "a session whose native background work became busy is not reclaimed as idle");
    await execute(true);
    assert.equal(opened.length, 2);
    const registrations = events.filter(event => event.type === "session.process");
    assert.equal(registrations.length, 2);
    assert.notEqual(registrations[0]!.sessionId, registrations[1]!.sessionId);
    assert.equal(pool.terminate("a", first.sessionId), false);
    assert.equal(pool.liveSession("a"), opened[1]);
    assert.equal(pool.terminate("a", registrations[1]!.sessionId), true);
    assert.equal(pool.liveSession("a"), undefined);
    assert.ok(events.some(event => event.type === "session.released" && event.sessionId === first.sessionId));
    assert.ok(events.some(event => event.type === "session.state" && event.busy));
  } finally { pool.closeAll(); reportSessionResources(() => {}); }
});
