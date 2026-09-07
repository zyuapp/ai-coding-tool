import assert from "node:assert/strict";
import { test } from "vitest";
import { WORKTREE_HUES, worktreeHue } from "../../src/domain/worktree.ts";

test("a checkout keeps a deterministic hue within the palette", () => {
  const ids = ["a1b2c3d4", "0f9e8d7c", "deadbeef", "", "ai-coding-tool-a1b2c3d4"];
  for (const id of ids) {
    const hue = worktreeHue(id);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < WORKTREE_HUES, `${id} gave ${hue}`);
    assert.equal(hue, worktreeHue(id));
  }
});
