import { emptyScan, scanBlocks, type BlockScan } from "../../domain/markdown-stream.js";

export type MarkdownBuffer = {
  /** Text the stream has produced but not released yet. */
  text: string;
  scan: BlockScan;
};

export function openMarkdownBuffer(): MarkdownBuffer {
  return { text: "", scan: emptyScan() };
}

/** Releases whole Markdown blocks and keeps the rest buffered, so a half-written fence never ships. */
export function appendCompleteMarkdown(buffer: MarkdownBuffer, text: string) {
  buffer.text += text;
  const scan = scanBlocks(buffer.text, buffer.scan);
  buffer.scan = scan;
  if (!scan.safeEnd) return "";
  const complete = buffer.text.slice(0, scan.safeEnd);
  buffer.text = buffer.text.slice(scan.safeEnd);
  buffer.scan = { safeEnd: 0, scanned: scan.scanned - scan.safeEnd, ...(scan.fence ? { fence: scan.fence } : {}) };
  return complete;
}
