/** How far a Markdown stream can be cut without splitting a block, plus the reader's position. */
export type BlockScan = {
  /** Index just past the last complete block. Never moves backwards. */
  safeEnd: number;
  /** How much of the text the scan has already read. */
  scanned: number;
  fence?: { marker: string; length: number };
};

const blockMarker = /^(?:\s*>\s*)*\s*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}|~{3,})([\s\S]*)$/;

export function emptyScan(): BlockScan {
  return { safeEnd: 0, scanned: 0 };
}

/**
 * Reads the lines added since the last scan. A block ends at a blank line outside a fence or at the
 * line that closes one, so a cut at `safeEnd` never lands inside a fence, list, or emphasis run.
 */
export function scanBlocks(text: string, previous: BlockScan): BlockScan {
  let { safeEnd, fence } = previous;
  let lineStart = previous.scanned;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) break;
    const line = text.slice(lineStart, newline);
    const marker = line.match(blockMarker);
    if (!fence && marker) {
      fence = { marker: marker[1]![0]!, length: marker[1]!.length };
    } else if (fence && marker && marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && !marker[2]!.trim()) {
      fence = undefined;
      safeEnd = newline + 1;
    } else if (!fence && line.trim() === "") {
      safeEnd = newline + 1;
    }
    lineStart = newline + 1;
  }
  return { safeEnd, scanned: lineStart, ...(fence ? { fence } : {}) };
}

/** CommonMark's punctuation class, which decides whether a delimiter run can open or close. */
const PUNCTUATION = /[!-/:-@[-`{-~]/;
/** A line that carries markers but no content yet: `##`, `-`, `>`, `|`, a fence, a rule in progress. */
const MARKERS_ONLY = /^[\s>#*+\-_=~`|.:0-9]*$/;
/** A GFM table is literal pipes until its delimiter row lands, so the rows above it are held back. */
const TABLE_ROW = /^\s*\|/;
const TABLE_DELIMITER = /^[|\s:-]*-[|\s:-]*$/;

function closingRun(text: string, from: number, char: string, length: number) {
  for (let index = text.indexOf(char, from); index !== -1; index = text.indexOf(char, index + 1)) {
    let run = 0;
    while (text[index + run] === char) run += 1;
    if (run === length) return index;
    index += run - 1;
  }
  return -1;
}

/** Whether a delimiter run leans against the text before or after it, which is what lets it pair. */
function flanks(text: string, start: number, end: number, char: string) {
  const before = start > 0 ? text[start - 1]! : " ";
  const after = end < text.length ? text[end]! : " ";
  const left = !/\s/.test(after) && (!PUNCTUATION.test(after) || /\s/.test(before) || PUNCTUATION.test(before));
  const right = !/\s/.test(before) && (!PUNCTUATION.test(before) || /\s/.test(after) || PUNCTUATION.test(after));
  if (char !== "_") return { canOpen: left, canClose: right };
  return { canOpen: left && (!right || PUNCTUATION.test(before)), canClose: right && (!left || PUNCTUATION.test(after)) };
}

/**
 * How much of `text` renders as finished Markdown. A stream can stop anywhere, and a cut inside a
 * code span, link, or emphasis run leaves its markers on screen as literal text, so the cut moves
 * back to before whatever is still being written.
 */
export function inlineSafeEnd(text: string): number {
  const open: { char: string; at: number }[] = [];
  const earliest = () => (open[0]?.at ?? text.length);
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\\") {
      index += 2;
    } else if (char === "`") {
      const start = index;
      while (text[index] === "`") index += 1;
      const close = closingRun(text, index, "`", index - start);
      if (close === -1) return Math.min(start, earliest());
      index = close + (index - start);
    } else if (char === "<") {
      const close = text.indexOf(">", index);
      if (close === -1) return Math.min(index, earliest());
      index = close + 1;
    } else if (char === "[" || (char === "!" && text[index + 1] === "[")) {
      const start = index;
      const label = text.indexOf("]", start + 1);
      if (label === -1) return Math.min(start, earliest());
      if (text[label + 1] === "(" && text.indexOf(")", label + 1) === -1) return Math.min(start, earliest());
      index = label + 1;
    } else if (char === "*" || char === "_" || char === "~") {
      const start = index;
      while (text[index] === char) index += 1;
      /** A run at the cut has nothing after it yet, so it closes what is open and otherwise opens. */
      const { canOpen, canClose } = index >= text.length
        ? { canOpen: true, canClose: start > 0 && !/\s/.test(text[start - 1]!) }
        : flanks(text, start, index, char);
      if (canClose && open.at(-1)?.char === char) open.pop();
      else if (canOpen) open.push({ char, at: start });
    } else {
      index += 1;
    }
  }
  return earliest();
}

/**
 * Makes a cut in a Markdown stream render as finished text. An open fence is closed, a table with no
 * delimiter row yet and a line that is still only markers are held back, and the cut moves back off
 * any half-written inline markup. Text is only ever withheld, never altered.
 */
export function repairCut(text: string): string {
  const cut = text.lastIndexOf("\n") + 1;
  const complete = text.slice(0, cut);
  const scan = scanBlocks(complete, emptyScan());
  if (scan.fence) {
    const close = scan.fence.marker.repeat(scan.fence.length);
    return `${text}${text.endsWith("\n") ? "" : "\n"}${close}\n`;
  }
  const partial = text.slice(cut);
  const held = MARKERS_ONLY.test(partial) || blockMarker.test(partial) ? "" : partial;
  const lines = complete.split("\n").slice(0, -1);
  let rows = lines.length;
  while (rows > 0 && TABLE_ROW.test(lines[rows - 1]!)) rows -= 1;
  const established = lines.slice(rows).some((line) => TABLE_DELIMITER.test(line));
  const above = established ? complete : lines.slice(0, rows).map((line) => `${line}\n`).join("");
  const body = above + (TABLE_ROW.test(held) && !established ? "" : held);
  return body.slice(0, inlineSafeEnd(body));
}
