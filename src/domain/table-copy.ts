import { markdownTable } from "markdown-table";

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

/**
 * A table's shown text as compact Markdown, which reads cleanly in any font, and as a grid padded to
 * line up in a monospace font. The first row is the header.
 */
export function tableCopy(rows: readonly (readonly string[])[], align: readonly ColumnAlign[]): { markdown: string; grid: string } {
  if (rows.length === 0) return { markdown: "", grid: "" };
  const cells = rows.map((row) => row.map((cell) => cell.replace(/\s+/g, " ").trim()));
  const escaped = cells.map((row) => row.map((cell) => cell.replace(/\|/g, "\\|")));
  const [head, rule, ...body] = markdownTable(escaped, { align: [...align], alignDelimiters: false }).split("\n");
  return {
    markdown: [head, rule.replace(/-+/g, "---"), ...body].join("\n"),
    grid: markdownTable(cells, { align: [...align], stringLength: displayWidth }),
  };
}
