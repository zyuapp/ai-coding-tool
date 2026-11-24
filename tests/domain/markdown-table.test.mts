import assert from "node:assert/strict";
import { test } from "vitest";
import { formatTable } from "../../src/domain/markdown-table.js";

test("columns line up in monospace, counting wide text as two columns and keeping each column's alignment", () => {
  const table = formatTable([["name", "n", "mid"], ["中文", "10"], ["ok", "7", "x"]], ["left", "right", "center"]);

  assert.equal(table, [
    "| name |   n | mid |",
    "| :--- | --: | :-: |",
    "| 中文 |  10 |     |",
    "| ok   |   7 |  x  |",
  ].join("\n"));
});
