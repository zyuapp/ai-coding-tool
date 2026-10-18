import assert from "node:assert/strict";
import { test } from "vitest";
import { deliveryLabel } from "../../src/domain/coordination.ts";

test("a delivery reads by its name, and one only a newer build on a paired computer knows by its own", () => {
  assert.equal(deliveryLabel("pull-request"), "Pull request");
  assert.equal(deliveryLabel("release"), "release");
});
