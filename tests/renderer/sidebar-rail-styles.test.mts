import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const css = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");

test("the open thread shows its menu at rest, over the engine mark only when there is a menu", () => {
  assert.match(css, /\.task-entry\[aria-current\] \.task-more \{ opacity: 1; \}/);
  assert.match(css, /\.task-entry\[aria-current\] \.row-rail:has\(\.task-more\) \.row-marks > :last-child,/);
});

test("in Priority, Dismiss sits a slot ahead of the status mark, which stays in view", () => {
  assert.match(css, /\.priority-list \{ --rail-actions: 3; \}/);
  assert.match(css, /\.task-dismiss \{ margin-right: calc\(var\(--row-slot\) - 3px\); \}/);
  assert.doesNotMatch(css, /:has\(\.task-dismiss\) \.row-marks > :nth-last-child\(2\)/);
});

test("a draggable thread shows its grip on the open row too", () => {
  assert.match(css, /:is\(\.project-task-row, \.task-row\):not\(\.offline\)::after/);
});

test("a row's meta line steps up on the hover fill, and the open Settings wears the selected row's fill", () => {
  assert.match(css, /\.task-row:hover:not\(\.offline\) \.task-row-text > small \{ color: var\(--quiet-strong\); \}/);
  assert.match(css, /\.sidebar-settings\.active \{ background: var\(--row-selected\);/);
});
