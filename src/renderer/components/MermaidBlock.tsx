import { LuMaximize2 as Maximize } from "react-icons/lu";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { BlockError, BlockViewer, OpenVisual, VisualViewer } from "./VisualBlock";
import { ZoomControls, useZoom } from "./ZoomView";

let initialized = false;

/** A rendered diagram and the size it was drawn at, in the units of its own viewBox. */
export type Diagram = { markup: string; width: number; height: number };

type Frame = { x: number; y: number; width: number; height: number };

/** Breathing room around a drawing that has to be framed by what it holds. */
const FRAME_PADDING = 8;

/** The frame Mermaid asked for, or nothing when it asked for one a diagram cannot be drawn in. */
function askedFrame(element: SVGSVGElement): Frame | null {
  const [x, y, width, height] = (element.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/** What the drawing covers, which only a laid out copy of it can answer. */
function drawnFrame(element: SVGSVGElement): Frame | null {
  /** Hidden rather than undisplayed: an undisplayed drawing has no bounds to read. */
  const host = document.createElement("div");
  host.setAttribute("style", "position: absolute; left: -100000px; top: 0; visibility: hidden");
  host.appendChild(element);
  document.body.appendChild(host);
  let drawn: Frame | null = null;
  try {
    const { x, y, width, height } = element.getBBox();
    if (width > 0 && height > 0) {
      drawn = { x: x - FRAME_PADDING, y: y - FRAME_PADDING, width: width + FRAME_PADDING * 2, height: height + FRAME_PADDING * 2 };
    }
  } catch {
    drawn = null;
  }
  host.remove();
  return drawn;
}

/**
 * Mermaid caps its SVG at the width of the container it was rendered for, and it sizes a few diagrams
 * from that container rather than from what they hold. Dropping the cap and carrying the drawing's
 * own size instead lets a diagram keep its scale and scroll rather than shrink; a diagram Mermaid
 * could not size at all is framed by what it drew, so none of it falls outside the frame.
 */
export function naturalDiagram(svg: string): Diagram {
  const parsed = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
  if (!parsed) return { markup: svg, width: 0, height: 0 };
  const element = document.importNode(parsed, true);
  element.removeAttribute("width");
  element.removeAttribute("height");
  element.style.removeProperty("max-width");

  const asked = askedFrame(element);
  if (asked) return { markup: element.outerHTML, width: asked.width, height: asked.height };
  const drawn = drawnFrame(element);
  if (!drawn) return { markup: svg, width: 0, height: 0 };
  element.setAttribute("viewBox", `${drawn.x} ${drawn.y} ${drawn.width} ${drawn.height}`);
  return { markup: element.outerHTML, width: drawn.width, height: drawn.height };
}

function drawnAt(diagram: Diagram, scale: number): CSSProperties {
  if (!diagram.width) return {};
  return { "--diagram-width": `${diagram.width * scale}px`, "--diagram-height": `${diagram.height * scale}px` } as CSSProperties;
}

/** The diagram over the whole window: fitted on entry, then scalable between that and 400%. */
export function DiagramViewer({ diagram, onClose }: { diagram: Diagram; onClose: () => void }) {
  const zoom = useZoom(diagram.width ? diagram : null);
  return (
    <BlockViewer label="Diagram" className="diagram" controls={<ZoomControls zoom={zoom} />} onClose={onClose}>
      <div ref={zoom.stage} className="viewer-stage">
        <div
          className="mermaid-svg"
          style={drawnAt(diagram, zoom.scale)}
          onClick={(event) => event.stopPropagation()}
          dangerouslySetInnerHTML={{ __html: diagram.markup }}
        />
      </div>
    </BlockViewer>
  );
}

/** A diagram as opened: what it was drawn from, and the width it was drawn for, so a theme change can redraw it. */
type OpenedDiagram = { diagram: Diagram; source: string; room: number; generation: number };

const OpenDiagram = createContext<((opened: Omit<OpenedDiagram, "generation">) => void) | null>(null);

/**
 * Holds the opened diagram above the transcript, which unmounts the row a diagram sits in as soon as
 * it scrolls out of view. A theme change redraws it in place; one that no longer draws closes it.
 */
export function DiagramViewerHost({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<OpenedDiagram | { visual: string } | null>(null);
  const generation = useSyncExternalStore(subscribeToGeneration, readGeneration);
  const openDiagram = useCallback((opened: Omit<OpenedDiagram, "generation">) => setShown({ ...opened, generation: readGeneration() }), []);
  const openVisual = useCallback((visual: string) => setShown({ visual }), []);
  const close = useCallback(() => setShown(null), []);
  const stale = shown && "diagram" in shown && shown.generation !== generation ? shown : null;
  useEffect(() => {
    if (!stale) return;
    let cancelled = false;
    void drawDiagram(stale.source, "mermaid-viewer", stale.room).then((result) => {
      if (cancelled || !result) return;
      setShown((current) => (current !== stale ? current : result.diagram ? { ...stale, diagram: result.diagram, generation: readGeneration() } : null));
    });
    return () => { cancelled = true; };
  }, [stale, generation]);
  return (
    <OpenDiagram.Provider value={openDiagram}>
    <OpenVisual.Provider value={openVisual}>
      {children}
      {shown && ("diagram" in shown
        ? <DiagramViewer diagram={shown.diagram} onClose={close} />
        : <VisualViewer source={shown.visual} onClose={close} />)}
    </OpenVisual.Provider>
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

let themeGeneration = 0;
const generationListeners = new Set<() => void>();

/** Mermaid bakes the theme into the SVG it hands back, so a theme change throws away what was drawn. */
export function redrawDiagrams() {
  initialized = false;
  drawn.clear();
  themeGeneration += 1;
  for (const listener of generationListeners) listener();
}

function readGeneration() {
  return themeGeneration;
}

function subscribeToGeneration(listener: () => void) {
  generationListeners.add(listener);
  return () => { generationListeners.delete(listener); };
}

function remember(source: string, result: Drawn) {
  drawn.delete(source);
  drawn.set(source, result);
  for (const stale of [...drawn.keys()].slice(0, drawn.size - MAX_REMEMBERED)) drawn.delete(stale);
}

/** The width a diagram is drawn for when the block it belongs to has no width of its own yet. */
const ASSUMED_ROOM = 720;

/**
 * Some diagrams take their width from the element they are drawn in rather than from what they hold,
 * so one is drawn in a box as wide as the block it will be shown in.
 */
async function drawnHere(mermaid: typeof import("mermaid").default, id: string, source: string, room: number): Promise<string> {
  const scratch = document.createElement("div");
  const width = Math.max(320, Math.round(room) || ASSUMED_ROOM);
  scratch.setAttribute("style", `position: absolute; left: -100000px; top: 0; width: ${width}px; visibility: hidden`);
  document.body.appendChild(scratch);
  try {
    return (await mermaid.render(id, source, scratch)).svg;
  } finally {
    scratch.remove();
  }
}

/**
 * Draws a source in the current theme and remembers what it drew as. Nothing comes back when the theme
 * changed before it finished, since that drawing is already stale.
 */
async function drawDiagram(source: string, id: string, room: number): Promise<Drawn | null> {
  const drawnAs = readGeneration();
  try {
    const { default: mermaid } = await import("mermaid");
    if (readGeneration() !== drawnAs) return null;
    if (!initialized) {
      /** A face that arrives later would widen every word Mermaid has already measured. */
      await document.fonts.ready;
      if (readGeneration() !== drawnAs) return null;
      const scheme = getComputedStyle(document.documentElement).colorScheme;
      const prose = getComputedStyle(document.body);
      const size = Math.round(parseFloat(prose.fontSize)) || 16;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: scheme === "light" ? "default" : "dark",
        /** The layout every diagram here was drawn with before ELK became the default. */
        layout: "dagre",
        /**
         * A label drawn as SVG text is measured and painted in one place. An HTML label is
         * measured in one and painted in another, which cuts a label that grew between the two.
         */
        htmlLabels: false,
        fontFamily: prose.fontFamily,
        /** Mermaid measures words against the number and paints them from the theme's own value. */
        fontSize: size,
        themeVariables: { fontSize: `${size}px` },
      });
      initialized = true;
    }
    /** Mermaid keys its scratch node on the id it is given, so two renders may not share one. */
    const svg = await drawnHere(mermaid, `${id}-${drawnAs}`, source, room);
    if (readGeneration() !== drawnAs) return null;
    remember(source, { diagram: naturalDiagram(svg) });
  } catch (error) {
    if (readGeneration() !== drawnAs) return null;
    remember(source, { error: error instanceof Error ? error.message : String(error) });
  }
  return drawn.get(source) ?? null;
}

/** `pending` marks a block whose fence has not closed yet, so its source still grows with the stream. */
export function MermaidBlock({ source, pending = false }: { source: string; pending?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const id = useId().replaceAll(":", "");
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{ source: string; diagram?: Diagram; error?: string }>({ source });
  const open = useContext(OpenDiagram);
  const generation = useSyncExternalStore(subscribeToGeneration, readGeneration);
  /** Each try renders under its own id, since Mermaid keys its scratch node on it. */
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
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || pending || drawn.has(source)) return;
    let cancelled = false;
    void drawDiagram(source, `mermaid-${id}-${attempt}`, host.current?.clientWidth ?? 0).then((result) => {
      if (!cancelled && result) setResult({ source, ...result });
    });
    return () => { cancelled = true; };
  }, [id, source, visible, pending, generation, attempt]);

  const retry = () => {
    drawn.delete(source);
    setResult({ source });
    setAttempt((count) => count + 1);
  };

  const current: Drawn = drawn.get(source) ?? (result.source === source ? result : {});
  const drawing = current.diagram
    ? <span className="mermaid-svg" style={drawnAt(current.diagram, 1)} dangerouslySetInnerHTML={{ __html: current.diagram.markup }} />
    : null;
  return (
    <>
      <div className="mermaid-block" ref={host}>
        {!current.diagram && !current.error ? <span className="mermaid-loading"><span className="text-sweep">Rendering diagram…</span></span> : null}
        {drawing && open
          ? <span className="mermaid-open" onClick={() => open({ diagram: current.diagram!, source, room: host.current?.clientWidth ?? 0 })}>{drawing}</span>
          : drawing}
        {current.error ? (
          <BlockError className="mermaid-error" title="Diagram could not be rendered" error={current.error} onRetry={retry}>
            <p className="block-error-message">{current.error}</p>
            <pre><code>{source}</code></pre>
          </BlockError>
        ) : null}
      </div>
      {drawing && open && (
        <button type="button" className="diagram-expand" aria-label="Open the diagram at full size" data-tip="Full size" onClick={() => open({ diagram: current.diagram!, source, room: host.current?.clientWidth ?? 0 })}>
          <Maximize size={14} aria-hidden="true" />
        </button>
      )}
    </>
  );
}
