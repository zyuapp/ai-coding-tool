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
 * which is what carries the colour along with a scroll. Returns how many times each file has been
 * painted, which is what tells its rows already on screen that the tokens under them have changed.
 */
export function useLazyColours(count: number, window: Virtualizer<HTMLDivElement, Element> | null, colour: (index: number) => string | undefined) {
  const [paints, setPaints] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    /** A windowed list names the rows it drew; a short one is laid out whole, so all of it is drawn. */
    const items = window?.getVirtualItems();
    const first = items ? items[0]?.index : 0;
    const last = items ? items[items.length - 1]?.index : count - 1;
    if (first === undefined || last === undefined) return;
    const until = performance.now() + SLICE;
    const painted = new Set<string>();
    for (let index = Math.max(0, first - MARGIN); index <= Math.min(count - 1, last + MARGIN); index += 1) {
      const path = colour(index);
      if (path !== undefined) painted.add(path);
      if (painted.size > 0 && performance.now() > until) break;
    }
    if (painted.size === 0) return;
    setPaints((counts) => {
      const next = new Map(counts);
      for (const path of painted) next.set(path, (counts.get(path) ?? 0) + 1);
      return next;
    });
  });
  return paints;
}
