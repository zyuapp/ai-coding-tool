import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Writes the desktop's theme primitives as the iOS app's palette resource. Only colours travel: each
 * theme's `--p-*` hex values, keyed without the prefix, and whether it is dark or light. `--check`
 * fails when the resource is stale.
 */
const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "src/renderer/themes.css");
const target = path.join(root, "ios/AICodingTool/Resources/Themes.json");

const SELECTOR_PART = /^(?::root|\[data-theme="([^"]+)"\])$/;
const DECLARATION = /--p-([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g;

export function themePalettes(css: string): Record<string, Record<string, string>> {
  const themes: Record<string, Record<string, string>> = {};
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const ids: string[] = [];
    let plain = true;
    for (const part of block[1]!.split(",").map((selector) => selector.trim()).filter(Boolean)) {
      const match = SELECTOR_PART.exec(part);
      if (!match) {
        plain = false;
        break;
      }
      if (match[1]) ids.push(match[1]);
    }
    if (!plain) continue;
    for (const id of ids) {
      const palette = (themes[id] ??= {});
      for (const declaration of block[2]!.matchAll(DECLARATION)) palette[declaration[1]!] = declaration[2]!.toLowerCase();
      const scheme = /color-scheme:\s*(dark|light)\s*;/.exec(block[2]!);
      if (scheme) palette["color-scheme"] = scheme[1]!;
    }
  }
  return Object.fromEntries(Object.entries(themes).sort(([left], [right]) => left.localeCompare(right)));
}

const written = `${JSON.stringify(themePalettes(readFileSync(source, "utf8")), null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // A missing resource is stale.
  }
  if (current !== written) {
    console.error("ios/AICodingTool/Resources/Themes.json is out of date. Run npm run generate:ios-themes.");
    process.exit(1);
  }
} else {
  writeFileSync(target, written);
}
