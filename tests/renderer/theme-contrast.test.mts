import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { THEMES } from "../../src/domain/theme.ts";

const themesCss = await readFile(new URL("../../src/renderer/themes.css", import.meta.url), "utf8");
const stylesCss = await readFile(new URL("../../src/renderer/styles.css", import.meta.url), "utf8");

function themeBlock(id: string) {
  const block = new RegExp(`\\[data-theme="${id}"\\] \\{([^}]*)\\}`).exec(themesCss);
  assert.ok(block, `${id} has a block`);
  return block[1];
}

function primitives(id: string) {
  return new Map([...themeBlock(id).matchAll(/(--p-[a-z0-9-]+):\s*(#[0-9a-f]{6});/g)].map(([, name, value]) => [name, value]));
}

/** The semantic tokens styles.css derives, keyed by name, as their unresolved expressions. */
const tokenBlock = /:root,\s*\[data-theme\] \{([\s\S]*?)\n\}/.exec(stylesCss)![1];
const tokens = new Map([...tokenBlock.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]));

type Rgb = readonly [number, number, number];

function channels(hex: string): Rgb {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as unknown as Rgb;
}

/** Resolves a var(), with or without a fallback, or an srgb color-mix of two var()s. */
function resolve(expression: string, palette: Map<string, string>): Rgb {
  const variable = /^var\((--[a-z0-9-]+)(?:, (.+))?\)$/.exec(expression);
  if (variable) {
    const [, name, fallback] = variable;
    const hex = palette.get(name);
    if (hex) return channels(hex);
    if (name.startsWith("--p-") && fallback) return resolve(fallback, palette);
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

type Pair = readonly [string, string, number];

function shortfalls(id: string, palette: Map<string, string>, pairs: readonly Pair[]) {
  return pairs.flatMap(([ink, ground, minimum]) => {
    const ratio = contrast(resolve(`var(${ink})`, palette), resolve(`var(${ground})`, palette));
    return ratio < minimum ? [`${id}: ${ink} on ${ground} is ${ratio.toFixed(2)}:1`] : [];
  });
}

/** Every pairing below fails if any theme draws it under its minimum, and names each one that does. */
function failures(pairs: readonly Pair[]) {
  return THEMES.flatMap((theme) => shortfalls(theme.id, primitives(theme.id), pairs));
}

const TEXT_GROUNDS = ["--canvas", "--sunken", "--surface", "--sidebar", "--surface-menu", "--surface-raised", "--surface-hover"];
const TEXT = ["--ink", "--ink-soft", "--ink-dim", "--ink-faint", "--muted-strong", "--muted", "--muted-soft", "--quiet-strong", "--quiet"];
const LADDER = ["--ink", "--ink-soft", "--ink-dim", "--ink-faint", "--muted-strong", "--muted", "--muted-soft", "--quiet-strong", "--quiet", "--quiet-soft"];
const HUES = ["--accent-text", "--danger", "--link", "--success", "--warning", "--info"];
const AUTHORED_HUES = ["accent", "danger", "info", "link", "success", "warning"];
const HUE_GROUNDS = ["--canvas", "--sunken", "--surface", "--sidebar"];

test("ink through quiet read at AA on every surface text sits on, the selected row included", () => {
  assert.deepEqual(failures(TEXT.flatMap((ink) => [...TEXT_GROUNDS, "--surface-active"].map((ground) => [ink, ground, 4.5] as const))), []);
});

test("placeholders, glyphs and off states read at 3:1", () => {
  assert.deepEqual(failures([...TEXT_GROUNDS, "--surface-active"].map((ground) => ["--quiet-soft", ground, 3] as const)), []);
});

test("every name on the ladder is quieter than the one before it", () => {
  const failed: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    const canvas = resolve("var(--canvas)", palette);
    const ratios = LADDER.map((ink) => contrast(resolve(`var(${ink})`, palette), canvas));
    ratios.slice(1).forEach((ratio, index) => { if (ratio >= ratios[index]) failed.push(`${theme.id}: ${LADDER[index + 1]} reads as loud as ${LADDER[index]}`); });
  }
  assert.deepEqual(failed, []);
});

test("a count or label on a chip reads at AA", () => {
  assert.deepEqual(failures([["--muted", "--chip", 4.5], ["--ink-dim", "--chip", 4.5]]), []);
});

test("body text reaches AAA on the canvas", () => {
  assert.deepEqual(failures([["--ink", "--canvas", 7]]), []);
});

const RUNGS = ["--ink", "--ink-dim", "--muted", "--quiet"];

test("the four text rungs stay a visible step apart, and the decorative grey sits below them all", () => {
  const failed: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    const canvas = resolve("var(--canvas)", palette);
    const ratios = RUNGS.map((ink) => contrast(resolve(`var(${ink})`, palette), canvas));
    ratios.slice(1).forEach((ratio, index) => { if (ratios[index] / ratio < 1.15) failed.push(`${theme.id}: ${RUNGS[index]} to ${RUNGS[index + 1]} is ${(ratios[index] / ratio).toFixed(2)}:1`); });
    if (contrast(resolve("var(--p-fg-5)", palette), canvas) >= ratios[3]) failed.push(`${theme.id}: fg-5 outreads --quiet`);
  }
  assert.deepEqual(failed, []);
});

test("fg-0 down to fg-4 falls in four even steps, each at least 1.15:1 and 0.6 apart", () => {
  const failed: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    const canvas = resolve("var(--canvas)", palette);
    const ratios = [0, 1, 2, 3, 4].map((step) => contrast(resolve(`var(--p-fg-${step})`, palette), canvas));
    const steps = ratios.slice(1).map((ratio, index) => ratios[index] / ratio);
    ratios.slice(1).forEach((ratio, index) => {
      if (steps[index] < 1.15 || ratios[index] - ratio < 0.6) failed.push(`${theme.id}: fg-${index} to fg-${index + 1} is ${steps[index].toFixed(2)}:1`);
    });
    if (Math.max(...steps) / Math.min(...steps) > 1.04) failed.push(`${theme.id}: steps run ${steps.map((step) => step.toFixed(2)).join(", ")}`);
  }
  assert.deepEqual(failed, []);
});

const HUE_PAIRS: readonly Pair[] = [
  ...HUES.flatMap((ink) => HUE_GROUNDS.map((ground) => [ink, ground, 4.5] as const)),
  ...["--accent-text", "--info"].map((ink) => [ink, "--surface-hover", 4.5] as const),
  ...["--danger", "--warning"].flatMap((ink) => ["--surface-hover", "--surface-active"].map((ground) => [ink, ground, 4.5] as const)),
  ["--danger", "--danger-surface", 4.5], ["--info", "--info-surface", 4.5], ["--info-soft", "--info-surface-soft", 4.5],
  ["--accent-soft", "--accent-chip", 4.5], ["--accent-soft", "--accent-surface", 4.5],
  ...[...TEXT_GROUNDS, "--surface-active"].map((ground) => ["--focus-ring", ground, 3] as const),
];
const FILL_PAIRS: readonly Pair[] = [["--accent-ink", "--accent", 4.5], ["--accent-ink", "--accent-hover", 4.5], ["--danger-ink", "--danger", 4.5], ["--badge-ink", "--info-badge", 4.5], ["--alert-ink", "--alert", 4.5]];

test("accent, danger, link, success, warning and info text read at AA on the surfaces they colour", () => {
  assert.deepEqual(failures(HUE_PAIRS), []);
});

test("a label reads at AA on every saturated fill it is drawn on", () => {
  assert.deepEqual(failures(FILL_PAIRS), []);
});

test("a theme adds a text twin for a hue only where the author's own hex cannot be read as text", () => {
  const needless: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    for (const hue of AUTHORED_HUES) {
      if (!palette.has(`--p-${hue}-text`)) continue;
      const without = new Map([...palette].filter(([name]) => name !== `--p-${hue}-text`));
      if (shortfalls(theme.id, without, [...HUE_PAIRS, ...FILL_PAIRS]).length === 0) needless.push(`${theme.id}: --p-${hue}-text`);
    }
  }
  assert.deepEqual(needless, []);
});

test("a text twin keeps its author's hue", () => {
  const hue = ([r, g, b]: Rgb) => {
    const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
    if (max === min) return 0;
    const raw = max === r ? (g - b) / (max - min) : max === g ? 2 + (b - r) / (max - min) : 4 + (r - g) / (max - min);
    return (raw * 60 + 360) % 360;
  };
  const drifted: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    for (const name of AUTHORED_HUES) {
      if (!palette.has(`--p-${name}-text`)) continue;
      const [fill, text] = [hue(channels(palette.get(`--p-${name}`)!)), hue(channels(palette.get(`--p-${name}-text`)!))];
      const apart = Math.min(Math.abs(fill - text), 360 - Math.abs(fill - text));
      if (apart > 12) drifted.push(`${theme.id}: --p-${name}-text is ${apart.toFixed(0)}° off`);
    }
  }
  assert.deepEqual(drifted, []);
});

