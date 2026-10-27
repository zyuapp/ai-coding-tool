import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { THEMES } from "../../src/domain/theme.ts";

const themesCss = await readFile(new URL("../../src/renderer/themes.css", import.meta.url), "utf8");
const stylesCss = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");

function primitives(id: string) {
  const block = new RegExp(`\\[data-theme="${id}"\\] \\{([^}]*)\\}`).exec(themesCss);
  assert.ok(block, `${id} has a block`);
  return new Map([...block[1].matchAll(/(--p-[a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map(([, name, value]) => [name, value]));
}

/** The semantic tokens styles.css derives, keyed by name, as their unresolved expressions. */
const tokenBlock = /:root,\s*\[data-theme\] \{([\s\S]*?)\n\}/.exec(stylesCss)![1];
const tokens = new Map([...tokenBlock.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]));

type Rgb = readonly [number, number, number];

function channels(hex: string): Rgb {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as unknown as Rgb;
}

/** Resolves a var() or an srgb color-mix of two var()s, which is every text and line token's form. */
function resolve(expression: string, palette: Map<string, string>): Rgb {
  const variable = /^var\((--[a-z0-9-]+)\)$/.exec(expression);
  if (variable) {
    const name = variable[1];
    const hex = palette.get(name);
    if (hex) return channels(hex);
    const token = tokens.get(name);
    assert.ok(token, `${name} is declared`);
    return resolve(token, palette);
  }
  const mixed = /^color-mix\(in srgb, (var\([^)]+\)) (\d+)%, (var\([^)]+\))\)$/.exec(expression);
  assert.ok(mixed, `${expression} is a var() or an srgb mix`);
  const [first, second, share] = [resolve(mixed[1], palette), resolve(mixed[3], palette), Number(mixed[2]) / 100];
  return first.map((channel, index) => channel * share + second[index] * (1 - share)) as unknown as Rgb;
}

function luminance(rgb: Rgb) {
  const [r, g, b] = rgb.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb) {
  const [high, low] = [luminance(a), luminance(b)].sort((first, second) => second - first);
  return (high + 0.05) / (low + 0.05);
}

/** Every pairing below fails if any theme draws it under its minimum, and names each one that does. */
function failures(pairs: readonly (readonly [string, string, number])[]) {
  const failed: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    for (const [ink, ground, minimum] of pairs) {
      const ratio = contrast(resolve(`var(${ink})`, palette), resolve(`var(${ground})`, palette));
      if (ratio < minimum) failed.push(`${theme.id}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1`);
    }
  }
  return failed;
}

const TEXT_GROUNDS = ["--canvas", "--sunken", "--surface", "--sidebar", "--surface-menu", "--surface-raised", "--surface-hover"];
const TEXT = ["--ink", "--ink-soft", "--ink-dim", "--ink-faint", "--muted-strong", "--muted", "--muted-soft", "--quiet-strong", "--quiet", "--quiet-soft"];
const HUES = ["--accent", "--danger", "--link", "--success"];
const HUE_GROUNDS = ["--canvas", "--sunken", "--surface", "--sidebar"];

test("every rung of the text ladder reads at AA on every surface text sits on", () => {
  assert.deepEqual(failures(TEXT.flatMap((ink) => TEXT_GROUNDS.map((ground) => [ink, ground, 4.5] as const))), []);
});

test("body text reaches AAA on the canvas", () => {
  assert.deepEqual(failures([["--ink", "--canvas", 7]]), []);
});

test("the ladder keeps its order, so a quieter rung never reads louder than the one above it", () => {
  const failed: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    const canvas = resolve("var(--canvas)", palette);
    const ratios = TEXT.map((ink) => contrast(resolve(`var(${ink})`, palette), canvas));
    ratios.forEach((ratio, index) => { if (index && ratio > ratios[index - 1] + 0.01) failed.push(`${theme.id}: ${TEXT[index]} outreads ${TEXT[index - 1]}`); });
  }
  assert.deepEqual(failed, []);
});

test("accent, danger, link and success text read at AA on the surfaces they colour", () => {
  assert.deepEqual(failures(HUES.flatMap((ink) => HUE_GROUNDS.map((ground) => [ink, ground, 4.5] as const))), []);
  assert.deepEqual(failures([["--danger", "--danger-surface", 4.5]]), []);
});

test("a highlighted menu row's label reads at AA on the accent or danger fill behind it", () => {
  assert.deepEqual(failures([["--accent-ink", "--accent", 4.5], ["--accent-ink", "--danger", 4.5]]), []);
});

test("the focus ring, input edges and scroll thumb clear 3:1 against what they are drawn on", () => {
  const pairs = [
    ...[...TEXT_GROUNDS, "--surface-active"].map((ground) => ["--focus-ring", ground, 3] as const),
    ...HUE_GROUNDS.flatMap((ground) => [["--line-input", ground, 3], ["--scroll-thumb", ground, 3]] as const),
  ];
  assert.deepEqual(failures(pairs), []);
});

test("every size token a stylesheet names is declared", async () => {
  const sheets = ["styles.css", "worktree-settings.css", "worktree-menu.css", "components/coordination.css", "components/question-prompt.css"];
  const missing: string[] = [];
  for (const sheet of sheets) {
    const css = await readFile(new URL(`../../src/renderer/${sheet}`, import.meta.url), "utf8");
    for (const [, name] of css.matchAll(/var\((--text-[a-z-]+)\)/g)) if (!tokens.has(name)) missing.push(`${sheet}: ${name}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test("no text size token falls below 11px", () => {
  const small = [...tokens].filter(([name, value]) => name.startsWith("--text-") && /^\d+px$/.test(value) && Number.parseInt(value) < 11);
  assert.deepEqual(small, []);
});
