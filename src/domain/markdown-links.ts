const THREAD_HREF = /^claudex:\/\/thread\/([^/?#]+)$/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

export function parseThreadHref(href: string) {
  return THREAD_HREF.exec(href)?.[1] ?? null;
}

export function parseFileHref(href: string) {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  try {
    const decoded = decodeURIComponent(href);
    const suffix = LINE_SUFFIX.exec(decoded);
    const file = suffix ? decoded.slice(0, suffix.index) : decoded;
    return file && !file.endsWith("/") && (!URL_SCHEME.test(file) || WINDOWS_PATH.test(file)) ? file : null;
  } catch {
    return null;
  }
}
