/**
 * The jump panel's list: every thread the user can search by name, and the order a query puts them
 * in. Names only, never message text, so a keystroke stays cheap however long the list grows.
 */
import { startsTitleWord } from "./thread-handles.js";
import type { AgentEngine } from "./agent-engine.js";

/** A thread the panel offers, and what its row shows beside the name. */
export type ThreadJumpOption = {
  id: string;
  title: string;
  /** The folder the thread lives in, which tells two threads of the same name apart. */
  project: string | null;
  engine: AgentEngine;
  lastActivityAt: number;
};

/** How many rows the panel draws, which is also how far a query has to read. */
export const THREAD_JUMP_ROWS = 12;

/** How well a name answers a query: the name starts with it, a word starts with it, or it is in there. */
const RANKS = 3;

function rankOf(title: string, wanted: string): number | null {
  const lower = title.toLowerCase();
  if (lower.startsWith(wanted)) return 0;
  if (startsTitleWord(title, wanted)) return 1;
  return lower.includes(wanted) ? 2 : null;
}

/**
 * The threads a query names, best match first and newest first within a match. `options` arrives
 * newest first, so the scan stops as soon as the best rank alone fills the panel.
 */
export function rankThreadJumps(options: ThreadJumpOption[], query: string, rows = THREAD_JUMP_ROWS): ThreadJumpOption[] {
  const kept = Math.max(0, rows);
  const wanted = query.trim().toLowerCase();
  if (!wanted) return options.slice(0, kept);
  const ranked: ThreadJumpOption[][] = Array.from({ length: RANKS }, () => []);
  for (const option of options) {
    const rank = rankOf(option.title, wanted);
    if (rank === null) continue;
    ranked[rank]!.push(option);
    if (ranked[0]!.length >= kept) break;
  }
  return ranked.flat().slice(0, kept);
}
