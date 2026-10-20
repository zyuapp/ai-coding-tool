import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const ROOTS = ["../../src/renderer", "../../src/mobile"].map((root) => fileURLToPath(new URL(root, import.meta.url)));

/**
 * An icon sits centred in its box only when the room around it splits into whole pixels. The boxes
 * the app draws are even, so an odd icon lands half a pixel off, which shows as an icon a pixel to the
 * right of and below where it belongs. Every icon is sized evenly, whether by prop, default, or style.
 */
const ODD_SIZES: readonly { label: string; pattern: RegExp; extensions: readonly string[] }[] = [
  { label: "size prop", pattern: /\bsize=\{(\d+)\}/g, extensions: [".tsx"] },
  { label: "size default", pattern: /\bsize = (\d+)\b/g, extensions: [".tsx"] },
  { label: "svg style", pattern: /svg[^{}]*\{[^}]*?\b(?:width|height):\s*(\d+)px/g, extensions: [".css"] },
];

async function sources(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
}

test("every icon is sized evenly so it sits centred on whole pixels", async () => {
  const odd: string[] = [];
  for (const file of (await Promise.all(ROOTS.map(sources))).flat()) {
    const checks = ODD_SIZES.filter(({ extensions }) => extensions.includes(path.extname(file)));
    if (!checks.length) continue;
    const text = await readFile(file, "utf8");
    for (const { label, pattern } of checks) {
      for (const match of text.matchAll(pattern)) {
        if (Number(match[1]) % 2 === 0) continue;
        const line = text.slice(0, match.index).split("\n").length;
        odd.push(`${path.relative(process.cwd(), file)}:${line} ${label} ${match[1]}`);
      }
    }
  }
  assert.deepEqual(odd, [], `Icons with odd sizes sit half a pixel off centre:\n${odd.join("\n")}`);
});

/** Boxes that centre a letter or a count rather than an icon, which text lays out on its own terms. */
const TEXT_BOXES = new Set([".session-toggle > span", ".model-provider-initial"]);

test("every box that centres an icon is sized evenly, as the icons are", async () => {
  const odd: string[] = [];
  for (const file of (await Promise.all(ROOTS.map(sources))).flat()) {
    if (path.extname(file) !== ".css") continue;
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim().split("\n").at(-1)!.trim();
      const body = match[2];
      if (!/place-items:\s*center/.test(body) || TEXT_BOXES.has(selector)) continue;
      for (const [, property, value] of body.matchAll(/(?<![-\w])(width|height|grid-template-columns):\s*([^;]+);/g)) {
        const sizes = [...value.matchAll(/(\d+)px/g)].map(([, size]) => Number(size));
        if (sizes.some((size) => size % 2)) odd.push(`${path.relative(process.cwd(), file)} ${selector} ${property}: ${value.trim()}`);
      }
    }
  }
  assert.deepEqual(odd, [], `Boxes with odd sizes put the icons they centre half a pixel off:\n${odd.join("\n")}`);
});

/** Each class a button carries, read from every `className` written on a button element. */
function buttonClasses(sources: readonly string[]) {
  const classes = new Set<string>();
  for (const text of sources) {
    for (const [, attributes] of text.matchAll(/<(?:button|CommandButton|summary)\b([\s\S]*?)>/g)) {
      for (const [, plain, template, quoted] of attributes.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\}|\{"([^"]+)"\})/g)) {
        for (const name of (plain ?? template ?? quoted).replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) if (name) classes.add(name);
      }
    }
  }
  return classes;
}

/**
 * A button keeps the browser's own 6px each side unless told otherwise, which leaves a small icon button
 * less room than its icon and pushes the icon right of centre. A box that centres an icon on a button
 * says its padding itself.
 */
test("every button that centres an icon sets its own padding", async () => {
  const files = (await Promise.all(ROOTS.map(sources))).flat();
  const markup = await Promise.all(files.filter((file) => path.extname(file) === ".tsx").map((file) => readFile(file, "utf8")));
  const onButtons = buttonClasses(markup);
  const sheets = await Promise.all(files.filter((file) => path.extname(file) === ".css").map(async (file) => ({ file, text: await readFile(file, "utf8") })));
  const rules = sheets.flatMap(({ file, text }) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ file, selector: match[1].trim().split("\n").at(-1)!.trim(), body: match[2] })));
  const declares = (body: string) => /(?<![-\w])padding(?:-left|-inline)?\s*:/.test(body);
  /** The class an element is styled by, as the last compound of a selector names it. */
  const subject = (part: string) => /\.([\w-]+)[^\s>.]*$/.exec(part.trim())?.[1];
  const padded = new Set(rules.filter(({ body }) => declares(body)).flatMap(({ selector }) => selector.split(",").map(subject)));
  const bare: string[] = [];
  for (const { file, selector, body } of rules) {
    if (!/place-items:\s*center/.test(body) || !/(?<![-\w])width:/.test(body) || declares(body)) continue;
    const parts = selector.split(",");
    const button = parts.some((part) => /(?:^|[\s>])button(?:[\s:[.]|$)/.test(part.trim()))
      || parts.some((part) => { const name = subject(part); return name !== undefined && onButtons.has(name) && !padded.has(name); });
    if (button) bare.push(`${path.relative(process.cwd(), file)} ${selector}`);
  }
  assert.deepEqual(bare, [], `Icon buttons without their own padding push their icons off centre:\n${bare.join("\n")}`);
});
