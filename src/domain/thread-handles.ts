/** How a thread is named inside a draft, and what that name expands to when the draft is sent. */

const HANDLE_TOKEN = /(?:^|\s)@([^\s@]*)$/;
const SLUG_WORDS = 4;
const SLUG_CHARS = 40;

/** A thread the `@` menu offers, and that a handle in a draft resolves back to. */
export type ThreadHandleOption = {
  id: string;
  title: string;
  /** What the draft carries: `slug`, or `project/slug` for a thread outside the current project. */
  handle: string;
  /** The project's folder name, shown on rows from elsewhere. Null for a thread without a project. */
  project: string | null;
  /** Whether the thread belongs to the project the draft is being written in. */
  inScope: boolean;
  running: boolean;
  lastActivityAt: number;
};

export function threadSlug(text: string): string {
  /** Apostrophes close rather than separate, so "dock's" stays one word instead of trailing an "s". */
  const words = text.toLowerCase().replace(/['\u2019]/g, "").replace(/[^a-z\d]+/g, " ").trim().split(" ").filter(Boolean).slice(0, SLUG_WORDS);
  return words.join("-").slice(0, SLUG_CHARS).replace(/-+$/, "") || "thread";
}

/** The `@word` the caret sits in. A `@` only starts one after whitespace, which keeps emails out. */
export function handleTokenAt(text: string, caret: number) {
  const query = text.slice(0, caret).match(HANDLE_TOKEN)?.[1];
  return query === undefined ? null : { query: query.toLowerCase(), start: caret - query.length - 1 };
}

/**
 * Handles for a set of threads, newest activity first. A thread outside the current project is
 * qualified by project, and a slug two threads share is broken by the older one's id.
 */
export function threadHandles(threads: Omit<ThreadHandleOption, "handle">[]): ThreadHandleOption[] {
  const taken = new Set<string>();
  return [...threads].sort((left, right) => right.lastActivityAt - left.lastActivityAt).map((thread) => {
    const slug = threadSlug(thread.title);
    const qualified = thread.inScope || !thread.project ? slug : `${threadSlug(thread.project)}/${slug}`;
    const handle = taken.has(qualified) ? `${qualified}-${thread.id.replace(/[^a-z\d]/gi, "").slice(-4).toLowerCase()}` : qualified;
    taken.add(handle);
    return { ...thread, handle };
  });
}

/** Matches on the handle and on each word of the title, so `@mode` finds "Sink the mode choices". */
export function threadHandleMatches(option: ThreadHandleOption, query: string): boolean {
  if (query === "") return true;
  const wanted = query.toLowerCase();
  return option.handle.includes(wanted)
    || option.title.toLowerCase().split(/[^a-z\d]+/).some((word) => word.startsWith(wanted));
}

/** In-project threads first, then the rest, each group newest first. */
export function rankThreadHandles(options: ThreadHandleOption[], query: string): ThreadHandleOption[] {
  const matching = options.filter((option) => threadHandleMatches(option, query));
  /** An empty query is browsing rather than searching, so it never leaves the current project. */
  const scoped = query === "" ? matching.filter((option) => option.inScope) : matching;
  return [...scoped.filter((option) => option.inScope), ...scoped.filter((option) => !option.inScope)];
}

/** The link a thread reads as once it leaves the composer, which the transcript renders clickable. */
export function threadReference(option: { id: string; title: string }): string {
  return `[${option.title.replace(/[[\]]/g, "")}](claudex://thread/${option.id})`;
}

/**
 * A thread named without a title to read as. The angle brackets are what make it a link rather than
 * grey text, since GFM autolinks no scheme of its own.
 */
export function threadLink(threadId: string): string {
  return `<claudex://thread/${threadId}>`;
}

/** Turns every handle that names a thread into a link. One that names nothing is left as typed. */
export function expandThreadHandles(text: string, options: ThreadHandleOption[]): string {
  if (!text.includes("@")) return text;
  const byHandle = new Map(options.map((option) => [option.handle, option]));
  return text.replace(/(^|\s)@([^\s@]+)/g, (whole, lead: string, token: string) => {
    /** A handle at the end of a sentence keeps the punctuation that follows it. */
    const trailing = token.match(/[.,;:!?)\]]+$/)?.[0] ?? "";
    const option = byHandle.get(token.slice(0, token.length - trailing.length).toLowerCase());
    return option ? `${lead}${threadReference(option)}${trailing}` : whole;
  });
}
