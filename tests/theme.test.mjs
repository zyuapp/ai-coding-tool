import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_THEME, DEFAULT_THEME_MODE, THEMES, isThemeMode, nextTheme, themeById, themeFamilies, themeFor, themeModeOrDefault, themeOrDefault, variantFor } from "../dist/main/domain/theme.js";

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

/** How far a shadow moves the canvas it falls on: its alpha times its distance from that canvas. */
function shadowWeight(tokens) {
  const canvas = channels(tokens.get("--p-bg-0"));
  const shadow = tokens.get("--p-shadow").split(/\s+/).map((value) => Number(value) / 255);
  const scale = Number(tokens.get("--p-shadow-scale"));
  const distance = canvas.reduce((total, channel, index) => total + Math.abs(channel - shadow[index]), 0) / 3;
  return 0.45 * scale * distance;
}

test("shadows fall at one weight across the themes of a variant", () => {
  for (const variant of ["dark", "light"]) {
    const weights = THEMES.filter((theme) => theme.variant === variant)
      .map((theme) => ({ id: theme.id, weight: shadowWeight(blocks.get(theme.id)) }));
    const heaviest = weights.reduce((worst, entry) => entry.weight > worst.weight ? entry : worst);
    const lightest = weights.reduce((best, entry) => entry.weight < best.weight ? entry : best);
    const spread = heaviest.weight / lightest.weight;
    assert.ok(spread <= 1.2, `${heaviest.id} casts a shadow ${spread.toFixed(2)}x the one ${lightest.id} casts`);
  }
});

/**
 * Pairs that must never resolve alike, because one is drawn on the other: a divider on the surface
 * it divides, and the terminal's black slot on the ground the terminal paints.
 */
const MUST_DIFFER = [
  ["--p-line-0", "--p-bg-1"],
  ["--p-line-0", "--p-bg-2"],
  ["--p-line-1", "--p-bg-2"],
  ["--p-ansi-black", "--p-bg-4"],
  ["--p-ansi-white", "--p-bg-4"],
];

test("nothing is drawn in the colour of the thing it is drawn on", () => {
  const collisions = [];
  for (const theme of THEMES) {
    const tokens = blocks.get(theme.id);
    for (const [drawn, ground] of MUST_DIFFER) {
      if (tokens.get(drawn) === tokens.get(ground)) collisions.push(`${theme.id}: ${drawn} is ${ground} (${tokens.get(drawn)})`);
    }
  }
  assert.deepEqual(collisions, []);
});

test("the semantic layer holds no colour of its own", () => {
  const literals = stylesCss
    .split("\n")
    .filter((line) => /^\s+--[a-z0-9-]+:/.test(line))
    .filter((line) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/.test(line));
  assert.deepEqual(literals, [], "a semantic token picked a hex instead of deriving from a primitive");
});

test("every family ships one theme per ground, which is what the picker's two axes assume", () => {
  for (const family of themeFamilies()) {
    for (const variant of ["dark", "light"]) {
      const matching = THEMES.filter((theme) => theme.family === family && theme.variant === variant);
      assert.equal(matching.length, 1, `${family} has ${matching.length} ${variant} themes`);
      assert.equal(themeFor(family, variant).id, matching[0].id);
    }
  }
  assert.equal(themeFamilies().length * 2, THEMES.length);
});

test("a family the app no longer ships falls back to one it does, on the ground that was asked for", () => {
  assert.equal(themeFor("A Palette We Dropped", "light").variant, "light");
  assert.equal(themeFor("A Palette We Dropped", "dark").family, themeOrDefault(DEFAULT_THEME).family);
});

test("the keyboard walks the families in a ring without changing the ground it is on", () => {
  const families = themeFamilies();
  for (const variant of ["dark", "light"]) {
    const first = themeFor(families[0], variant);
    assert.equal(nextTheme(first.id).family, families[1]);
    assert.equal(nextTheme(first.id).variant, variant);
    assert.equal(nextTheme(themeFor(families.at(-1), variant).id).family, families[0]);
  }
  assert.equal(themeOrDefault("a-theme-we-dropped").id, DEFAULT_THEME);
  assert.equal(nextTheme("a-theme-we-dropped").family, themeFamilies()[1], "an unknown id walks on from the default");
});

test("a mode names a ground, and only \"auto\" asks the system for one", () => {
  assert.equal(variantFor("dark", true), "dark");
  assert.equal(variantFor("dark", false), "dark");
  assert.equal(variantFor("light", true), "light");
  assert.equal(variantFor("auto", true), "dark");
  assert.equal(variantFor("auto", false), "light");
  assert.equal(themeModeOrDefault("a-mode-we-dropped"), DEFAULT_THEME_MODE);
  for (const mode of ["dark", "light", "auto"]) assert.ok(isThemeMode(mode), mode);
  assert.ok(!isThemeMode("system"));
});
