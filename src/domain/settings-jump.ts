/** The settings half of the jump panel: the pages and controls a query names, best match first. */
import { MATCH_RANKS, matchRank } from "./match-rank.js";
import { SETTINGS_JUMP_OPTIONS, type SettingsJumpOption } from "./settings-catalog.js";
import { startsTitleWord } from "./thread-handles.js";

/** How many settings rows the panel draws, which leaves the rest of it to threads. */
export const SETTINGS_JUMP_ROWS = 5;

/** A name beats a keyword, so "font" offers the font controls before anything merely tagged with it. */
const RANKS = MATCH_RANKS + 1;

function rankOf(option: SettingsJumpOption, wanted: string): number | null {
  const named = matchRank(option.title, wanted);
  if (named !== null) return named;
  return startsTitleWord(option.keywords, wanted) ? MATCH_RANKS : null;
}

/**
 * The settings a query names. An empty query offers none, because the panel opens on the threads the
 * user was last in rather than on a list of every page.
 */
export function rankSettingsJumps(query: string, rows = SETTINGS_JUMP_ROWS): SettingsJumpOption[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  const ranked: SettingsJumpOption[][] = Array.from({ length: RANKS }, () => []);
  for (const option of SETTINGS_JUMP_OPTIONS) {
    const rank = rankOf(option, wanted);
    if (rank !== null) ranked[rank]!.push(option);
  }
  return ranked.flat().slice(0, Math.max(0, rows));
}
