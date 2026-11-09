import assert from "node:assert/strict";
import { test } from "vitest";
import { recencyLabel } from "../../src/domain/recency.ts";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

test("a moment is named by calendar days, not by hours elapsed", () => {
  assert.match(recencyLabel(at(9, 0, 10), at(9, 23)), /\d/, "earlier today is a time");
  assert.equal(recencyLabel(at(8, 23, 50), at(9, 0, 30)), "Yesterday", "forty minutes ago across midnight is yesterday");
  assert.equal(recencyLabel(at(3, 12), at(9, 12)), new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at(3, 12)));
  assert.equal(recencyLabel(at(2, 12), at(9, 12)), new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at(2, 12)), "a week back the weekday would be ambiguous");
});
