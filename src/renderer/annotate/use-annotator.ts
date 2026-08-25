import { useEffect, useLayoutEffect, useState, type PointerEvent, type RefObject } from "react";
import {
  arrowBetween,
  drawAnnotations,
  markAt,
  normalizeRect,
  pointAt,
  MIN_LENGTH,
  MIN_SIZE,
  type Annotation,
  type AnnotationKind,
  type Frame,
  type Point,
} from "./marks";

/** The screenshot, and the size it is drawn at inside the stage it has to fit. */
export function useAnnotatorImage(source: string, stageRef: RefObject<HTMLDivElement | null>) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [frame, setFrame] = useState<Frame>({ width: 0, height: 0 });

  useEffect(() => {
    let active = true;
    const loaded = new Image();
    loaded.addEventListener("load", () => { if (active) setImage(loaded); });
    loaded.src = source;
    return () => { active = false; };
  }, [source]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !image) return;
    function fit() {
      const bounds = stage!.getBoundingClientRect();
      const ratio = Math.min(bounds.width / image!.naturalWidth, bounds.height / image!.naturalHeight, 1);
      setFrame({ width: Math.max(1, Math.floor(image!.naturalWidth * ratio)), height: Math.max(1, Math.floor(image!.naturalHeight * ratio)) });
    }
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [image]);

  return { image, frame };
}

type PaintedMarks = {
  image: HTMLImageElement | null;
  frame: Frame;
  shapes: Annotation[];
  pending: Omit<Annotation, "kind" | "text"> | null;
  draft: Annotation | null;
  prefix: string;
};

/** The image and every mark on it, painted at the screen's own resolution as the marks are made. */
export function usePaintedMarks(canvasRef: RefObject<HTMLCanvasElement | null>, { image, frame, shapes, pending, draft, prefix }: PaintedMarks) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || frame.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(frame.width * ratio), height = Math.round(frame.height * ratio);
    if (canvas.width !== width) canvas.width = width; if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, frame.width, frame.height);
    context.drawImage(image, 0, 0, frame.width, frame.height);
    const live: Annotation[] = [
      ...shapes,
      ...(pending ? [{ kind: "box" as const, ...pending, text: "" }] : []),
      ...(draft ? [draft] : []),
    ];
    drawAnnotations(context, live, frame.width, frame.height, prefix);
  }, [image, frame, shapes, draft, pending, prefix]);
}

type PointerInput = {
  tool: AnnotationKind;
  frame: Frame;
  shapes: Annotation[];
  /** A note being typed holds the canvas: dragging out a new mark would leave it unfinished. */
  composing: boolean;
  onHover: (index: number | null) => void;
  onArrow: (arrow: Omit<Annotation, "kind" | "text">) => void;
  onBox: (box: Omit<Annotation, "kind" | "text">) => void;
};

/** Dragging a mark out of the canvas, and pointing at the ones already on it. */
export function useMarkPointer({ tool, frame, shapes, composing, onHover, onArrow, onBox }: PointerInput) {
  const [origin, setOrigin] = useState<Point | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);

  const handlers = {
    onPointerDown: (event: PointerEvent<HTMLCanvasElement>) => {
      if (composing) return;
      onHover(null);
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = pointAt(event);
      setOrigin(point);
      setDraft({ kind: tool, ...point, width: 0, height: 0, text: "" });
    },
    onPointerMove: (event: PointerEvent<HTMLCanvasElement>) => {
      const point = pointAt(event);
      if (!origin) {
        onHover(composing ? null : markAt(shapes, point, frame));
        return;
      }
      setDraft({ kind: tool, ...(tool === "arrow" ? arrowBetween(origin, point) : normalizeRect(origin, point)), text: "" });
    },
    onPointerUp: (event: PointerEvent<HTMLCanvasElement>) => {
      if (!origin) return;
      const point = pointAt(event);
      setOrigin(null);
      setDraft(null);
      if (tool === "arrow") {
        const arrow = arrowBetween(origin, point);
        if (Math.hypot(arrow.width, arrow.height) < MIN_LENGTH) return;
        onArrow(arrow);
        return;
      }
      const rect = normalizeRect(origin, point);
      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;
      onBox(rect);
    },
  };

  return { draft, handlers };
}
