export type ColumnAlign = "left" | "right" | "center" | null;

const WIDE = /\p{Extended_Pictographic}|[ᄀ-ᅟ⺀-〾ぁ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/u;
const ZERO = /^\p{Mn}|^\p{Me}|^\p{Cf}/u;
const graphemes = new Intl.Segmenter();

/** Columns a string fills in a monospace font: wide East Asian text and emoji take two. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (ZERO.test(segment)) continue;
    width += WIDE.test(segment) ? 2 : 1;
  }
  return width;
}

function pad(text: string, width: number, align: ColumnAlign) {
  const room = width - displayWidth(text);
  if (align === "right") return " ".repeat(room) + text;
  if (align === "center") {
    const left = Math.floor(room / 2);
    return " ".repeat(left) + text + " ".repeat(room - left);
  }
  return text + " ".repeat(room);
}

function rule(width: number, align: ColumnAlign) {
  if (align === "center") return `:${"-".repeat(Math.max(width - 2, 1))}:`;
  if (align === "left") return `:${"-".repeat(Math.max(width - 1, 2))}`;
  if (align === "right") return `${"-".repeat(Math.max(width - 1, 2))}:`;
  return "-".repeat(width);
}

/**
 * Lays out a GFM table with every column padded to one width, so it lines up in a monospace font
 * and stays valid Markdown. The first row is the header. Short rows are filled with empty cells.
 */
export function formatTable(rows: readonly (readonly string[])[], align: readonly ColumnAlign[]): string {
  const count = Math.max(align.length, ...rows.map((row) => row.length));
  if (rows.length === 0 || count === 0) return "";
  const cells = rows.map((row) => Array.from({ length: count }, (_, column) => (row[column] ?? "").replace(/\s+/g, " ").trim()));
  const widths = Array.from({ length: count }, (_, column) => Math.max(3, ...cells.map((row) => displayWidth(row[column]))));
  const line = (parts: string[]) => `| ${parts.join(" | ")} |`;
  const body = cells.map((row) => line(row.map((cell, column) => pad(cell, widths[column], align[column] ?? null))));
  return [body[0], line(widths.map((width, column) => rule(width, align[column] ?? null))), ...body.slice(1)].join("\n");
}
