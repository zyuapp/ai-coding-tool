const THREAD_HREF = /^aicodingtool:\/\/thread\/([^/?#]+)$/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

export function parseThreadHref(href: string) {
  return THREAD_HREF.exec(href)?.[1] ?? null;
}

/** The file a link names, and the line to open it at when the link carried one. */
export function parseFileHref(href: string): { file: string; line: number | null } | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  try {
    const decoded = decodeURIComponent(href);
    const suffix = LINE_SUFFIX.exec(decoded);
    const file = suffix ? decoded.slice(0, suffix.index) : decoded;
    if (!file || file.endsWith("/") || (URL_SCHEME.test(file) && !WINDOWS_PATH.test(file))) return null;
    const line = suffix ? Number(suffix[0].slice(1).split(":")[0]) : 0;
    return { file, line: line > 0 ? line : null };
  } catch {
    return null;
  }
}
