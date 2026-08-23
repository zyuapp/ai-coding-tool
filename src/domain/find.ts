/**
 * Find, as data. The transcript is virtualized and most of a thread is folded away, so the window's
 * own find would only ever see the handful of rows on screen. Matching happens over the messages
 * themselves instead, and the view is told which one to reveal.
 *
 * A page and a shell hold their own text, so they count their own matches: the target says who does.
 */
import type { TaskMessage } from "./task.js";

export type FindTarget =
  | { kind: "transcript" }
  | { kind: "browser"; tabId: string }
  | { kind: "terminal"; terminalId: string };

/** Where a match is. `occurrence` counts matches within the same message, in the order it draws them. */
export type FindHit = {
  messageId: string;
  field: "text" | "detail";
  start: number;
  occurrence: number;
};

/** What the find bar shows, and what a page or a shell reports back after searching itself. */
export type FindResults = { matches: number; index: number };

/** More matches than anyone steps through one at a time, and still bounded on a long thread. */
export const MAX_FIND_HITS = 500;

export function sameFindTarget(one: FindTarget, other: FindTarget): boolean {
  if (one.kind !== other.kind) return false;
  if (one.kind === "browser" && other.kind === "browser") return one.tabId === other.tabId;
  if (one.kind === "terminal" && other.kind === "terminal") return one.terminalId === other.terminalId;
  return true;
}

/** Every match in a message's own text, which is the order the timeline draws it in. */
function hitsInMessage(message: TaskMessage, needle: string, limit: number): FindHit[] {
  const hits: FindHit[] = [];
  for (const field of ["text", "detail"] as const) {
    const haystack = (field === "text" ? message.text : message.detail)?.toLowerCase();
    if (!haystack) continue;
    for (let start = haystack.indexOf(needle); start !== -1; start = haystack.indexOf(needle, start + needle.length)) {
      hits.push({ messageId: message.id, field, start, occurrence: hits.length });
      if (hits.length === limit) return hits;
    }
  }
  return hits;
}

/** Every match in a thread, oldest first, capped so a query like "e" cannot cost the whole transcript. */
export function findHits(messages: TaskMessage[], query: string): FindHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: FindHit[] = [];
  for (const message of messages) {
    hits.push(...hitsInMessage(message, needle, MAX_FIND_HITS - hits.length));
    if (hits.length === MAX_FIND_HITS) return hits;
  }
  return hits;
}

const hitCache = new WeakMap<TaskMessage[], { query: string; hits: FindHit[] }>();

/** Reuses a transcript search while its immutable message list and normalized query are unchanged. */
export function memoizedFindHits(messages: TaskMessage[], query: string): FindHit[] {
  const needle = query.trim().toLowerCase();
  const cached = hitCache.get(messages);
  if (cached?.query === needle) return cached.hits;
  const hits = findHits(messages, needle);
  hitCache.set(messages, { query: needle, hits });
  return hits;
}

/** The match `delta` away, wrapping at both ends the way every other find does. */
export function stepMatch(index: number, delta: -1 | 1, matches: number): number {
  if (matches <= 0) return 0;
  return ((index + delta) % matches + matches) % matches;
}
