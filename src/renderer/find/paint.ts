/**
 * What a search lights up on screen. Several views search at once — a thread, a review, a panel —
 * and they all draw into the one highlight registry the window has, so the registry has an owner
 * rather than a free-for-all: the view that lit it last is the only one allowed to clear it.
 */
import { highlights } from "../timeline/highlights";

const MATCH_HIGHLIGHT = "find-match";
const ACTIVE_HIGHLIGHT = "find-active";

/**
 * One match on screen. `owner` is the value of the marking attribute on the element holding it, and
 * `occurrence` counts matches within that owner — within the root when there is no marking.
 */
export type DrawnMatch = { range: Range; owner: string | null; occurrence: number };

/**
 * Every match drawn under `root`, in the order the text is read. `owns` names the attribute that
 * marks the elements whose text is searched at all, so what is lit is only ever what was counted:
 * gutters, line numbers and chrome are never painted. An empty `owns` walks the whole root.
 *
 * A match is only ever found inside one text node, so a needle that straddles two — the folder and
 * the name of a path, two coloured tokens of a line — is counted from the data and drawn unlit.
 */
export function drawnMatches(root: Element | null, needle: string, owns: string, limit: number): DrawnMatch[] {
  if (!root || !needle || limit <= 0) return [];
  const found: DrawnMatch[] = [];
  const seen = new Map<string, number>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue?.toLowerCase();
    if (!text) continue;
    const owner = owns ? node.parentElement?.closest(`[${owns}]`)?.getAttribute(owns) ?? null : null;
    if (owns && owner === null) continue;
    const key = owner ?? "";
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      found.push({ range, owner, occurrence });
      if (found.length === limit) return found;
    }
  }
  return found;
}

/** Who lit the registry last, so a view redrawing behind a search cannot wipe what the search lit. */
let painter: string | null = null;

/**
 * Lights what a view found and the one it is showing. Painting nothing releases the registry, and a
 * view that does not hold it painting nothing is a view that has already been painted over.
 */
export function paintMatches(by: string, found: Range[], active: Range | null): void {
  const registry = highlights();
  if (!registry) return;
  if (found.length === 0 && painter !== by) return;
  registry.delete(MATCH_HIGHLIGHT);
  registry.delete(ACTIVE_HIGHLIGHT);
  if (found.length === 0) {
    painter = null;
    return;
  }
  painter = by;
  registry.set(MATCH_HIGHLIGHT, new Highlight(...found));
  if (active) registry.set(ACTIVE_HIGHLIGHT, new Highlight(active));
}
