import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { recordUpdateRelaunch, takeUpdateRelaunch } from "../../src/main/update-relaunch.ts";

test("the threads an update cut off are handed to the build it installed, once", (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), "update-relaunch-"));
  t.onTestFinished(() => rmSync(userData, { recursive: true, force: true }));

  recordUpdateRelaunch(userData, "2.0.0", ["a", "b"]);
  assert.deepEqual(takeUpdateRelaunch(userData, "2.0.0"), ["a", "b"]);
  assert.deepEqual(takeUpdateRelaunch(userData, "2.0.0"), []);

  recordUpdateRelaunch(userData, "2.0.1", ["a"]);
  assert.deepEqual(takeUpdateRelaunch(userData, "2.0.0"), [], "an install that never took resumes nothing");
  assert.deepEqual(takeUpdateRelaunch(userData, "2.0.1"), [], "and its record is gone");
});
