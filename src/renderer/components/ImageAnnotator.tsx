import { ArrowUpRight, Check, SquarePen, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type AnnotationKind = "box" | "arrow";

/**
 * Geometry is normalized to 0..1 of the image so it survives resizing and exports at native resolution.
 * A box spans (x, y) to (x + width, y + height) with non-negative extents; an arrow runs from its tail at
 * (x, y) to its tip at (x + width, y + height), so its extents are signed.
 */
export type Annotation = { kind: AnnotationKind; x: number; y: number; width: number; height: number; text: string };

type Point = { x: number; y: number };

const MARK_COLOR = "#ff453a";
const MIN_SIZE = 0.012;
const MIN_LENGTH = 0.03;

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function normalizeRect(start: Point, end: Point): Omit<Annotation, "kind" | "text"> {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function arrowBetween(start: Point, end: Point): Omit<Annotation, "kind" | "text"> {
  return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
}

function distanceToSegment(point: Point, from: Point, to: Point) {
  const runX = to.x - from.x;
  const runY = to.y - from.y;
  const span = runX * runX + runY * runY;
  const along = span === 0 ? 0 : Math.min(1, Math.max(0, ((point.x - from.x) * runX + (point.y - from.y) * runY) / span));
  return Math.hypot(point.x - (from.x + runX * along), point.y - (from.y + runY * along));
}

function drawArrow(context: CanvasRenderingContext2D, annotation: Annotation, width: number, height: number, stroke: number) {
  const tailX = annotation.x * width;
  const tailY = annotation.y * height;
  const tipX = (annotation.x + annotation.width) * width;
  const tipY = (annotation.y + annotation.height) * height;
  const angle = Math.atan2(tipY - tailY, tipX - tailX);
  const length = Math.hypot(tipX - tailX, tipY - tailY);
  const head = Math.max(Math.min(length * 0.3, stroke * 9), stroke * 4);
  const baseX = tipX - Math.cos(angle) * head;
  const baseY = tipY - Math.sin(angle) * head;
  const spread = head * 0.5;
  context.lineWidth = stroke;
  context.lineCap = "round";
  context.strokeStyle = MARK_COLOR;
  context.fillStyle = MARK_COLOR;
  context.beginPath();
  context.moveTo(tailX, tailY);
  context.lineTo(baseX, baseY);
  context.stroke();
  context.beginPath();
  context.moveTo(tipX, tipY);
  context.lineTo(baseX - Math.sin(angle) * spread, baseY + Math.cos(angle) * spread);
  context.lineTo(baseX + Math.sin(angle) * spread, baseY - Math.cos(angle) * spread);
  context.closePath();
  context.fill();
}

/** Greedy word wrap; a word longer than the line is split so it can never overflow the chip. */
export function wrapLabel(context: CanvasRenderingContext2D, label: string, maxWidth: number) {
  const lines: string[] = [];
  let line = "";
  const push = () => { if (line) { lines.push(line); line = ""; } };
  label.split(/\s+/).filter(Boolean).forEach((word) => {
    let rest = word;
    while (context.measureText(rest).width > maxWidth) {
      push();
      let cut = 1;
      while (cut < rest.length && context.measureText(rest.slice(0, cut + 1)).width <= maxWidth) cut += 1;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    const candidate = line ? `${line} ${rest}` : rest;
    if (line && context.measureText(candidate).width > maxWidth) {
      push();
      line = rest;
      return;
    }
    line = candidate;
  });
  push();
  return lines.length > 0 ? lines : [label];
}

export function drawAnnotations(context: CanvasRenderingContext2D, annotations: Annotation[], width: number, height: number) {
  const scale = Math.max(width, height);
  const stroke = Math.max(2, Math.round(scale * 0.003));
  const fontSize = Math.max(11, Math.round(scale * 0.011));
  const padX = Math.round(fontSize * 0.5);
  const padY = Math.round(fontSize * 0.32);
  const lineHeight = Math.round(fontSize * 1.3);
  const maxTextWidth = Math.max(fontSize * 6, width * 0.4 - padX * 2);
  context.lineJoin = "round";
  context.textBaseline = "middle";
  context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`;
  // Only boxes are numbered, so arrows never shift the marks the prompt refers to.
  let mark = 0;
  annotations.forEach((annotation) => {
    if (annotation.kind === "arrow") {
      drawArrow(context, annotation, width, height, stroke);
      return;
    }
    mark += 1;
    const x = annotation.x * width;
    const y = annotation.y * height;
    const boxWidth = Math.max(annotation.width * width, stroke);
    const boxHeight = Math.max(annotation.height * height, stroke);
    context.lineWidth = stroke;
    context.strokeStyle = MARK_COLOR;
    context.strokeRect(x + stroke / 2, y + stroke / 2, Math.max(boxWidth - stroke, 1), Math.max(boxHeight - stroke, 1));
    const label = annotation.text.trim() ? `${mark}. ${annotation.text.trim()}` : `${mark}`;
    const lines = wrapLabel(context, label, maxTextWidth);
    const chipWidth = Math.max(...lines.map((line) => context.measureText(line).width)) + padX * 2;
    const chipHeight = lines.length * lineHeight + padY * 2;
    const chipX = Math.max(0, Math.min(x, width - chipWidth));
    const chipY = y - chipHeight - stroke < 0 ? y + stroke : y - chipHeight - stroke;
    context.fillStyle = MARK_COLOR;
    context.fillRect(chipX, chipY, chipWidth, chipHeight);
    context.fillStyle = "#ffffff";
    lines.forEach((line, index) => {
      context.fillText(line, chipX + padX, chipY + padY + index * lineHeight + lineHeight / 2);
    });
  });
}

export function renderAnnotated(image: HTMLImageElement, annotations: Annotation[]) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawAnnotations(context, annotations, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

const tools: { value: AnnotationKind; label: string; hint: string; icon: typeof SquarePen }[] = [
  { value: "box", label: "Box", hint: "Drag a box over the area you mean", icon: SquarePen },
  { value: "arrow", label: "Arrow", hint: "Drag from anywhere to point at the area you mean", icon: ArrowUpRight },
];

export type ImageAnnotatorProps = {
  source: string;
  annotations: Annotation[];
  onCancel: () => void;
  onApply: (annotations: Annotation[], rendered: string) => void;
};

export function ImageAnnotator({ source, annotations, onCancel, onApply }: ImageAnnotatorProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<AnnotationKind>("box");
  const [shapes, setShapes] = useState(annotations);
  const [origin, setOrigin] = useState<Point | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [pending, setPending] = useState<Omit<Annotation, "kind" | "text"> | null>(null);
  const [label, setLabel] = useState("");

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || frame.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(frame.width * ratio);
    canvas.height = Math.round(frame.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, frame.width, frame.height);
    context.drawImage(image, 0, 0, frame.width, frame.height);
    const live: Annotation[] = [
      ...shapes,
      ...(pending ? [{ kind: "box" as const, ...pending, text: label }] : []),
      ...(draft ? [draft] : []),
    ];
    drawAnnotations(context, live, frame.width, frame.height);
  }, [image, frame, shapes, draft, pending, label]);

  useEffect(() => {
    if (pending) labelRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (pending) {
        setPending(null);
        setLabel("");
      } else onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending, onCancel]);

  function pointAt(event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) };
  }

  /** Corners in on-screen pixels: a box spans them, an arrow runs tail-to-tip along them. */
  function cornersOf(shape: Annotation) {
    return {
      from: { x: shape.x * frame.width, y: shape.y * frame.height },
      to: { x: (shape.x + shape.width) * frame.width, y: (shape.y + shape.height) * frame.height },
    };
  }

  function markAt(point: Point) {
    const at = { x: point.x * frame.width, y: point.y * frame.height };
    const tolerance = 9;
    for (let index = shapes.length - 1; index >= 0; index -= 1) {
      const { from, to } = cornersOf(shapes[index]);
      if (shapes[index].kind === "arrow") {
        if (distanceToSegment(at, from, to) <= tolerance) return index;
        continue;
      }
      const inside = at.x >= from.x - tolerance && at.x <= to.x + tolerance && at.y >= from.y - tolerance && at.y <= to.y + tolerance;
      if (inside) return index;
    }
    return null;
  }

  function commitPending() {
    if (!pending) return;
    setShapes((current) => [...current, { kind: "box", ...pending, text: label.trim() }]);
    setPending(null);
    setLabel("");
  }

  function apply() {
    if (!image) return;
    onApply(shapes, renderAnnotated(image, shapes));
  }

  const activeTool = tools.find((entry) => entry.value === tool)!;

  // Portalled to the body: the composer's stacking context sits below the topbar, which would paint over the overlay.
  return createPortal(
    <div className="annotator" role="dialog" aria-modal="true" aria-label="Annotate screenshot">
      <div className="annotator-panel">
        <header className="annotator-head">
          <div className="annotator-tools" role="group" aria-label="Annotation tool">
            {tools.map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  type="button"
                  key={entry.value}
                  className={`annotator-tool ${entry.value === tool ? "active" : ""}`}
                  aria-pressed={entry.value === tool}
                  onClick={() => {
                    commitPending();
                    setTool(entry.value);
                  }}
                >
                  <Icon size={15} aria-hidden="true" /> {entry.label}
                </button>
              );
            })}
          </div>
          <button type="button" className="annotator-close" onClick={onCancel} aria-label="Close annotator"><X size={16} /></button>
        </header>
        <div className="annotator-stage">
          <div className="annotator-fit" ref={stageRef}>
          {image && frame.width > 0 && (
            <div
              className="annotator-frame"
              data-tool={tool}
              style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
              onPointerLeave={() => setHovered(null)}
            >
              <canvas
                ref={canvasRef}
                style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
                aria-label="Screenshot canvas"
                onPointerDown={(event) => {
                  if (pending) return;
                  setHovered(null);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const point = pointAt(event);
                  setOrigin(point);
                  setDraft({ kind: tool, ...point, width: 0, height: 0, text: "" });
                }}
                onPointerMove={(event) => {
                  const point = pointAt(event);
                  if (!origin) {
                    setHovered(markAt(point));
                    return;
                  }
                  setDraft({ kind: tool, ...(tool === "arrow" ? arrowBetween(origin, point) : normalizeRect(origin, point)), text: "" });
                }}
                onPointerUp={(event) => {
                  if (!origin) return;
                  const point = pointAt(event);
                  setOrigin(null);
                  setDraft(null);
                  if (tool === "arrow") {
                    const arrow = arrowBetween(origin, point);
                    if (Math.hypot(arrow.width, arrow.height) < MIN_LENGTH) return;
                    setShapes((current) => [...current, { kind: "arrow", ...arrow, text: "" }]);
                    return;
                  }
                  const rect = normalizeRect(origin, point);
                  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;
                  setPending(rect);
                }}
              />
              {hovered !== null && shapes[hovered] && !pending && (
                <button
                  type="button"
                  className="annotator-delete"
                  style={{
                    left: `${(shapes[hovered].x + shapes[hovered].width) * frame.width}px`,
                    top: `${(shapes[hovered].kind === "arrow" ? shapes[hovered].y + shapes[hovered].height : shapes[hovered].y) * frame.height}px`,
                  }}
                  aria-label={`Delete ${shapes[hovered].kind} ${hovered + 1}`}
                  onClick={() => {
                    setShapes((current) => current.filter((_, at) => at !== hovered));
                    setHovered(null);
                  }}
                >
                  <X size={11} />
                </button>
              )}
              {pending && (
                <input
                  ref={labelRef}
                  className="annotator-label"
                  style={{ left: `${pending.x * frame.width}px`, top: `${(pending.y + pending.height) * frame.height + 8}px` }}
                  value={label}
                  placeholder="What's wrong here? (Enter to add)"
                  aria-label="Annotation note"
                  onChange={(event) => setLabel(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitPending();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setPending(null);
                      setLabel("");
                    }
                  }}
                />
              )}
            </div>
          )}
          </div>
        </div>
        <footer className="annotator-bar">
          <span className="annotator-count">{shapes.length === 0 ? activeTool.hint : `${shapes.length} mark${shapes.length === 1 ? "" : "s"} — point at one to remove it`}</span>
          <button type="button" className="annotator-action" onClick={onCancel}>Cancel</button>
          <button type="button" className="annotator-action primary" disabled={!image} onClick={apply}>
            <Check size={15} /> Done
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
