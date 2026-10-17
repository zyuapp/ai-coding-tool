import assert from "node:assert/strict";
import { test } from "vitest";
import { RunningTotals } from "../../../src/main/agent/running-totals.mts";

test("a running total adds only what it grew by, and a report behind a later one adds nothing", () => {
  const totals = new RunningTotals();
  assert.equal(totals.grow("a", 100), 100);
  assert.equal(totals.grow("a", 100), 0, "the same report again");
  assert.equal(totals.grow("a", 140), 40);
  assert.equal(totals.grow("a", 120), 0, "a report behind the newest");
  assert.equal(totals.grow("a", 150), 10, "counted from the newest seen");
  assert.equal(totals.grow("b", 30), 30, "each key on its own");
});

test("a key first seen with what it spent before counts only what came after", () => {
  const totals = new RunningTotals();
  assert.equal(totals.grow("resumed", 5_000, 4_800), 200);
  assert.equal(totals.grow("resumed", 5_100, 0), 100, "the baseline only counts the first time");
  assert.equal(totals.grow("x", Number.NaN), 0);
  assert.equal(totals.grow("x", -1), 0);
  assert.equal(totals.has("x"), false, "no count at all is not a sighting");
});
