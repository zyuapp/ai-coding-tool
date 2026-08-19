/** One page the browser panel holds open. The reducer owns this record; the view itself lives in main. */
export type BrowserTab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
};

/** An element a snapshot offers to act on. `ref` is only valid until the next snapshot of that tab. */
export type BrowserElement = {
  ref: string;
  role: string;
  name: string;
  /** What a field currently holds. Never set for a password field. */
  value?: string;
};

export type BrowserSnapshot = {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  text: string;
  elements: BrowserElement[];
};

/** What a caller does to the page. Every target is a `ref` from that tab's latest snapshot. */
export type BrowserAction =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; submit?: boolean };

export type BrowserBounds = { x: number; y: number; width: number; height: number };

/** A navigation the user has to answer before a run may make it. */
export type BrowserApproval = {
  url: string;
  taskId: string;
  /** The tab it would load in, or a new one when absent. */
  tabId?: string;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * What the browser will load for what a caller typed, or null when that is nothing it can load.
 * Only http and https ever come back, so no caller can reach the file system through the panel.
 */
export function browserUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${LOCAL_HOSTS.has(trimmed.split(/[:/?#]/)[0] ?? "") ? "http" : "https"}://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The origin an allowlist entry covers. Null for anything that is not a loadable page. */
export function browserOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** How a tab reads in a list, for a caller that has no screen. */
export function describeTab(tab: BrowserTab) {
  const parts = [`${tab.title || tab.url || "Blank tab"} [${tab.id}]`, tab.url, ...(tab.loading ? ["loading"] : []), ...(tab.error ? [tab.error] : [])];
  return parts.filter(Boolean).join(" · ");
}
