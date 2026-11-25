import assert from "node:assert/strict";
import { test } from "vitest";
import { tableCopy } from "../../src/domain/table-copy.js";

test("the grid lines up in monospace, counting wide text as two columns", () => {
  const { grid } = tableCopy([["name", "n"], ["中文", "10"], ["ok", "7"]], ["left", "right"]);

  assert.equal(grid, [
    "| name |  n |",
    "| :--- | -: |",
    "| 中文 | 10 |",
    "| ok   |  7 |",
  ].join("\n"));
});
