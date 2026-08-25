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
