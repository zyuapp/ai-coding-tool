/** How well a name answers a query, shared by every list a search narrows. */
import { startsTitleWord } from "./thread-handles.js";

/** How many ranks a match can take: the name starts with the query, a word starts with it, or it is in there. */
export const MATCH_RANKS = 3;

/** The rank a name takes for a lower-cased query, or null when the query is not in it at all. */
export function matchRank(name: string, wanted: string): number | null {
  const lower = name.toLowerCase();
  if (lower.startsWith(wanted)) return 0;
  if (startsTitleWord(name, wanted)) return 1;
  return lower.includes(wanted) ? 2 : null;
}

/**
 * The items any of whose names answer a query, best rank first and in their own order within a rank.
 * A blank query keeps every item where it was.
 */
export function rankedMatches<Item>(items: readonly Item[], query: string, names: (item: Item) => ReadonlyArray<string | undefined>): Item[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...items];
  const ranks: Item[][] = Array.from({ length: MATCH_RANKS }, () => []);
  for (const item of items) {
    let best: number | null = null;
    for (const name of names(item)) {
      const rank = name === undefined ? null : matchRank(name, wanted);
      if (rank !== null && (best === null || rank < best)) best = rank;
    }
    if (best !== null) ranks[best]!.push(item);
  }
  return ranks.flat();
}
