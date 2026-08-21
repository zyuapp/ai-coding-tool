import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_THEME, THEMES, nextTheme, themeById, themeOrDefault } from "../dist/main/domain/theme.js";

const themesCss = await readFile(new URL("../src/renderer/themes.css", import.meta.url), "utf8");
const stylesCss = await readFile(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

/** The primitives one theme block declares, and its ground, keyed by the id in its selector. */
function themeBlocks(css) {
  const blocks = new Map();
  const pattern = /\[data-theme="([a-z-]+)"\] \{([^}]*)\}/g;
  for (const [, id, body] of css.matchAll(pattern)) {
    const tokens = new Map();
    for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+|color-scheme):\s*([^;]+);/g)) tokens.set(name, value.trim());
    blocks.set(id, tokens);
  }
  return blocks;
}

function channels(hex) {
  const value = hex.trim().replace("#", "");
  const full = value.length === 3 ? [...value].map((digit) => digit + digit).join("") : value;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16) / 255);
}

/** WCAG relative luminance, which the contrast ratio below is defined in terms of. */
function luminance(hex) {
  const [r, g, b] = channels(hex).map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((first, second) => second - first);
  return (high + 0.05) / (low + 0.05);
}

const blocks = themeBlocks(themesCss);

test("every theme the app offers is a block in the stylesheet, and every block is offered", () => {
  assert.deepEqual([...blocks.keys()].sort(), THEMES.map((theme) => theme.id).sort());
  assert.ok(themeById(DEFAULT_THEME), "the default is one of them");
});

test("a theme redefines every primitive the default declares, and invents none", () => {
  const expected = [...blocks.get(DEFAULT_THEME).keys()].sort();
  assert.ok(expected.length > 40, `the default declares ${expected.length} primitives`);
  for (const [id, tokens] of blocks) {
    assert.deepEqual([...tokens.keys()].sort(), expected, `${id} declares a different set`);
  }
});

test("the canvas each theme reports to the window is the canvas its block paints", () => {
  for (const theme of THEMES) {
    assert.equal(blocks.get(theme.id).get("--p-bg-0"), theme.canvas, `${theme.id}`);
    assert.equal(blocks.get(theme.id).get("color-scheme"), theme.variant, `${theme.id}`);
  }
});

test("body text clears WCAG AA on its own canvas in every theme", () => {
  for (const theme of THEMES) {
    const tokens = blocks.get(theme.id);
    const ratio = contrast(tokens.get("--p-fg-0"), tokens.get("--p-bg-0"));
    assert.ok(ratio >= 4.5, `${theme.id} draws ink on canvas at ${ratio.toFixed(2)}:1`);
  }
});

test("the semantic layer holds no colour of its own", () => {
  const literals = stylesCss
    .split("\n")
    .filter((line) => /^\s+--[a-z0-9-]+:/.test(line))
    .filter((line) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/.test(line));
  assert.deepEqual(literals, [], "a semantic token picked a hex instead of deriving from a primitive");
});

test("the keyboard walks the themes in a ring, and an unknown id lands on the default", () => {
  assert.equal(nextTheme(THEMES.at(-1).id).id, THEMES[0].id);
  assert.equal(nextTheme(THEMES[0].id).id, THEMES[1].id);
  assert.equal(themeOrDefault("a-theme-we-dropped").id, DEFAULT_THEME);
  assert.equal(nextTheme("a-theme-we-dropped").id, THEMES[1].id, "an unknown id walks on from the default");
});
