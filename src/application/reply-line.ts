/** A reply read as one line of plain words, as a notice or a thread's card shows what it said. */

/** A line that only fences code or rules a section off, which says nothing. */
const BARE = /^(?:`{3,}|~{3,}|(?:[-*_]\s*){3,}$)/;

/** What opens a markdown line rather than saying something: quote marks, then a heading's, a list item's or a task's. */
const OPENING = /^(?:>\s?)*(?:#{1,6}\s+|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?/;

/** Inline markdown: a code span, a link or image, emphasis or strikethrough, and underscore emphasis that is not part of a word. */
const INLINE = /(`+)(.+?)\1|!?\[([^\]]*)\]\([^)]*\)|(\*\*|\*|~~)(?=\S)(.+?)(?<=\S)\4|(?<!\w)(__|_)(?=\S)(.+?)(?<=\S)\6(?!\w)/g;

/** The first line of a reply that says something, read as plain words and clipped to `max`, or nothing when no line does. */
export function replyLine(reply: string, max: number): string | undefined {
  for (let start = 0; start < reply.length; ) {
    const end = reply.indexOf("\n", start);
    const line = plainLine(reply.slice(start, end === -1 ? reply.length : end));
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
    if (end === -1) break;
    start = end + 1;
  }
  return undefined;
}

/** A markdown line as the words it reads as, or nothing when it only shapes the reply. */
function plainLine(line: string): string {
  const trimmed = line.trim();
  if (BARE.test(trimmed)) return "";
  return inlineText(trimmed.replace(OPENING, "")).trim();
}

/** Text with its inline markdown read as words: a code span keeps what it says as written, the rest keep their words. */
function inlineText(text: string): string {
  return text.replace(INLINE, (...[, , code, link, , marked, , underlined]: (string | undefined)[]) =>
    code ?? inlineText(link ?? marked ?? underlined ?? ""));
}
