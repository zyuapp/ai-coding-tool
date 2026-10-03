/**
 * The jump panel's list: every thread the user can search by name or pull request, and the order a
 * query puts them in. Never message text, so a keystroke stays cheap however long the list grows.
 */
import { MATCH_RANKS, matchRank } from "./match-rank.js";
import { linksPullRequest, pullRequestQuery, type PullRequestLink } from "./pull-request.js";
import type { AgentEngine } from "./agent-engine.js";

/** A thread the panel offers, and what its row shows beside the name. */
export type ThreadJumpOption = {
  id: string;
  title: string;
  /** The folder the thread lives in, which tells two threads of the same name apart. */
  project: string | null;
  engine: AgentEngine;
  pullRequest: PullRequestLink | null;
  lastActivityAt: number;
};

/** How many rows the panel draws, which is also how far a query has to read. */
export const THREAD_JUMP_ROWS = 12;

/**
 * The threads a query names, best match first and newest first within a match. A query that names a
 * pull request puts the threads working on it above any name. `options` arrives newest first, so the
 * scan stops as soon as the best rank alone fills the panel.
 */
export function rankThreadJumps(options: ThreadJumpOption[], query: string, rows = THREAD_JUMP_ROWS): ThreadJumpOption[] {
  const kept = Math.max(0, rows);
  const wanted = query.trim().toLowerCase();
  if (!wanted) return options.slice(0, kept);
  const pullRequest = pullRequestQuery(wanted);
  const best = pullRequest ? 0 : 1;
  const ranked: ThreadJumpOption[][] = Array.from({ length: MATCH_RANKS + 1 }, () => []);
  for (const option of options) {
    if (pullRequest && option.pullRequest && linksPullRequest(option.pullRequest, pullRequest)) ranked[0]!.push(option);
    else {
      const rank = matchRank(option.title, wanted);
      if (rank === null) continue;
      ranked[rank + 1]!.push(option);
    }
    if (ranked[best]!.length >= kept) break;
  }
  return ranked.flat().slice(0, kept);
}
