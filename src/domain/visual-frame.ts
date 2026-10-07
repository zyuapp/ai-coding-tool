/**
 * An agent's `visual` fence is HTML, CSS, and script drawn inline in its reply. It runs in a frame
 * with an origin of its own: it reaches nothing of the app's and nothing on the network, and talks
 * to the window only through the messages below.
 */

export const VISUAL_SCHEME = "aicodingtool-visual";
export const VISUAL_FRAME_URL = `${VISUAL_SCHEME}://frame/`;
export const VISUAL_LANGUAGE = "visual";

/** Larger than any reasonable visual, small enough that a runaway one stays a code block. */
export const MAX_VISUAL_SOURCE = 1_000_000;
/** A visual taller than this scrolls inside its frame, so a layout that grows with its frame cannot run away. */
export const MAX_VISUAL_HEIGHT = 2000;

const RENDER = "aicodingtool-visual:render";
const THEME = "aicodingtool-visual:theme";
const SIZE = "aicodingtool-visual:size";
const FAILURE = "aicodingtool-visual:error";

/** Inline script and style are the visual itself; everything that would leave the frame is refused. */
export const VISUAL_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The custom properties a visual is styled with, which the skill documents by the same names. */
export type VisualTheme = { scheme: string; vars: Record<string, string> };

export type VisualFrameMessage = { type: "size"; height: number } | { type: "error"; message: string };

export function isVisualFrameUrl(url: string) {
  return url.startsWith(VISUAL_FRAME_URL);
}

export function renderMessage(html: string, theme: VisualTheme) {
  return { type: RENDER, html, ...theme };
}

export function themeMessage(theme: VisualTheme) {
  return { type: THEME, ...theme };
}

/** What a frame says is untrusted: the visual's own script can post anything the bridge can. */
export function visualFrameMessage(data: unknown): VisualFrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as { type?: unknown; height?: unknown; message?: unknown };
  if (message.type === SIZE && typeof message.height === "number" && Number.isFinite(message.height)) {
    return { type: "size", height: Math.min(MAX_VISUAL_HEIGHT, Math.max(0, Math.ceil(message.height))) };
  }
  if (message.type === FAILURE && typeof message.message === "string") return { type: "error", message: message.message.slice(0, 500) };
  return null;
}

/**
 * Runs before the visual. It takes the markup once, applies the theme whenever the window sends one,
 * and reports the height the content needs, so the frame never scrolls a visual that fits.
 */
const BRIDGE = `(() => {
  const host = window.parent;
  const post = (message) => host.postMessage(message, "*");
  let rendered = false;
  let reported = -1;
  let queued = false;
  let failed = false;
  const measure = () => {
    queued = false;
    const body = document.body;
    const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height));
    /**
     * A frame sized to its content never scrolls. A scrollbar would narrow the content, and content
     * that scales with its width would then fit only with the scrollbar, which keeps it there.
     */
    document.documentElement.style.overflowY = height > ${MAX_VISUAL_HEIGHT} ? "auto" : "hidden";
    if (height === reported) return;
    reported = height;
    post({ type: ${JSON.stringify(SIZE)}, height });
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(measure);
  };
  const style = (scheme, vars) => {
    const root = document.documentElement;
    if (vars && typeof vars === "object") {
      for (const [name, value] of Object.entries(vars)) {
        if (/^--[a-z0-9-]+$/.test(name) && typeof value === "string") root.style.setProperty(name, value);
      }
    }
    if (scheme === "light" || scheme === "dark") root.style.colorScheme = scheme;
  };
  const report = (message) => {
    if (failed) return;
    failed = true;
    post({ type: ${JSON.stringify(FAILURE)}, message: String(message) });
  };
  /**
   * A ResizeObserver loop is the browser deferring a notification to the next frame, which the
   * visual still receives. Reporting it would flag a visual that draws fine and use up the one report.
   */
  addEventListener("error", (event) => {
    if (/^ResizeObserver loop/.test(event.message)) return;
    report(event.message || "Script error");
  });
  addEventListener("unhandledrejection", (event) => report(event.reason && event.reason.message || event.reason));
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== host || !data || typeof data !== "object") return;
    if (data.type === ${JSON.stringify(THEME)}) {
      style(data.scheme, data.vars);
      dispatchEvent(new Event("visualthemechange"));
      schedule();
    }
    if (data.type !== ${JSON.stringify(RENDER)} || rendered || typeof data.html !== "string") return;
    rendered = true;
    style(data.scheme, data.vars);
    const template = document.createElement("template");
    template.innerHTML = data.html;
    /** Script parsed into a template never runs; a copy made here runs once it is in the page. */
    for (const inert of template.content.querySelectorAll("script")) {
      const live = document.createElement("script");
      for (const attribute of inert.attributes) live.setAttribute(attribute.name, attribute.value);
      live.textContent = inert.textContent;
      inert.replaceWith(live);
    }
    const body = document.body;
    new ResizeObserver(schedule).observe(body);
    new MutationObserver(schedule).observe(body, { subtree: true, childList: true, attributes: true, characterData: true });
    addEventListener("load", schedule, true);
    body.append(template.content);
    schedule();
  });
})();`;

const BASE_STYLE = `
*, *::before, *::after { box-sizing: border-box; }
html { background: transparent; overflow: hidden; scrollbar-width: thin; scrollbar-color: var(--color-border-strong) transparent; }
body {
  position: relative; display: flow-root; margin: 0;
  color: var(--color-text); font: var(--font-size, 14px)/1.5 var(--font-sans, system-ui, sans-serif);
  accent-color: var(--color-accent); -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { font: inherit; color: inherit; }
`;

export function visualFrameDocument() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${BASE_STYLE}</style><script>${BRIDGE}</script></head><body></body></html>`;
}
