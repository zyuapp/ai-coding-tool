import { Minus, Plus, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../focus";

let initialized = false;

/** A rendered diagram and the size it was drawn at, in the units of its own viewBox. */
export type Diagram = { markup: string; width: number; height: number };

/** How far past the fitted size a diagram can be pushed. Fit is never above 1:1, so 1:1 is always reachable. */
const MAX_SCALE = 4;
const SCALE_STEP = 1.4;

/**
 * Mermaid caps its SVG at the width of the container it was rendered for. Dropping that cap and
 * carrying the drawing's own size instead lets a diagram keep its scale and scroll rather than shrink.
 */
export function naturalDiagram(svg: string): Diagram {
  const element = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  const [, , width, height] = (element?.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (!element || !(width > 0) || !(height > 0)) return { markup: svg, width: 0, height: 0 };
  element.removeAttribute("width");
  element.removeAttribute("height");
  element.style.removeProperty("max-width");
  return { markup: element.outerHTML, width, height };
}

function drawnAt(diagram: Diagram, scale: number): CSSProperties {
  if (!diagram.width) return {};
  return { "--diagram-width": `${diagram.width * scale}px`, "--diagram-height": `${diagram.height * scale}px` } as CSSProperties;
}

/** The diagram over the whole window: fitted on entry, then scalable between that and 400%. */
export function DiagramViewer({ diagram, onClose }: { diagram: Diagram; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pressedOn = useRef<EventTarget | null>(null);
  const [fit, setFit] = useState(1);
  const [chosen, setChosen] = useState<number | null>(null);
  useModalFocus(dialog);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || !diagram.width) return;
    const measure = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        setFit(Math.min(1, element.clientWidth / diagram.width, element.clientHeight / diagram.height));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [diagram.width, diagram.height]);

  const scale = Math.min(MAX_SCALE, Math.max(fit, chosen ?? fit));
  return createPortal(
    <div
      ref={dialog}
      className="viewer diagram"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram"
      tabIndex={-1}
      onPointerDown={(event) => { pressedOn.current = event.target; }}
      /** Only a press and release on the same backdrop dismisses, so a drag off the diagram does not. */
      onClick={(event) => { if (event.target === pressedOn.current) onClose(); }}
    >
      <div className="viewer-zoom" onClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Zoom out" disabled={scale <= fit} onClick={() => setChosen(scale / SCALE_STEP)}>
          <Minus size={15} aria-hidden="true" />
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button type="button" aria-label="Zoom in" disabled={scale >= MAX_SCALE} onClick={() => setChosen(scale * SCALE_STEP)}>
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="viewer-close" onClick={onClose} aria-label="Close diagram"><X size={16} /></button>
      <div ref={stage} className="viewer-stage">
        <div
          className="mermaid-svg"
          style={drawnAt(diagram, scale)}
          onClick={(event) => event.stopPropagation()}
          dangerouslySetInnerHTML={{ __html: diagram.markup }}
        />
      </div>
    </div>,
    document.body,
  );
}

const OpenDiagram = createContext<((diagram: Diagram) => void) | null>(null);

/**
 * Holds the opened diagram above the transcript, which unmounts the row a diagram sits in as soon as
 * it scrolls out of view.
 */
export function DiagramViewerHost({ children }: { children: ReactNode }) {
  const [diagram, setDiagram] = useState<Diagram | null>(null);
  const open = useCallback((next: Diagram) => setDiagram(next), []);
  return (
    <OpenDiagram.Provider value={open}>
      {children}
      {diagram && <DiagramViewer diagram={diagram} onClose={() => setDiagram(null)} />}
    </OpenDiagram.Provider>
  );
}

type Drawn = { diagram?: Diagram; error?: string };

/**
 * What each source has already drawn as. A block is remounted often — when its text commits, and
 * whenever the timeline recycles the row it sits in — and rendering it again would blank the diagram
 * for as long as Mermaid takes to redraw text that has not changed.
 */
const drawn = new Map<string, Drawn>();
const MAX_REMEMBERED = 64;

function remember(source: string, result: Drawn) {
  drawn.delete(source);
  drawn.set(source, result);
  for (const stale of [...drawn.keys()].slice(0, drawn.size - MAX_REMEMBERED)) drawn.delete(stale);
}

/** `pending` marks a block whose fence has not closed yet, so its source still grows with the stream. */
export function MermaidBlock({ source, pending = false }: { source: string; pending?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const id = useId().replaceAll(":", "");
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{ source: string; diagram?: Diagram; error?: string }>({ source });
  const open = useContext(OpenDiagram);

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
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || pending || drawn.has(source)) return;
    let cancelled = false;
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (!initialized) {
          const scheme = getComputedStyle(document.documentElement).colorScheme;
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: scheme === "light" ? "default" : "dark",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
          });
          initialized = true;
        }
        const { svg } = await mermaid.render(`mermaid-${id}`, source);
        remember(source, { diagram: naturalDiagram(svg) });
      } catch (error) {
        remember(source, { error: error instanceof Error ? error.message : String(error) });
      }
      if (!cancelled) setResult({ source, ...drawn.get(source) });
    })();
    return () => { cancelled = true; };
  }, [id, source, visible, pending]);

  const current: Drawn = drawn.get(source) ?? (result.source === source ? result : {});
  const drawing = current.diagram
    ? <span className="mermaid-svg" style={drawnAt(current.diagram, 1)} dangerouslySetInnerHTML={{ __html: current.diagram.markup }} />
    : null;
  return (
    <div className="mermaid-block" ref={host}>
      {!current.diagram && !current.error ? <span className="mermaid-loading">Rendering diagram…</span> : null}
      {drawing && open
        ? <button type="button" className="mermaid-open" aria-label="Open the diagram at full size" onClick={() => open(current.diagram!)}>{drawing}</button>
        : drawing}
      {current.error ? <details className="mermaid-error"><summary>Diagram could not be rendered</summary><pre><code>{source}</code></pre></details> : null}
    </div>
  );
}
