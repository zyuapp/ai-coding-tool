import { Check, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Rectangles are stored normalized to 0..1 of the image so they survive resizing and export at native resolution. */
export type Annotation = { x: number; y: number; width: number; height: number; text: string };

type Point = { x: number; y: number };

const MARK_COLOR = "#ff453a";
const MIN_SIZE = 0.012;

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function normalizeRect(start: Point, end: Point): Omit<Annotation, "text"> {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function drawAnnotations(context: CanvasRenderingContext2D, annotations: Annotation[], width: number, height: number) {
  const scale = Math.max(width, height);
  const stroke = Math.max(2, Math.round(scale * 0.003));
  const fontSize = Math.max(13, Math.round(scale * 0.018));
  const padX = Math.round(fontSize * 0.5);
  const padY = Math.round(fontSize * 0.32);
  const chipHeight = fontSize + padY * 2;
  context.lineJoin = "round";
  context.textBaseline = "middle";
  context.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`;
  annotations.forEach((annotation, index) => {
    const x = annotation.x * width;
    const y = annotation.y * height;
    const boxWidth = Math.max(annotation.width * width, stroke);
    const boxHeight = Math.max(annotation.height * height, stroke);
    context.lineWidth = stroke;
    context.strokeStyle = MARK_COLOR;
    context.strokeRect(x + stroke / 2, y + stroke / 2, Math.max(boxWidth - stroke, 1), Math.max(boxHeight - stroke, 1));
    const label = annotation.text.trim() ? `${index + 1}. ${annotation.text.trim()}` : `${index + 1}`;
    const chipWidth = context.measureText(label).width + padX * 2;
    const chipX = Math.max(0, Math.min(x, width - chipWidth));
    const chipY = y - chipHeight - stroke < 0 ? y + stroke : y - chipHeight - stroke;
    context.fillStyle = MARK_COLOR;
    context.fillRect(chipX, chipY, chipWidth, chipHeight);
    context.fillStyle = "#ffffff";
    context.fillText(label, chipX + padX, chipY + chipHeight / 2 + 1);
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
  const [shapes, setShapes] = useState(annotations);
  const [origin, setOrigin] = useState<Point | null>(null);
  const [draft, setDraft] = useState<Omit<Annotation, "text"> | null>(null);
  const [pending, setPending] = useState<Omit<Annotation, "text"> | null>(null);
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
    const live = [
      ...shapes,
      ...(pending ? [{ ...pending, text: label }] : []),
      ...(draft ? [{ ...draft, text: "" }] : []),
    ];
    drawAnnotations(context, live, frame.width, frame.height);
  }, [image, frame, shapes, draft, pending, label]);

  useEffect(() => {
    if (pending) labelRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pending, onCancel]);

  function pointAt(event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) };
  }

  function commitPending() {
    if (!pending) return;
    setShapes((current) => [...current, { ...pending, text: label.trim() }]);
    setPending(null);
    setLabel("");
  }

  function apply() {
    if (!image) return;
    onApply(shapes, renderAnnotated(image, shapes));
  }

  // Portalled to the body: the composer's stacking context sits below the topbar, which would paint over the overlay.
  return createPortal(
    <div className="annotator" role="dialog" aria-modal="true" aria-label="Annotate screenshot">
      <div className="annotator-panel">
        <header className="annotator-head">
          <button type="button" className="annotator-close" onClick={onCancel} aria-label="Close annotator"><X size={16} /></button>
        </header>
        <div className="annotator-stage">
          <div className="annotator-fit" ref={stageRef}>
          {image && frame.width > 0 && (
            <div className="annotator-frame" style={{ width: `${frame.width}px`, height: `${frame.height}px` }}>
              <canvas
                ref={canvasRef}
                style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
                aria-label="Screenshot canvas"
                onPointerDown={(event) => {
                  if (pending) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const point = pointAt(event);
                  setOrigin(point);
                  setDraft({ ...point, width: 0, height: 0 });
                }}
                onPointerMove={(event) => {
                  if (!origin) return;
                  setDraft(normalizeRect(origin, pointAt(event)));
                }}
                onPointerUp={(event) => {
                  if (!origin) return;
                  const rect = normalizeRect(origin, pointAt(event));
                  setOrigin(null);
                  setDraft(null);
                  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return;
                  setPending(rect);
                }}
              />
              {shapes.map((shape, index) => (
                <button
                  type="button"
                  key={`${index}-${shape.x}-${shape.y}`}
                  className="annotator-delete"
                  style={{ left: `${(shape.x + shape.width) * frame.width}px`, top: `${shape.y * frame.height}px` }}
                  aria-label={`Delete box ${index + 1}`}
                  onClick={() => setShapes((current) => current.filter((_, at) => at !== index))}
                >
                  <X size={11} />
                </button>
              ))}
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
          <span className="annotator-count">{shapes.length === 0 ? "Drag a box over the area you mean" : `${shapes.length} box${shapes.length === 1 ? "" : "es"}`}</span>
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
