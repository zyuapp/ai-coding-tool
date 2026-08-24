import assert from "node:assert/strict";
import { test } from "vitest";
import { diffRows, parseFilePatch, splitRows } from "../src/domain/diff.ts";
import { ensureLanguage, fileTokens } from "../src/renderer/diff/highlight.ts";

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

test("colour is read one hunk at a time, and only for the hunks asked for", async () => {
  await ensureLanguage("typescript");
  const patch = [
    "@@ -1,1 +1,1 @@",
    "-const first = 1;",
    "+const first = 11;",
    "@@ -9,1 +9,1 @@",
    "-const second = 2;",
    "+const second = 22;",
    "",
  ].join("\n");
  const file = parseFilePatch(patch, "src/app.ts");
  const [firstHunk, secondHunk] = file.hunks.map((hunk) => hunk.rows.map((row) => row.key));
  const colours = fileTokens(file);

  assert.deepEqual([...colours.tokens.keys()], []);
  assert.equal(colours.colour(0), true);
  assert.deepEqual([...colours.tokens.keys()].sort(), [...firstHunk!].sort());
  /** A hunk already read is not read again, and says so, or drawing it would loop. */
  assert.equal(colours.colour(0), false);

  assert.equal(colours.colour(1), true);
  assert.deepEqual([...colours.tokens.keys()].sort(), [...firstHunk!, ...secondHunk!].sort());
});

test("a line names the hunk that colours it", () => {
  const file = parseFilePatch(PATCH, "src/app.ts");
  const colours = fileTokens(file);
  for (const row of file.hunks[0]!.rows) assert.equal(colours.hunkOf.get(row.key), 0);
});
