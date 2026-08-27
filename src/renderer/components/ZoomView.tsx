import { Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How far past the fitted size a view can be pushed. Fit is never above 1:1, so 1:1 is always reachable. */
const MAX_SCALE = 4;
/** What one press of a zoom button does. A pinch is continuous and uses none of this. */
const SCALE_STEP = 1.4;
/** How far a pinch has to travel to double the size. */
const PINCH_RATE = 100;

export type Sized = { width: number; height: number };

export type Zoom = {
  /** The scroller the view lives in, which is what a fit is measured against. */
  stage: RefObject<HTMLDivElement | null>;
  scale: number;
  fit: number;
  zoomIn: () => void;
  zoomOut: () => void;
};

function clamp(scale: number, fit: number): number {
  return Math.min(MAX_SCALE, Math.max(fit, scale));
}

/**
 * A view is fitted to the window it opens in, and scales between that and 400% from the buttons or
 * from a pinch. Nothing is fitted until its size is known, which an image only reports once it loads.
 */
export function useZoom(size: Sized | null): Zoom {
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const [chosen, setChosen] = useState<number | null>(null);
  /** Where the pointer was over the view when a pinch changed the scale, so the scroller can follow. */
  const held = useRef<{ left: number; top: number } | null>(null);
  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const scale = clamp(chosen ?? fit, fit);
  /** A pinch arrives faster than the view is drawn, so each turn of it reads the last one's answer. */
  const live = useRef({ scale, fit });
  useLayoutEffect(() => { live.current = { scale, fit }; }, [scale, fit]);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || !width) return;
    const measure = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        setFit(Math.min(1, element.clientWidth / width, element.clientHeight / height));
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);

  /** The margins that centre a view smaller than its scroller, which the point under the pointer sits past. */
  const inset = useCallback((element: HTMLDivElement, at: number) => ({
    x: Math.max(0, (element.clientWidth - width * at) / 2),
    y: Math.max(0, (element.clientHeight - height * at) / 2),
  }), [width, height]);

  useEffect(() => {
    const element = stage.current;
    if (!element || !width) return;
    /** Chromium reports a pinch as a wheel it holds control on, and the window would zoom on its own. */
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const at = live.current.scale;
      const next = clamp(at * Math.exp(-event.deltaY / PINCH_RATE), live.current.fit);
      if (next === at) return;
      const box = element.getBoundingClientRect();
      const from = inset(element, at);
      const to = inset(element, next);
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      /** A pinch this fast can turn twice before one scroll lands, so the second turn reads the first. */
      const left = held.current?.left ?? element.scrollLeft;
      const top = held.current?.top ?? element.scrollTop;
      live.current = { ...live.current, scale: next };
      held.current = {
        left: ((left + x - from.x) / at) * next + to.x - x,
        top: ((top + y - from.y) / at) * next + to.y - y,
      };
      setChosen(next);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [width, inset]);

  /** The point the pinch was over is put back under the pointer before the new size is painted. */
  useLayoutEffect(() => {
    const element = stage.current;
    const anchor = held.current;
    held.current = null;
    if (!element || !anchor) return;
    element.scrollLeft = anchor.left;
    element.scrollTop = anchor.top;
  }, [scale]);

  const zoomIn = useCallback(() => setChosen((current) => clamp((current ?? fit) * SCALE_STEP, fit)), [fit]);
  const zoomOut = useCallback(() => setChosen((current) => clamp((current ?? fit) / SCALE_STEP, fit)), [fit]);
  return { stage, scale, fit, zoomIn, zoomOut };
}

/** How big the view is, and the two presses that change it. */
export function ZoomControls({ zoom }: { zoom: Zoom }) {
  return (
    <div className="viewer-zoom" onClick={(event) => event.stopPropagation()}>
      <button type="button" aria-label="Zoom out" disabled={zoom.scale <= zoom.fit} onClick={zoom.zoomOut}>
        <Minus size={15} aria-hidden="true" />
      </button>
      <span>{Math.round(zoom.scale * 100)}%</span>
      <button type="button" aria-label="Zoom in" disabled={zoom.scale >= MAX_SCALE} onClick={zoom.zoomIn}>
        <Plus size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
