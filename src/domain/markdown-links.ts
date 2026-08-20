/**
 * The links an agent's prose carries. Some it writes as Markdown; most it writes as bare prose, so
 * what is written plainly has to be recognised before it can be clicked.
 */

const THREAD_HREF = /^claudex:\/\/thread\/([^/?#]+)$/i;
const FILE_HREF = /^claudex:\/\/file\?(.*)$/i;
const THREAD_TEXT = /^claudex:\/\/thread\/[A-Za-z0-9._~-]+$/i;
const WEB_TEXT = /^https?:\/\/[^\s<>"']+$/i;

/** A trailing `:12` or `:12:5`. It names a line, which the desktop cannot be asked to open at. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
/** Everything a path may be made of. Anything else, and the word is prose that happens to hold a dot. */
const PATH_CHARACTERS = /^[\w./~@+-]+$/;
const ROOTED = /^(?:~\/|\.{1,2}\/|\/)/;

/**
 * What a bare word has to end in to read as a file. A rooted path needs no extension; anything else
 * does, or every `and/or` and `example.com` in the prose would turn into a broken link.
 */
const FILE_EXTENSIONS = new Set([
  "bash", "bat", "c", "cc", "cfg", "cjs", "conf", "cpp", "cs", "css", "csv", "diff", "env", "gif", "go", "gradle",
  "graphql", "h", "hpp", "hs", "htm", "html", "ini", "java", "jpeg", "jpg", "js", "json", "jsonc", "jsx", "kt",
  "less", "lock", "log", "lua", "md", "mdx", "mjs", "mts", "patch", "pdf", "php", "pl", "plist", "png", "prisma",
  "properties", "proto", "ps1", "py", "rb", "rs", "rst", "sass", "scala", "scss", "sh", "sql", "svg", "swift",
  "tf", "toml", "ts", "tsv", "tsx", "txt", "vue", "webp", "xml", "yaml", "yml", "zsh",
]);

export function parseThreadHref(href: string) {
  return THREAD_HREF.exec(href)?.[1] ?? null;
}

/** Relative paths are read against the thread's checkout, so the href carries the path as written. */
export function fileHref(path: string) {
  return `claudex://file?${new URLSearchParams({ path })}`;
}

export function parseFileHref(href: string) {
  const query = FILE_HREF.exec(href)?.[1];
  return query === undefined ? null : new URLSearchParams(query).get("path") || null;
}

/** Reads a word as a path, or refuses it. The word is whatever the prose wrote, trailing `:12` and all. */
export function parseFilePath(text: string) {
  const suffix = LINE_SUFFIX.exec(text);
  const path = suffix ? text.slice(0, suffix.index) : text;
  if (path.length < 2 || !PATH_CHARACTERS.test(path) || path.endsWith("/")) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!ROOTED.test(path) && !FILE_EXTENSIONS.has(extension)) return null;
  return path;
}

/** One thing in a run of prose that should be clickable, and where it sits in that prose. */
export type Linkable = { start: number; end: number; text: string; href: string };

/** Punctuation the prose wraps a reference in, which belongs to the sentence rather than the link. */
const LEADING = /^[([{<"'`*]+/;
const TRAILING = /[)\]}>"'`*.,;:!?]+$/;

export function linkableFor(word: string): string | null {
  if (THREAD_TEXT.test(word)) return word;
  if (WEB_TEXT.test(word)) return word;
  const path = parseFilePath(word);
  return path ? fileHref(path) : null;
}

/** Finds every reference written plainly in a run of prose, in the order the prose wrote them. */
export function scanLinkables(value: string): Linkable[] {
  const found: Linkable[] = [];
  for (const match of value.matchAll(/\S+/g)) {
    const start = match.index + (LEADING.exec(match[0])?.[0].length ?? 0);
    const word = value.slice(start, match.index + match[0].length).replace(TRAILING, "");
    if (!word) continue;
    const href = linkableFor(word);
    if (href) found.push({ start, end: start + word.length, text: word, href });
  }
  return found;
}
