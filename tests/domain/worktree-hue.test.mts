import assert from "node:assert/strict";
import { test } from "vitest";
import { WORKTREE_HUES, worktreeHue, worktreeDirectoryName } from "../../src/domain/worktree.ts";

test("a checkout keeps one hue, and every hue is one the stylesheet defines", () => {
  const ids = ["a1b2c3d4", "0f9e8d7c", "deadbeef", "", "ai-coding-tool-a1b2c3d4"];
  for (const id of ids) {
    const hue = worktreeHue(id);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < WORKTREE_HUES, `${id} gave ${hue}`);
    assert.equal(hue, worktreeHue(id));
  }
});

test("the hues spread across the palette rather than landing on one colour", () => {
  const ids = Array.from({ length: 60 }, (_, index) => worktreeDirectoryName("/repo/ai-coding-tool", index.toString(16).padStart(8, "0")));
  assert.equal(new Set(ids.map(worktreeHue)).size, WORKTREE_HUES);
});
