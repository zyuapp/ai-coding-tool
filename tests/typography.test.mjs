import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_MONO_FONT,
  DEFAULT_TEXT_SIZE,
  DEFAULT_UI_FONT,
  MONO_FONTS,
  TEXT_SIZES,
  UI_FONTS,
  monoFontOrDefault,
  stepTextSize,
  textSizeOrDefault,
  uiFontOrDefault,
} from "../dist/main/domain/typography.js";

const stylesCss = await readFile(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

/** The tokens one attribute block declares, keyed by the value in its selector. */
function blocks(attribute) {
  const found = new Map();
  const pattern = new RegExp(`\\[${attribute}="([a-z-]+)"\\] \\{([^}]*)\\}`, "g");
  for (const [, value, body] of stylesCss.matchAll(pattern)) {
    const tokens = new Map();
    for (const [, name, declared] of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) tokens.set(name, declared.trim());
    found.set(value, tokens);
  }
  return found;
}

/** Every family but the system's own, which is what the tokens already hold. */
function bundled(fonts, fallback) {
  return fonts.map((font) => font.id).filter((id) => id !== fallback).sort();
}

test("every family the app offers is a block in the stylesheet, and every block is offered", () => {
  assert.deepEqual([...blocks("data-ui-font").keys()].sort(), bundled(UI_FONTS, DEFAULT_UI_FONT));
  assert.deepEqual([...blocks("data-mono-font").keys()].sort(), bundled(MONO_FONTS, DEFAULT_MONO_FONT));
});

test("a family sets only the token it is the family for, and falls back to the system's own", () => {
  for (const [id, tokens] of blocks("data-ui-font")) {
    assert.deepEqual([...tokens.keys()], ["--ui-font"], `${id}`);
    assert.match(tokens.get("--ui-font"), /var\(--system-ui-font\)$/, `${id} has no fallback`);
  }
  for (const [id, tokens] of blocks("data-mono-font")) {
    assert.deepEqual([...tokens.keys()], ["--mono"], `${id}`);
    assert.match(tokens.get("--mono"), /var\(--system-mono-font\)$/, `${id} has no fallback`);
  }
});

test("every family the stylesheet names is one the app bundles a face for", async () => {
  const typographyCss = await readFile(new URL("../src/renderer/typography.css", import.meta.url), "utf8");
  const imported = [...typographyCss.matchAll(/@fontsource-variable\/([a-z-]+)\//g)].map(([, name]) => name);
  for (const [attribute, token] of [["data-ui-font", "--ui-font"], ["data-mono-font", "--mono"]]) {
    for (const [id, tokens] of blocks(attribute)) {
      const family = tokens.get(token).match(/^"([^"]+)"/)[1];
      const slug = family.replace(/ Variable$/, "").toLowerCase().replace(/ /g, "-");
      assert.ok(imported.includes(slug), `${id} asks for ${family}, which nothing imports`);
    }
  }
});

test("a size step moves only the one token it is for, so no chrome follows it", () => {
  for (const [id, tokens] of blocks("data-reading-size")) assert.deepEqual([...tokens.keys()], ["--text-content"], `${id}`);
  for (const [id, tokens] of blocks("data-terminal-size")) assert.deepEqual([...tokens.keys()], ["--terminal-text"], `${id}`);
});

/** The px each step declares, with the default read off the token block the steps override. */
function ladder(attribute, token) {
  const declared = blocks(attribute);
  const base = Number.parseFloat(new RegExp(`${token}:\\s*(\\d+)px`).exec(stylesCss)[1]);
  return TEXT_SIZES.map((size) => size.id === DEFAULT_TEXT_SIZE ? base : Number.parseFloat(declared.get(size.id).get(token)));
}

test("both ladders cover every step and climb", () => {
  for (const [attribute, token] of [["data-reading-size", "--text-content"], ["data-terminal-size", "--terminal-text"]]) {
    assert.deepEqual([...blocks(attribute).keys()].sort(), TEXT_SIZES.map((size) => size.id).filter((id) => id !== DEFAULT_TEXT_SIZE).sort());
    const sizes = ladder(attribute, token);
    for (let index = 1; index < sizes.length; index += 1) {
      assert.ok(sizes[index] > sizes[index - 1], `${attribute} goes ${sizes[index - 1]}px then ${sizes[index]}px`);
    }
  }
});

test("the steps hold at the ends rather than wrapping, and an unknown id lands on the default", () => {
  assert.equal(stepTextSize(TEXT_SIZES[0].id, -1).id, TEXT_SIZES[0].id);
  assert.equal(stepTextSize(TEXT_SIZES.at(-1).id, 1).id, TEXT_SIZES.at(-1).id);
  assert.equal(stepTextSize(TEXT_SIZES[0].id, 1).id, TEXT_SIZES[1].id);
  assert.equal(textSizeOrDefault("a-size-we-dropped").id, DEFAULT_TEXT_SIZE);
  assert.equal(uiFontOrDefault("a-face-we-dropped").id, DEFAULT_UI_FONT);
  assert.equal(monoFontOrDefault("a-face-we-dropped").id, DEFAULT_MONO_FONT);
});
