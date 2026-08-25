import type { FindHit } from "../../domain/find";

const MATCH_HIGHLIGHT = "find-match";
const ACTIVE_HIGHLIGHT = "find-active";
export const ANNOTATION_HIGHLIGHT = "annotation-mark";

/** Where a point in a message sits, counted in characters of the text nodes before it. */
export function renderedOffset(root: Element, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}

/** The range those counted characters name today, or nothing while the message is off screen. */
export function renderedRange(root: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let at = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.nodeValue?.length ?? 0;
    if (!started && at + length >= start) {
      range.setStart(node, start - at);
      started = true;
    }
    if (started && at + length >= end) {
      range.setEnd(node, end - at);
      return range;
    }
    at += length;
  }
  return null;
}

export function highlights(): HighlightRegistry | null {
  return typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;
}

/**
 * Draws every match the rows on screen hold, and the one being read among them. The ranges are the
 * rendered text's, so markdown is highlighted where it is read rather than where it was written.
 */
export function paintMatches(root: HTMLElement | null, query: string, hit: FindHit | null) {
  const registry = highlights();
  if (!registry) return;
  registry.delete(MATCH_HIGHLIGHT);
  registry.delete(ACTIVE_HIGHLIGHT);
  const needle = query.trim().toLowerCase();
  if (!root || !needle) return;
  const found: Range[] = [];
  const seen = new Map<string, number>();
  let active: Range | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue?.toLowerCase();
    if (!text) continue;
    const owner = node.parentElement?.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null;
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      found.push(range);
      if (!owner) continue;
      const occurrence = seen.get(owner) ?? 0;
      seen.set(owner, occurrence + 1);
      if (hit && owner === hit.messageId && occurrence === hit.occurrence) active = range;
    }
  }
  if (found.length) registry.set(MATCH_HIGHLIGHT, new Highlight(...found));
  if (active) registry.set(ACTIVE_HIGHLIGHT, new Highlight(active));
}
