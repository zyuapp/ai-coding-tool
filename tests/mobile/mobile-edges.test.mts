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
  for (const selector of [".composer-pill", ".queued-steer", ".changes-retry", ".work-more"]) {
    assert.match(rule(selector), /border: 1px solid var\(--line-control\)/, selector);
  }
});
