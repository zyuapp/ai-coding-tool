import assert from "node:assert/strict";
import { test } from "vitest";
import { diffRows, parseFilePatch, splitRows } from "../src/domain/diff.ts";
import { withinHighlightBudget } from "../src/renderer/diff/highlight.ts";

const PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " const first = 1;",
  "-const second = 2;",
  "+const second = 22;",
  "",
].join("\n");

test("diff views reuse parsed line objects with final keys", () => {
  const file = parseFilePatch(PATCH, "src/app.ts");
  const parsed = file.hunks.flatMap((hunk) => hunk.rows);
  const unified = diffRows(file).filter((row) => row.kind !== "hunk");
  const sides = splitRows(file)
    .flatMap((row) => row.kind === "pair" ? [row.left, row.right] : [])
    .filter((row): row is (typeof parsed)[number] => row !== null && row.kind !== "hunk");

  assert.equal(unified.length, parsed.length);
  assert.deepEqual(parsed.map((row) => row.key), ["0:c1:1", "0:o2", "0:n2"]);
  for (const [index, row] of unified.entries()) assert.equal(row, parsed[index]);
  for (const row of sides) assert.ok(parsed.includes(row));
});

test("syntax highlighting budgets all hunks together", () => {
  const line = `const value = "${"x".repeat(60_000)}";`;
  const patch = ["@@ -1 +1 @@", ` ${line}`, "@@ -3 +3 @@", ` ${line}`, ""].join("\n");

  assert.equal(withinHighlightBudget(parseFilePatch(patch, "src/app.ts")), false);
  assert.equal(withinHighlightBudget(parseFilePatch(PATCH, "src/app.ts")), true);
});
