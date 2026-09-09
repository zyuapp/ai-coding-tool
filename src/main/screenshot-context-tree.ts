import type { ScreenshotPlatform } from "../domain/screenshot-context.js";

export type ScreenshotTreeRow = { text: string; depth: number; role: string; index?: number };

/** Only native role prefixes introduce nodes; paragraphs and list items can span physical lines. */
export function screenshotTree(markdown: string, platform: ScreenshotPlatform) {
  const rows: ScreenshotTreeRow[] = [];
  let truncated = false;
  for (const line of markdown.split("\n")) {
    if (/^⚠.*\b(?:AX tree|accessibility tree) truncated at \d+ nodes\b/i.test(line.trimStart())) { truncated = true; break; }
    const match = platform === "macos"
      ? /^(\s*)- (?:\[(?:element_index )?(\d+)\] )?(AX[A-Za-z0-9]+)(?=\s|$)/.exec(line)
      : /^(\s*)- (?:\[(\d+)\] ([a-z][a-z\d -]*?) "|([a-z][a-z\d -]*?) = ")/.exec(line);
    if (match) rows.push({ text: line, depth: match[1].length, role: match[3] ?? match[4], ...(match[2] === undefined ? {} : { index: Number(match[2]) }) });
    else if (rows.length && line.trim()) rows[rows.length - 1].text += `\\n${line.trim()}`;
  }
  return { rows, truncated };
}

export function isDocumentRole(role: string): boolean {
  return /^(?:AXWebArea|AXDocument|AXDocumentWeb|document(?: web| frame| text)?)$/.test(role);
}

export function isProtectedRole(role: string): boolean {
  return /^(?:AXSecureTextField|password(?: text| field)?)$/i.test(role);
}
