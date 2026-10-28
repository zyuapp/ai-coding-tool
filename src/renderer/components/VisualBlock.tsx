import { LuCircleAlert as CircleAlert } from "react-icons/lu";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { renderMessage, themeMessage, VISUAL_FRAME_URL, visualFrameMessage, type VisualTheme } from "../../domain/visual-frame";

/** What a visual is styled with, by the names the visualize skill documents, read from the app's own tokens. */
const COLOR_TOKENS: Array<[string, string]> = [
  ["--color-bg", "--canvas"],
  ["--color-surface", "--sunken"],
  ["--color-surface-raised", "--surface"],
  ["--color-surface-hover", "--surface-hover"],
  ["--color-text", "--ink"],
  ["--color-text-secondary", "--muted"],
  ["--color-text-tertiary", "--quiet"],
  ["--color-border", "--line"],
  ["--color-border-strong", "--line-strong"],
  ["--color-accent", "--accent"],
  ["--color-on-accent", "--accent-ink"],
  ["--color-success", "--success"],
  ["--color-warning", "--p-ansi-yellow"],
  ["--color-danger", "--danger"],
  ["--color-info", "--info"],
  ["--series-1", "--p-ansi-blue"],
  ["--series-2", "--p-ansi-green"],
  ["--series-3", "--p-ansi-yellow"],
  ["--series-4", "--p-ansi-magenta"],
  ["--series-5", "--p-ansi-cyan"],
  ["--series-6", "--p-ansi-red"],
];

/** The theme as it stands where the visual sits, so its type matches the prose around it. */
function currentTheme(where: Element): VisualTheme {
  const root = getComputedStyle(document.documentElement);
  const prose = getComputedStyle(where);
  const vars: Record<string, string> = {};
  for (const [name, token] of COLOR_TOKENS) vars[name] = root.getPropertyValue(token).trim();
  vars["--font-sans"] = prose.fontFamily;
  vars["--font-mono"] = root.getPropertyValue("--mono").trim() || "ui-monospace, monospace";
  vars["--font-size"] = prose.fontSize;
  vars["--radius"] = "10px";
  return { scheme: root.colorScheme === "light" ? "light" : "dark", vars };
}

const restyleListeners = new Set<() => void>();

/** A visual keeps its state across a theme or type change: the new values are sent, not the visual again. */
export function restyleVisuals() {
  for (const listener of restyleListeners) listener();
}

/**
 * The height each visual last reported. A row is remounted whenever the timeline recycles it, and a
 * frame that starts at a guessed height would shift everything below it once the visual measured.
 */
const heights = new Map<string, number>();
const MAX_REMEMBERED = 64;

/** How long a visual may take to report its size before it is taken to have failed. */
export const VISUAL_TIMEOUT_MS = 10_000;

function rememberHeight(source: string, height: number) {
  heights.delete(source);
  heights.set(source, height);
  for (const stale of [...heights.keys()].slice(0, heights.size - MAX_REMEMBERED)) heights.delete(stale);
}

/** What a visual calls itself: its title, else its first heading. */
export function visualTitle(source: string): string {
  const named = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source) ?? /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(source);
  const text = named?.[1]?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return text || "Visual";
}

/** A block that failed to draw: what went wrong at a glance, the rest on opening, and another go. */
export function BlockError({ title, error, className, onRetry, children }: { title: string; error: string; className?: string; onRetry: () => void; children: ReactNode }) {
  const reason = error.split("\n", 1)[0]!.trim();
  return (
    <div className={className ? `block-error ${className}` : "block-error"} role="alert">
      <details>
        <summary><CircleAlert className="notice-icon" aria-hidden="true" />{title}{reason && <span className="block-error-reason">{reason}</span>}</summary>
        {children}
      </details>
      <button type="button" className="limit-action" onClick={onRetry}>Try again</button>
    </div>
  );
}

/** `pending` marks a block whose fence has not closed yet, so its source still grows with the stream. */
export function VisualBlock({ source, pending = false }: { source: string; pending?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(() => heights.get(source));
  const [error, setError] = useState<string | null>(null);
  /** Each try draws into a fresh frame, so a visual that failed starts again from nothing. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "480px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = visualFrameMessage(event.data);
      if (message?.type === "size") {
        rememberHeight(source, message.height);
        setHeight(message.height);
      }
      if (message?.type === "error") setError((shown) => shown ?? message.message);
    }
    function restyle() {
      if (frame.current && host.current) frame.current.contentWindow?.postMessage(themeMessage(currentTheme(host.current)), "*");
    }
    window.addEventListener("message", onMessage);
    restyleListeners.add(restyle);
    return () => {
      window.removeEventListener("message", onMessage);
      restyleListeners.delete(restyle);
    };
  }, [source]);

  /** The frame's address is fixed, so the opaque origin it gets cannot be named; the markup is not secret. */
  const draw = useCallback(() => {
    if (frame.current && host.current) frame.current.contentWindow?.postMessage(renderMessage(source, currentTheme(host.current)), "*");
  }, [source]);

  const live = visible && !pending;
  const title = useMemo(() => (live ? visualTitle(source) : "Visual"), [live, source]);
  const drawing = live && height === undefined && error === null;

  useEffect(() => {
    if (!drawing) return;
    const timer = setTimeout(() => setError((shown) => shown ?? "The visual did not finish drawing."), VISUAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [drawing, source, attempt]);

  const retry = () => {
    heights.delete(source);
    setHeight(undefined);
    setError(null);
    setAttempt((count) => count + 1);
  };

  return (
    <div className="visual-block" ref={host} style={height === undefined ? undefined : { "--visual-height": `${height}px` } as CSSProperties}>
      {live
        ? <iframe
            key={`${attempt}:${source}`}
            ref={frame}
            className="visual-frame"
            title={title}
            src={VISUAL_FRAME_URL}
            sandbox="allow-scripts"
            data-ready={height === undefined ? undefined : ""}
            onLoad={draw}
          />
        : <span className="visual-loading">{pending ? <span className="text-sweep">Drawing visual…</span> : null}</span>}
      {drawing && <span className="visual-loading visual-loading-over"><span className="text-sweep">Drawing visual…</span></span>}
      {error ? (
        <BlockError className="visual-error" title="The visual hit an error" error={error} onRetry={retry}>
          <pre><code>{error}</code></pre>
        </BlockError>
      ) : null}
    </div>
  );
}
