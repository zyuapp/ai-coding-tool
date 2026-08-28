import assert from "node:assert/strict";
import { test } from "vitest";
import { rankThreadJumps, type ThreadJumpOption } from "../../src/domain/thread-jump.ts";

/** Newest first, which is the order the panel hands its list over in. */
function options(...titles: string[]): ThreadJumpOption[] {
  return titles.map((title, index) => ({
    id: `task-${index}`,
    title,
    project: null,
    engine: "claude" as const,
    lastActivityAt: titles.length - index,
  }));
}

const THREADS = options("Dock the browser panel", "Panel find", "Rework the panel tabs", "Ship the dock");

test("an empty query offers the most recent threads", () => {
  assert.deepEqual(rankThreadJumps(THREADS, "").map((option) => option.title), THREADS.map((option) => option.title));
  assert.deepEqual(rankThreadJumps(THREADS, "  ", 2).map((option) => option.title), ["Dock the browser panel", "Panel find"]);
});

test("a name that starts a thread beats one that starts a word, which beats one buried in the middle", () => {
  assert.deepEqual(rankThreadJumps(THREADS, "panel").map((option) => option.title), [
    "Panel find",
    "Dock the browser panel",
    "Rework the panel tabs",
  ]);
});

test("threads of the same rank stay newest first", () => {
  assert.deepEqual(rankThreadJumps(THREADS, "dock").map((option) => option.title), ["Dock the browser panel", "Ship the dock"]);
});

test("a name nothing answers offers nothing", () => {
  assert.deepEqual(rankThreadJumps(THREADS, "worktree"), []);
});

test("the case of the query and of the title do not matter", () => {
  assert.deepEqual(rankThreadJumps(THREADS, "SHIP").map((option) => option.title), ["Ship the dock"]);
});

test("a long list is read only as far as the best matches the panel can draw", () => {
  const many = options(...Array.from({ length: 500 }, (_, index) => `Panel ${index}`), "Reopen the panel");
  const rows = rankThreadJumps(many, "panel", 3);
  assert.deepEqual(rows.map((option) => option.title), ["Panel 0", "Panel 1", "Panel 2"]);
});
