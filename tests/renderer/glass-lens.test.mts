import assert from "node:assert/strict";
import { test } from "vitest";
import { lensMap } from "../../src/renderer/glass-lens.ts";

test("a lens map samples inward along every rim and leaves the middle of the pane alone", () => {
  const columns = 100;
  const rows = 40;
  const map = lensMap({ width: 200, height: 80, radius: 16 }, columns, rows);
  const at = (column: number, row: number) => {
    const index = (row * columns + column) * 4;
    return { x: map[index]! - 128, y: map[index + 1]! - 128 };
  };
  assert.deepEqual(at(50, 20), { x: 0, y: 0 });
  assert.ok(at(0, 20).x > 0 && at(0, 20).y === 0);
  assert.ok(at(columns - 1, 20).x < 0);
  assert.ok(at(50, 0).y > 0 && at(50, 0).x === 0);
  assert.ok(at(50, rows - 1).y < 0);
  assert.ok(at(3, 3).x > 0 && at(3, 3).y > 0);
});
