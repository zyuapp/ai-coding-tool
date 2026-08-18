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
