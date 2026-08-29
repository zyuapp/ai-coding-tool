/**
 * Find, as data. The transcript is virtualized and most of a thread is folded away, so the window's
 * own find would only ever see the handful of rows on screen. Matching happens over the messages
 * themselves instead, and the view is told which one to reveal.
 *
 * A page and a shell hold their own text, so they count their own matches: the target says who does.
 */
import type { DiffFile } from "./diff.js";
import type { ConversationMessage } from "./conversation.js";

/**
 * Where a search is pointed. A thread names the task whose messages are searched, so a side chat is
 * searched by the same path the main thread is, and a null id is the draft, which has nothing yet.
 * A page and a shell hold their own text and keep their own place in it; the review and a panel
 * count their own matches and report them the same way, but the reducer holds their place.
 */
export type FindTarget =
  | { kind: "thread"; taskId: string | null }
  | { kind: "browser"; tabId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "review"; owner: string }
  | { kind: "panel"; owner: string; panel: string };

/** Every field of a target flattened, so two are the same when they name the same view. */
export function targetKey(target: FindTarget): string {
  switch (target.kind) {
    case "thread": return `thread:${target.taskId ?? ""}`;
    case "browser": return `browser:${target.tabId}`;
    case "terminal": return `terminal:${target.terminalId}`;
    case "review": return `review:${target.owner}`;
    case "panel": return `panel:${target.owner}:${target.panel}`;
  }
}

/** Whether the view holds its own text: it is asked to search, and it keeps its own place in what it found. */
export function searchesItself(target: FindTarget): boolean {
  return target.kind === "browser" || target.kind === "terminal";
}

/** Where a match is. `occurrence` counts matches within the same message, in the order it draws them. */
export type FindHit = {
  messageId: string;
  field: "text" | "detail";
  start: number;
  occurrence: number;
};

/** What the find bar shows, and what a view that counts itself reports back. */
export type FindResults = {
  matches: number;
  /** Where the view is in what it found, from the only views that move through it themselves. */
  index?: number;
  /** More to read before the total is final, so the bar says so rather than "No matches". */
  counting?: boolean;
};

/** More matches than anyone steps through one at a time, and still bounded on a long thread. */
export const MAX_FIND_HITS = 500;

export function sameFindTarget(one: FindTarget, other: FindTarget): boolean {
  return targetKey(one) === targetKey(other);
}

/** Every match in a message's own text, which is the order the timeline draws it in. */
function hitsInMessage(message: ConversationMessage, needle: string, limit: number): FindHit[] {
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
export function findHits(messages: ConversationMessage[], query: string): FindHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: FindHit[] = [];
  for (const message of messages) {
    hits.push(...hitsInMessage(message, needle, MAX_FIND_HITS - hits.length));
    if (hits.length === MAX_FIND_HITS) return hits;
  }
  return hits;
}

const hitCache = new WeakMap<ConversationMessage[], { query: string; hits: FindHit[] }>();

/** Reuses a transcript search while its immutable message list and normalized query are unchanged. */
export function memoizedFindHits(messages: ConversationMessage[], query: string): FindHit[] {
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

/**
 * Where a match is in a review: the file, the row of its patch, and which match within that row. A
 * null key is a match in the file's own name, which the panel draws on its header row.
 */
export type ReviewHit = { path: string; key: string | null; occurrence: number };

export function sameReviewHit(one: ReviewHit, other: ReviewHit): boolean {
  return one.path === other.path && one.key === other.key && one.occurrence === other.occurrence;
}

/** Every match in one piece of text, numbered from zero the way that row draws them. */
function hitsInText(path: string, key: string | null, text: string, needle: string, room: number): ReviewHit[] {
  const hits: ReviewHit[] = [];
  const haystack = text.toLowerCase();
  for (let at = haystack.indexOf(needle); at !== -1 && hits.length < room; at = haystack.indexOf(needle, at + needle.length)) {
    hits.push({ path, key, occurrence: hits.length });
  }
  return hits;
}

/**
 * Every match in one file, in the order the review draws it: its name first, then its lines. A file
 * whose patch has not been read contributes its name alone. Hunk headers are chrome, not content.
 *
 * The needle arrives lowered and trimmed, because a search over a whole review normalizes once.
 */
export function fileReviewHits(path: string, file: DiffFile | null, needle: string, limit: number): ReviewHit[] {
  if (!needle || limit <= 0) return [];
  const hits = hitsInText(path, null, path, needle, limit);
  if (!file) return hits;
  for (const hunk of file.hunks) {
    for (const row of hunk.rows) {
      hits.push(...hitsInText(path, row.key, row.text, needle, limit - hits.length));
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** One file as a search sees it: its patch once that has arrived, and whether one is still on its way. */
export type ReviewFile = { path: string; version: string; file: DiffFile | null; coming: boolean };

/** What a review has found so far: its matches in drawn order, and whether patches are still arriving. */
export type ReviewCount = { hits: ReviewHit[]; counting: boolean };

/**
 * Every match in a review, in the order it is drawn: by file, then by that file's name and rows. A
 * file whose patch has not arrived counts for its name alone, so the total only ever grows as the
 * rest land, and a file that will never be read — binary, too large, failed — is skipped rather than
 * waited on. `scanned` holds each file's matches under the version they were read at, so a patch
 * landing late costs one file's scan rather than the whole review's.
 */
export function reviewHits(files: ReviewFile[], needle: string, scanned = new Map<string, ReviewHit[]>()): ReviewCount {
  const hits: ReviewHit[] = [];
  if (!needle) return { hits, counting: false };
  let counting = false;
  for (const entry of files) {
    if (hits.length >= MAX_FIND_HITS) break;
    if (!entry.file && entry.coming) counting = true;
    /** Scanned against the whole cap and sliced after, so what is held never depends on what came before it. */
    const key = `${entry.version}|${needle}`;
    let found = entry.file ? scanned.get(key) : undefined;
    if (!found) {
      found = fileReviewHits(entry.path, entry.file, needle, MAX_FIND_HITS);
      if (entry.file) scanned.set(key, found);
    }
    hits.push(...found.slice(0, MAX_FIND_HITS - hits.length));
  }
  return { hits, counting };
}
