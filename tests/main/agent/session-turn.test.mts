import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent, ProviderResult, SteerMessage } from "../../../src/main/agent/agent-provider.mts";
import { OpenFailure } from "../../../src/main/agent/session-common.mts";
import { drainSteering, reportCompacting, TurnSlot, type Compacting, type SessionTurn, type TurnEngine } from "../../../src/main/agent/session-turn.mts";
import { input } from "../../support/claude-session.mjs";

type TestTurn = SessionTurn & { begun: boolean };

/** A stand-in engine: it records what the slot asked of it and answers when the test says so. */
function engine(log: string[] = []): TurnEngine<TestTurn> & { log: string[] } {
  return {
    log,
    open: (base) => ({ ...base, begun: false }),
    begin: (turn) => { turn.begun = true; log.push("begin"); },
    interrupt: () => { log.push("interrupt"); },
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 1));

test("the slot holds one turn, answers it once, and is empty again after", async () => {
  const slot = new TurnSlot<TestTurn>(10_000, () => {});
  const parts = engine();
  const running = slot.take(input(), parts);
  assert.equal(slot.answering, true);
  assert.equal(slot.turn?.begun, true);

  slot.settle({ status: "succeeded" });
  assert.equal(slot.answering, false);
  assert.equal(slot.turn, null);
  slot.settle({ status: "failed", message: "too late" });
  assert.deepEqual(await running, { status: "succeeded" });
});

test("a run that was already over is cancelled without the engine starting anything", async () => {
  const slot = new TurnSlot<TestTurn>(10_000, () => {});
  const parts = engine();
  const abortController = new AbortController();
  abortController.abort();

  assert.deepEqual(await slot.take(input({ abortController }), parts), { status: "cancelled" });
  assert.deepEqual(parts.log, []);
  assert.equal(slot.answering, false);
});

test("a cancelled run interrupts the engine, and is cancelled whatever the engine then says", async () => {
  const slot = new TurnSlot<TestTurn>(10_000, () => {});
  const parts = engine();
  const abortController = new AbortController();
  const running = slot.take(input({ abortController }), parts);

  abortController.abort();
  assert.deepEqual(parts.log, ["begin", "interrupt"]);
  assert.equal(slot.answering, true, "the engine's own result still ends the turn");

  slot.settle({ status: "succeeded" });
  assert.deepEqual(await running, { status: "cancelled" });
});

test("an interrupt nobody answers gives the session up, and one that is answered does not", async () => {
  const abandoned: string[] = [];
  const slot = new TurnSlot<TestTurn>(0, () => abandoned.push("abandoned"));
  const answered = new TurnSlot<TestTurn>(0, () => abandoned.push("abandoned"));

  const abortController = new AbortController();
  const lost: Promise<ProviderResult> = slot.take(input({ abortController }), engine());
  abortController.abort();
  await settled();
  assert.deepEqual(abandoned, ["abandoned"]);
  assert.deepEqual(await lost, { status: "cancelled" });

  const answeredAbort = new AbortController();
  const running = answered.take(input({ abortController: answeredAbort }), engine());
  answeredAbort.abort();
  answered.settle({ status: "cancelled" });
  await settled();
  assert.deepEqual(abandoned, ["abandoned"], "the turn came back before the grace period was out");
  assert.deepEqual(await running, { status: "cancelled" });
});

test("a settled turn lets go of the run it was listening to", async () => {
  const slot = new TurnSlot<TestTurn>(10_000, () => {});
  const parts = engine();
  const abortController = new AbortController();
  const running = slot.take(input({ abortController }), parts);

  slot.settle({ status: "succeeded" });
  abortController.abort();
  assert.deepEqual(parts.log, ["begin"], "nothing is left to interrupt");
  assert.deepEqual(await running, { status: "succeeded" });
});

