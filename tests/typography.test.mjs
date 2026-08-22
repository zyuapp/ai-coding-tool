import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_MONO_FONT,
  DEFAULT_UI_FONT,
  MONO_FONTS,
  READING_SIZE,
  TERMINAL_SIZE,
  UI_FONTS,
  customFontFamily,
  customFontId,
  monoFontOrDefault,
  sizeById,
  sizeOrDefault,
  stepSize,
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

test("a size is written onto the root rather than picked from blocks, so the stylesheet declares none", () => {
  assert.equal(blocks("data-reading-size").size, 0);
  assert.equal(blocks("data-terminal-size").size, 0);
});

test("the token each range writes over is the one the stylesheet already declares in px", () => {
  for (const [range, token] of [[READING_SIZE, "--text-content"], [TERMINAL_SIZE, "--terminal-text"]]) {
    const declared = Number.parseFloat(new RegExp(`${token}:\\s*(\\d+)px`).exec(stylesCss)[1]);
    assert.equal(declared, range.default, `${token}`);
  }
});

test("a range spans its default and every rung it used to offer", () => {
  for (const range of [READING_SIZE, TERMINAL_SIZE]) {
    assert.ok(range.min < range.default && range.default < range.max);
    for (const [rung, px] of Object.entries(range.legacy)) {
      assert.equal(sizeById(range, rung), px, rung);
      assert.ok(px >= range.min && px <= range.max, `${rung} lands outside the range`);
    }
  }
});

test("a size outside the range is no size at all, and an unreadable one lands on the default", () => {
  assert.equal(sizeById(READING_SIZE, READING_SIZE.max + 1), undefined);
  assert.equal(sizeById(READING_SIZE, READING_SIZE.min - 1), undefined);
  assert.equal(sizeById(READING_SIZE, "a-size-we-dropped"), undefined);
  assert.equal(sizeOrDefault(READING_SIZE, "a-size-we-dropped"), READING_SIZE.default);
  assert.equal(sizeOrDefault(READING_SIZE, null), READING_SIZE.default);
});

test("the size holds at the ends rather than wrapping", () => {
  assert.equal(stepSize(READING_SIZE, READING_SIZE.min, -1), READING_SIZE.min);
  assert.equal(stepSize(READING_SIZE, READING_SIZE.max, 1), READING_SIZE.max);
  assert.equal(stepSize(READING_SIZE, READING_SIZE.default, 1), READING_SIZE.default + 1);
});

test("a family the app only knows the name of survives a round trip, and one that could break the stack does not", () => {
  assert.equal(customFontFamily(customFontId("Helvetica Neue")), "Helvetica Neue");
  assert.equal(uiFontOrDefault(customFontId("Helvetica Neue")).label, "Helvetica Neue");
  for (const hostile of ['Fake", monospace; color: red; --x: "', "Fake\\", "Fake'", "", "A".repeat(65)]) {
    assert.equal(customFontFamily(customFontId(hostile)), undefined, hostile);
    assert.equal(uiFontOrDefault(customFontId(hostile)).id, DEFAULT_UI_FONT, hostile);
  }
});

test("a face the app no longer ships lands on the system's own", () => {
  assert.equal(uiFontOrDefault("a-face-we-dropped").id, DEFAULT_UI_FONT);
  assert.equal(monoFontOrDefault("a-face-we-dropped").id, DEFAULT_MONO_FONT);
});
