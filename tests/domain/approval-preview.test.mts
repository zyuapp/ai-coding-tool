import assert from "node:assert/strict";
import { test } from "vitest";
import { approvalPreview } from "../../src/domain/approval-preview.ts";

test("an approval reads as the action its input describes", () => {
  assert.deepEqual(approvalPreview({ file_path: "a.ts", old_string: "one\ntwo", new_string: "" }), { kind: "edit", path: "a.ts", removed: ["one", "two"], added: [] }, "an edit that only deletes adds no line");
  assert.deepEqual(approvalPreview({ file_path: "a.ts", old_string: "one\n", new_string: "two\n\nthree\n" }), { kind: "edit", path: "a.ts", removed: ["one"], added: ["two", "", "three"] }, "a closing newline is not a line of its own");
  assert.deepEqual(approvalPreview({ file_path: "a.ts", content: "x" }), { kind: "file", path: "a.ts", content: "x" });
  assert.deepEqual(approvalPreview({ command: "ls", description: "List" }), { kind: "command", command: "ls" });
  assert.deepEqual(approvalPreview({ file_path: "a.ts" }), { kind: "subject", text: "a.ts" }, "a call that only names a file shows the file");
  assert.deepEqual(approvalPreview({ url: "https://example.com" }), { kind: "subject", text: "https://example.com" });
  assert.deepEqual(approvalPreview({ query: "a" }), { kind: "raw" });
});
