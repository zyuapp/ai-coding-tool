import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const css = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");

test("the open thread's menu waits for hover or focus like every row's", () => {
  assert.doesNotMatch(css, /\.task-entry\[aria-current\] \.task-more/);
  assert.doesNotMatch(css, /\.task-entry\[aria-current\] \.row-rail/);
});

test("in Priority, Dismiss covers the engine slot and the menu the one beside it", () => {
  assert.match(css, /\.priority-list \{ --rail-actions: 2; \}/);
  assert.match(css, /:has\(\.task-dismiss\) \.row-marks > :nth-last-child\(2\)/);
  assert.doesNotMatch(css, /\.task-dismiss \{ margin-right/);
});

test("a draggable thread shows its grip on the open row too", () => {
  assert.match(css, /:is\(\.project-task-row, \.task-row\):not\(\.offline\)::after/);
});

test("a row's meta line steps up on the hover fill, and the open Settings wears the selected row's fill", () => {
  assert.match(css, /\.task-row:hover:not\(\.offline\) \.task-row-text > small \{ color: var\(--quiet-strong\); \}/);
  assert.match(css, /\.sidebar-settings\.active \{ background: var\(--row-selected\);/);
});
