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
