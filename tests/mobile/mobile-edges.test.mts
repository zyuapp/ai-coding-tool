import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const mobileCss = await readFile(new URL("../../src/mobile/mobile.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(mobileCss);
  assert.ok(found, `${selector} has a rule`);
  return found[1];
}

test("labelled pills and buttons on the phone wear the quiet control edge", () => {
  for (const selector of [".composer-pill", ".queued-steer", ".changes-retry", ".work-more", "button.thread-start-project"]) {
    assert.match(rule(selector), /border: 1px solid var\(--line-control\)/, selector);
  }
  assert.match(mobileCss, /\n\.thread-start-toggle \{\n  position: relative;[^}]*border: 1px solid var\(--line-control\)/, ".thread-start-toggle");
});

test("a copy says what happened in words, not only by colour", () => {
  assert.match(rule(".copy-affordance.copied::after"), /content: "Copied"/);
  assert.match(rule(".copy-affordance.failed::after"), /content: "Copy failed"/);
});

test("the answer's copy button has no chip at rest", () => {
  assert.doesNotMatch(rule(".answer-meta > .copy-affordance"), /background/);
});

test("the transcript makes room for the offline chip over the composer so it never covers the last line", () => {
  assert.match(rule(".transcript:has(~ .composer .composer-waiting)"), /padding-bottom: 56px/);
});
