import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderResult } from "../../../src/main/agent/agent-provider.mts";
import { TurnSlot, type SessionTurn, type TurnEngine } from "../../../src/main/agent/session-turn.mts";
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
