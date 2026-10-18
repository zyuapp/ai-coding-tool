import assert from "node:assert/strict";
import { test } from "vitest";
import { deliveryLabel, threadModelOf } from "../../src/domain/coordination.ts";
import { threadRoleLabel } from "../../src/domain/thread-role.ts";
import type { Thread } from "../../src/domain/thread.ts";

test("a delivery reads by its name, and one only a newer build on a paired computer knows by its own", () => {
  assert.equal(deliveryLabel("pull-request"), "Pull request");
  assert.equal(deliveryLabel("release"), "release");
});

test("a coordinator a newer build left on a model this one does not know keeps it, and a role it does not know reads by its id", () => {
  const lead: Thread = { id: "lead", title: "Lead", engine: "claude", executionPolicy: "confirm", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, role: "coordinator" };
  assert.deepEqual(threadModelOf({ ...lead, model: "opus", threadModel: { model: "opus-next" as never, effort: "galaxy" as never } }), { model: "opus-next", effort: "galaxy" }, "kept as that build chose it, for the window to name and leave alone");
  assert.equal(threadModelOf({ ...lead, model: "opus-next" as never }).model, "opus-next");
  assert.equal(threadRoleLabel("designer" as never), "designer");
});