test("dividers stay visible on a dark canvas", () => {
  const failed: string[] = [];
  for (const theme of THEMES.filter((candidate) => candidate.variant === "dark")) {
    const palette = primitives(theme.id);
    const canvas = resolve("var(--canvas)", palette);
    for (const [line, minimum] of [["--line-soft", 1.15], ["--line", 1.3]] as const) {
      const ratio = contrast(resolve(`var(${line})`, palette), canvas);
      if (ratio < minimum) failed.push(`${theme.id}: ${line} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(failed, []);
});

test("input edges and the scroll thumb clear 3:1 against what they are drawn on, the selected row included", () => {
  assert.deepEqual(failures([...HUE_GROUNDS, "--surface-hover", "--surface-active"].flatMap((ground) => [["--line-input", ground, 3], ["--scroll-thumb", ground, 3]] as const)), []);
});

function disabledOpacity(id: string) {
  assert.equal(tokens.get("--disabled-opacity"), "var(--p-disabled-opacity)");
  return Number(/--p-disabled-opacity:\s*([\d.]+);/.exec(themeBlock(id))![1]);
}

test("a disabled control's muted label still reads at 3:1, and its ink fades to under half its contrast", () => {
  const failed: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    const opacity = disabledOpacity(theme.id);
    for (const ground of ["--canvas", "--sunken", "--surface", "--sidebar"]) {
      const under = resolve(`var(${ground})`, palette);
      const faded = (ink: string) => {
        const color = resolve(`var(${ink})`, palette);
        return contrast(color.map((channel, index) => channel * opacity + under[index] * (1 - opacity)) as unknown as Rgb, under);
      };
      if (faded("--muted") < 3) failed.push(`${theme.id}: disabled --muted on ${ground} is ${faded("--muted").toFixed(2)}:1`);
      if (faded("--ink") > contrast(resolve("var(--ink)", palette), under) / 2) failed.push(`${theme.id}: disabled --ink on ${ground} barely fades`);
    }
  }
  assert.deepEqual(failed, []);
});

test("menu text on the glass surface reads at AA whatever shows through it", () => {
  const alpha = Number(/\/ ([\d.]+)\)$/.exec(tokens.get("--surface-glass")!)![1]);
  const failed: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    const glass = resolve("var(--p-bg-4)", palette);
    for (const behind of ["--p-fg-0", "--p-bg-0"]) {
      const seen = resolve(`var(${behind})`, palette);
      const ground = glass.map((channel, index) => channel * alpha + seen[index] * (1 - alpha)) as unknown as Rgb;
      for (const ink of ["--ink-dim", "--muted"]) {
        const ratio = contrast(resolve(`var(${ink})`, palette), ground);
        if (ratio < 4.5) failed.push(`${theme.id}: ${ink} over ${behind} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failed, []);
});

test("keyboard focus is drawn in the accent, so it never reads as muted chrome", () => {
  assert.equal(tokens.get("--focus-ring"), "var(--accent-text)");
});

test("a border under the pointer reads stronger than the one at rest", () => {
  const failed: string[] = [];
  for (const theme of THEMES) {
    const palette = primitives(theme.id);
    const canvas = resolve("var(--canvas)", palette);
    const [line, strong, bright] = ["--line", "--line-strong", "--line-bright"].map((name) => contrast(resolve(`var(${name})`, palette), canvas));
    if (!(line < strong && strong < bright)) failed.push(`${theme.id}: ${line.toFixed(2)} / ${strong.toFixed(2)} / ${bright.toFixed(2)}`);
  }
  assert.deepEqual(failed, []);
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

test("no text size token falls below 12px", () => {
  const size = (value: string): number => {
    const alias = /^var\((--text-[a-z-]+)\)$/.exec(value);
    return alias ? size(tokens.get(alias[1])!) : Number.parseInt(value);
  };
  const small = [...tokens].filter(([name, value]) => name.startsWith("--text-") && size(value) < 12);
  assert.deepEqual(small, []);
});

test("a hit target is at least 24px, and a row's slot never wider than one", () => {
  const [slot, target] = ["--row-slot", "--hit-target"].map((name) => Number.parseInt(tokens.get(name)!));
  assert.ok(target >= 24);
  assert.ok(slot <= target);
});

test("role marks clear 3:1 on every row ground, the selected row included", () => {
  const roles = ["--role-coordinator", "--role-implementer", "--role-reviewer", "--role-researcher"];
  assert.deepEqual(failures(roles.flatMap((role) => ["--sidebar", "--surface-hover", "--surface-active", "--sunken"].map((ground) => [role, ground, 3] as const))), []);
});
