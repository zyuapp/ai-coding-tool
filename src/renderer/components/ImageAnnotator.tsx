import { ArrowUpRight, Check, Pencil, SquarePen, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../focus";

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

const BADGE_INK = "#ffffff";

type Rect = { x: number; y: number; width: number; height: number };

export function badgeRadius(width: number, height: number) {
  return Math.max(11, Math.round(Math.max(width, height) * 0.013));
}

/** Corners first, outside then inside, so a badge leaves the marked area clear whenever it can. */
function spotsAround(box: Rect, radius: number) {
  const { x, y, width, height } = box;
  return [
    { x: x - radius, y: y - radius },
    { x: x + width + radius, y: y - radius },
    { x: x - radius, y: y + height + radius },
    { x: x + width + radius, y: y + height + radius },
    { x: x + radius, y: y + radius },
    { x: x + width - radius, y: y + radius },
    { x: x + radius, y: y + height - radius },
    { x: x + width - radius, y: y + height - radius },
  ];
}

/**
 * Where each box's badge sits, in image pixels. Boxes drawn close together would stack their badges
 * on the same corner, so each one takes the first spot no earlier badge already holds.
 */
export function placeBadges(boxes: Rect[], width: number, height: number) {
  const radius = badgeRadius(width, height);
  const placed: Point[] = [];
  boxes.forEach((box) => {
    const spots = spotsAround(box, radius).map((spot) => ({
      x: Math.min(Math.max(spot.x, radius), Math.max(width - radius, radius)),
      y: Math.min(Math.max(spot.y, radius), Math.max(height - radius, radius)),
    }));
    const free = spots.find((spot) => placed.every((taken) => Math.hypot(spot.x - taken.x, spot.y - taken.y) >= radius * 2));
    placed.push(free ?? spots[0]);
  });
  return placed;
}

function drawBadge(context: CanvasRenderingContext2D, center: Point, radius: number, mark: string) {
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fillStyle = MARK_COLOR;
  context.fill();
  context.lineWidth = Math.max(1, radius * 0.14);
  context.strokeStyle = BADGE_INK;
  context.stroke();
  context.fillStyle = BADGE_INK;
  context.fillText(mark, center.x, center.y);
}

/**
 * Marks carry their number and nothing else: the notes travel with the prompt as text, so drawing
 * them again would only cover the screenshot they describe.
 */
export function drawAnnotations(context: CanvasRenderingContext2D, annotations: Annotation[], width: number, height: number, prefix = "") {
  const stroke = Math.max(2, Math.round(Math.max(width, height) * 0.003));
  const radius = badgeRadius(width, height);
  const boxes = annotations.filter((annotation) => annotation.kind === "box").map((annotation) => ({
    x: annotation.x * width,
    y: annotation.y * height,
    width: Math.max(annotation.width * width, stroke),
    height: Math.max(annotation.height * height, stroke),
  }));
  const centers = placeBadges(boxes, width, height);
  context.lineJoin = "round";
  context.textBaseline = "middle";
  context.textAlign = "center";
  context.font = `700 ${Math.round(radius * 1.1)}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`;
  // Only boxes are numbered, so arrows never shift the marks the prompt refers to.
  let mark = 0;
  annotations.forEach((annotation) => {
    if (annotation.kind === "arrow") {
      drawArrow(context, annotation, width, height, stroke);
      return;
    }
    const box = boxes[mark];
    const center = centers[mark];
    mark += 1;
    context.lineWidth = stroke;
    context.strokeStyle = MARK_COLOR;
    context.strokeRect(box.x + stroke / 2, box.y + stroke / 2, Math.max(box.width - stroke, 1), Math.max(box.height - stroke, 1));
    drawBadge(context, center, radius, `${prefix}${mark}`);
  });
}

export function renderAnnotated(image: HTMLImageElement, annotations: Annotation[], prefix = "") {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  drawAnnotations(context, annotations, canvas.width, canvas.height, prefix);
  return canvas.toDataURL("image/png");
}

/**
 * The same render from a data URL. A mark's letter follows the screenshot's place in the send, which
 * is only settled once the composer hands the images over, so the marks are drawn again there.
 */
export function renderAnnotatedSource(source: string, annotations: Annotation[], prefix = "") {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => {
      try {
        resolve(renderAnnotated(image, annotations, prefix));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    image.addEventListener("error", () => reject(new Error("Could not read the image to annotate.")));
    image.src = source;
  });
}

const tools: { value: AnnotationKind; label: string; hint: string; icon: typeof SquarePen }[] = [
  { value: "box", label: "Box", hint: "Drag a box over the area you mean", icon: SquarePen },
  { value: "arrow", label: "Arrow", hint: "Drag from anywhere to point at the area you mean", icon: ArrowUpRight },
];

export type ImageAnnotatorProps = {
  source: string;
  annotations: Annotation[];
  /** The letter this screenshot's marks carry, empty when it is the only one being sent. */
  prefix?: string;
  onCancel: () => void;
  onApply: (annotations: Annotation[], rendered: string) => void;
};

export function ImageAnnotator({ source, annotations, prefix = "", onCancel, onApply }: ImageAnnotatorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
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
  const [editing, setEditing] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  useModalFocus(dialogRef);

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
      ...(pending ? [{ kind: "box" as const, ...pending, text: "" }] : []),
      ...(draft ? [draft] : []),
    ];
    drawAnnotations(context, live, frame.width, frame.height, prefix);
  }, [image, frame, shapes, draft, pending, prefix]);

  useEffect(() => {
    if (!pending && editing === null) return;
    labelRef.current?.focus();
    if (editing !== null) labelRef.current?.select();
  }, [pending, editing]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (pending || editing !== null) closeLabel();
      else onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending, editing, onCancel]);

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

  function closeLabel() {
    setPending(null);
    setEditing(null);
    setLabel("");
  }

  /** Writes the note being typed onto the box it belongs to, whether that box is new or already drawn. */
  function commitLabel() {
    const at = editing;
    if (at !== null) setShapes((current) => current.map((shape, index) => (index === at ? { ...shape, text: label.trim() } : shape)));
    else if (pending) setShapes((current) => [...current, { kind: "box", ...pending, text: label.trim() }]);
    else return;
    closeLabel();
  }

  /** The number a box is drawn with, so what a control says matches what the screenshot shows. */
  function markNumber(index: number) {
    return shapes.slice(0, index + 1).filter((shape) => shape.kind === "box").length;
  }

  function apply() {
    if (!image) return;
    onApply(shapes, renderAnnotated(image, shapes, prefix));
  }

  const activeTool = tools.find((entry) => entry.value === tool)!;
  const composing = pending !== null || editing !== null;
  /** The box the note being typed belongs to: a rect just drawn, or one already on the image. */
  const composeAt = pending ?? (editing === null ? null : shapes[editing] ?? null);

  // Portalled to the body: the composer's stacking context sits below the topbar, which would paint over the overlay.
  return createPortal(
    <div ref={dialogRef} className="annotator" role="dialog" aria-modal="true" aria-label="Annotate screenshot" tabIndex={-1}>
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
                    commitLabel();
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
                  if (composing) return;
                  setHovered(null);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const point = pointAt(event);
                  setOrigin(point);
                  setDraft({ kind: tool, ...point, width: 0, height: 0, text: "" });
                }}
                onPointerMove={(event) => {
                  const point = pointAt(event);
                  if (!origin) {
                    setHovered(composing ? null : markAt(point));
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
              {hovered !== null && shapes[hovered] && !composing && (
                <div
                  className="annotator-marktools"
                  style={{
                    left: `${(shapes[hovered].x + shapes[hovered].width) * frame.width}px`,
                    top: `${(shapes[hovered].kind === "arrow" ? shapes[hovered].y + shapes[hovered].height : shapes[hovered].y) * frame.height}px`,
                  }}
                  onPointerEnter={() => setHovered(hovered)}
                >
                  {shapes[hovered].kind === "box" && (
                    <button
                      type="button"
                      className="annotator-marktool"
                      aria-label={`Edit note on mark ${prefix}${markNumber(hovered)}`}
                      onClick={() => {
                        setLabel(shapes[hovered].text);
                        setEditing(hovered);
                        setHovered(null);
                      }}
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="annotator-marktool remove"
                    aria-label={shapes[hovered].kind === "arrow" ? "Delete arrow" : `Delete mark ${prefix}${markNumber(hovered)}`}
                    onClick={() => {
                      setShapes((current) => current.filter((_, at) => at !== hovered));
                      setHovered(null);
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              )}
              {composeAt && (
                <input
                  ref={labelRef}
                  className="annotator-label"
                  style={{ left: `${composeAt.x * frame.width}px`, top: `${(composeAt.y + composeAt.height) * frame.height + 8}px` }}
                  value={label}
                  placeholder="What's wrong here? (Enter to add)"
                  aria-label="Annotation note"
                  onChange={(event) => setLabel(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitLabel();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      closeLabel();
                    }
                  }}
                />
              )}
            </div>
          )}
          </div>
        </div>
        <footer className="annotator-bar">
          <span className="annotator-count">{shapes.length === 0 ? activeTool.hint : `${shapes.length} mark${shapes.length === 1 ? "" : "s"} — point at one to edit or remove it`}</span>
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
