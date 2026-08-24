import { useEffect, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

/** How far past the drawn rows the colouring runs, so an ordinary scroll arrives on coloured lines. */
const MARGIN = 24;

/**
 * How long one pass may hold the window. A hunk cannot be coloured by halves, so the pass stops at
 * the first one that runs past this and leaves the rest to the pass after it.
 */
const SLICE = 12;

/**
 * Colours the rows on screen, and a run past each edge, a slice at a time. Colouring a whole review
 * costs seconds of a held window, so it follows what is drawn rather than what has arrived: each pass
 * draws what it coloured, and the pass that follows takes the next slice. Every render asks again,
 * which is what carries the colour along with a scroll.
 */
export function useLazyColours(count: number, window: Virtualizer<HTMLDivElement, Element> | null, colour: (index: number) => boolean) {
  const [, painted] = useState(0);
  useEffect(() => {
    /** A windowed list names the rows it drew; a short one is laid out whole, so all of it is drawn. */
    const items = window?.getVirtualItems();
    const first = items ? items[0]?.index : 0;
    const last = items ? items[items.length - 1]?.index : count - 1;
    if (first === undefined || last === undefined) return;
    const until = performance.now() + SLICE;
    let drew = false;
    for (let index = Math.max(0, first - MARGIN); index <= Math.min(count - 1, last + MARGIN); index += 1) {
      if (colour(index)) drew = true;
      if (drew && performance.now() > until) break;
    }
    if (drew) painted((pass) => pass + 1);
  });
}
