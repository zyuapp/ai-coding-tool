import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const stylesCss = await readFile(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
const composerTsx = await readFile(new URL("../src/renderer/components/TaskComposer.tsx", import.meta.url), "utf8");

function rule(selector: string) {
  const found = new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(stylesCss);
  assert.ok(found, `${selector} is declared`);
  return found[1];
}

/**
 * A panel parks outside the shell. `hidden` clips it but leaves the shell scrollable, so putting the
 * caret in a parked panel scrolls the window across to reveal it — which drags the sidebar, the topbar
 * and the conversation off the left edge while the panel itself appears not to move at all.
 */
test("the shell clips what parks outside it rather than leaving a box that can be scrolled", () => {
  assert.match(rule(".app-shell"), /overflow:\s*clip;/);
});

test("the composer takes the caret without scrolling the window to reach it", () => {
  assert.match(composerTsx, /focus\(\{ preventScroll: true \}\)/);
});
