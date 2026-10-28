import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const css = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");

function rule(selector: string) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} has a rule`);
  return css.slice(start, css.indexOf("}", start));
}

test("menu items and picker options are rows of the same height, at least 28px", () => {
  const menu = Number(/\bheight: (\d+)px/.exec(rule(".menu-popover button"))![1]);
  const picker = Number(/min-height: (\d+)px/.exec(rule(".picker-popover .picker-option"))![1]);
  assert.equal(menu, picker);
  assert.ok(menu >= 28);
});

test("the row under the pointer wears the same highlight in a menu and a picker", () => {
  const highlight = (selector: string) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `${selector} is styled`);
    return /\{ ([^}]*) \}/.exec(css.slice(at))![1];
  };
  assert.equal(highlight('.menu-popover button:hover:not([aria-disabled="true"])'), highlight(".picker-option:hover:not(:disabled)"));
});

test("a command the computer cannot run is marked apart from a busy one", () => {
  assert.match(css, /button\[data-unsupported\]:not\(:focus-visible\) \{ outline: 1px dashed currentColor;/);
});
