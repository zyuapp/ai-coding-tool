import assert from "node:assert/strict";
import test from "node:test";
import { isPathInside } from "../dist/main/main/path-policy.mjs";

test("file edits stay inside the selected project", () => {
  assert.equal(isPathInside("/tmp/project", "/tmp/project/file.txt"), true);
  assert.equal(isPathInside("/tmp/project", "/tmp/project"), true);
  assert.equal(isPathInside("/tmp/project", "/tmp/project-copy/file.txt"), false);
  assert.equal(isPathInside("/tmp/project", "/tmp/elsewhere/file.txt"), false);
});
