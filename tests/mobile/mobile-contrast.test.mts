import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { THEMES } from "../../src/domain/theme.ts";

const themesCss = await readFile(new URL("../../src/renderer/themes.css", import.meta.url), "utf8");
const mobileCss = await readFile(new URL("../../src/mobile/mobile.css", import.meta.url), "utf8");

function primitives(id: string) {
  const block = new RegExp(`\\[data-theme="${id}"\\] \\{([^}]*)\\}`).exec(themesCss);
  assert.ok(block, `${id} has a block`);
  return new Map([...block[1].matchAll(/(--p-[a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map(([, name, value]) => [name, value]));
}

/** The tokens the phone derives from the desktop's primitives, as their unresolved expressions. */
const tokenBlock = /:root,\s*\[data-theme\] \{([\s\S]*?)\n\}/.exec(mobileCss)![1];
const tokens = new Map([...tokenBlock.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]));

type Rgb = readonly [number, number, number];

function channels(hex: string): Rgb {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as unknown as Rgb;
}

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

const GROUNDS = ["--canvas", "--sunken", "--surface", "--surface-menu", "--surface-raised"];
const TEXT = ["--ink", "--ink-soft", "--ink-dim", "--ink-faint", "--muted-strong", "--muted", "--muted-soft", "--quiet-strong", "--quiet"];

test("every rung of the phone's text ladder reads at AA on every surface it sits on", () => {
  assert.deepEqual(failures(TEXT.flatMap((ink) => GROUNDS.map((ground) => [ink, ground, 4.5] as const))), []);
});

test("the offline mark and danger rows read at AA on their tinted grounds", () => {
  assert.deepEqual(failures([["--danger", "--danger-surface", 4.5], ["--danger-soft", "--surface-menu", 4.5], ["--danger-soft", "--danger-surface", 4.5]]), []);
});

test("control edges, the sheet grip and the focus ring clear 3:1", () => {
  assert.deepEqual(failures([
    ...["--canvas", "--surface", "--surface-menu"].map((ground) => ["--line-input", ground, 3] as const),
    ...GROUNDS.map((ground) => ["--focus-ring", ground, 3] as const),
  ]), []);
});