/** A run that records what it was told, and steers the given messages in, then nothing more. */
function recorded(steered: SteerMessage[] = [], overrides: Parameters<typeof input>[0] = {}) {
  const events: ProviderEvent[] = [];
  const queue = [...steered];
  return { events, input: input({ emit: (event) => events.push(event), steering: { next: async () => queue.shift() ?? null }, ...overrides }) };
}

test("a session that cannot open fails the turn, and says so when the continuation is gone", async () => {
  const slot = new TurnSlot<TestTurn>(10_000, () => {});
  const run = recorded();
  const running = slot.take(run.input, engine());
  const turn = slot.turn!;

  assert.equal(await slot.opened(turn, Promise.reject(new OpenFailure("gone", true)), (error) => `could not start: ${(error as Error).message}`), false);
  assert.deepEqual(run.events, [{ type: "continuation-lost" }]);
  assert.deepEqual(await running, { status: "failed", message: "could not start: gone" });

  const other = recorded();
  const next = slot.take(other.input, engine());
  assert.equal(await slot.opened(slot.turn!, Promise.reject(new Error("no binary")), () => "could not start"), false);
  assert.deepEqual(other.events, [], "only a lost continuation is reported as lost");
  assert.deepEqual(await next, { status: "failed", message: "could not start" });
});

test("a session reports its handle to the first turn it answers, and to none after", async () => {
  const slot = new TurnSlot<TestTurn>(10_000, () => {});
  slot.announce({ provider: "codex", value: "thread-1" });
  const first = recorded();
  void slot.take(first.input, engine());
  assert.equal(await slot.opened(slot.turn!, Promise.resolve(), () => ""), true);
  slot.announce({ provider: "codex", value: "thread-1" });
  slot.settle({ status: "succeeded" });

  const second = recorded();
  void slot.take(second.input, engine());
  slot.announce({ provider: "codex", value: "thread-1" });
  assert.deepEqual(first.events, [{ type: "continuation", continuation: { provider: "codex", value: "thread-1" } }], "nothing is announced with no turn to hear it");
  assert.deepEqual(second.events, []);
});

test("steering feeds each message in while the turn is going, and words a refusal the same for every engine", async () => {
  const run = recorded([{ messageId: "m1", prompt: "first" }, { messageId: "m2", prompt: "refused" }, { messageId: "m3", prompt: "late" }]);
  const sent: string[] = [];
  let going = true;
  await drainSteering(run.input, () => going ? "turn" : undefined, async (into, prompt) => {
    sent.push(`${into}:${prompt}`);
    if (prompt === "refused") {
      throw new Error("busy\nstack");
    }
    going = false;
  });
  assert.deepEqual(sent, ["turn:first"], "a turn that ended takes no more");
  assert.deepEqual(run.events, [{ type: "steered", messageId: "m1" }]);

  const refused = recorded([{ messageId: "m2", prompt: "refused" }]);
  await drainSteering(refused.input, () => "turn", async () => { throw new Error("busy\nstack"); });
  assert.deepEqual(refused.events, [{ type: "steer-failed", messageId: "m2", message: "Could not steer: busy. Your message is still queued for the next turn." }]);
});

test("a compaction is measured from the context before it began, and said once", () => {
  const auto = recorded();
  const turn: SessionTurn & Compacting = { input: auto.input, settle: () => {}, release: () => {} };
  reportCompacting(turn, true, 1_200);
  reportCompacting(turn, true, 5_000);
  reportCompacting(turn, false, 5_000, "Could not compact context: offline");
  assert.equal(turn.compactionPreTokens, 1_200);
  assert.deepEqual(auto.events, [{ type: "compaction-status", compacting: true }, { type: "compaction-status", compacting: false, error: "Could not compact context: offline" }]);

  const manual = recorded([], { operation: { type: "compact", preTokens: 9_000 } });
  const asked: SessionTurn & Compacting = { input: manual.input, settle: () => {}, release: () => {} };
  reportCompacting(asked, true, 1_200);
  assert.equal(asked.compactionPreTokens, 9_000, "a manual compaction was told what it starts from");
});
