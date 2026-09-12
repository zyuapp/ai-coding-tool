import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { AUTOMATION_SETTLE_TIMEOUT, settledWithin } from "../../src/main/run-routing.ts";

test("a scheduled run that never reports back is called failed instead of holding the schedule", async (t) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  t.onTestFinished(() => { vi.useRealTimers(); });
  assert.equal(await settledWithin(Promise.resolve("succeeded"), 10_000), "succeeded");
  assert.equal(await settledWithin(Promise.resolve("cancelled"), 10_000), "cancelled");
  assert.ok(AUTOMATION_SETTLE_TIMEOUT >= 60 * 60_000, "the bound is far longer than an honest run");

  const bounded = settledWithin(new Promise(() => {}), 5);
  await vi.advanceTimersByTimeAsync(5);
  assert.equal(await bounded, "failed");
});
