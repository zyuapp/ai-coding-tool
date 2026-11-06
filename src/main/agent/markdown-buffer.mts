import { emptyScan, scanBlocks, type BlockScan } from "../../domain/markdown-stream.js";
import type { ProviderEvent } from "./agent-provider.mjs";

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

type Emits = { emit(event: ProviderEvent): void };

/** Streams a delta of one message: its whole blocks as they complete, and the rest as its tail. */
export function streamMarkdown(buffers: Map<string, MarkdownBuffer>, run: Emits, messageId: string, delta: string) {
  let buffer = buffers.get(messageId);
  if (!buffer) buffers.set(messageId, buffer = openMarkdownBuffer());
  const complete = appendCompleteMarkdown(buffer, delta);
  if (complete) run.emit({ type: "assistant", messageId, text: complete, append: true });
  run.emit({ type: "assistant-tail", messageId, text: buffer.text });
}

/** Ends one message. One that streamed is on screen but for its tail; one that did not arrives whole. */
export function endMarkdown(buffers: Map<string, MarkdownBuffer>, run: Emits, messageId: string, whole: string) {
  const buffer = buffers.get(messageId);
  if (buffer) {
    buffers.delete(messageId);
    if (buffer.text) run.emit({ type: "assistant", messageId, text: buffer.text, append: true });
  } else if (whole.trim()) {
    run.emit({ type: "assistant", messageId, text: whole });
  }
}
