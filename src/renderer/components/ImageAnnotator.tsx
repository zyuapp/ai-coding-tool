import { LuArrowUpRight as ArrowUpRight, LuCheck as Check, LuPencil as Pencil, LuSquarePen as SquarePen, LuX as X } from "react-icons/lu";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../focus";
import { renderAnnotated, type Annotation, type AnnotationKind, type Frame } from "../annotate/marks";
import { useAnnotatorImage, useMarkPointer, usePaintedMarks } from "../annotate/use-annotator";

export {
  arrowBetween,
  badgeRadius,
  drawAnnotations,
  normalizeRect,
  placeBadges,
  renderAnnotated,
  renderAnnotatedSource,
} from "../annotate/marks";
export type { Annotation, AnnotationKind } from "../annotate/marks";

const tools: { value: AnnotationKind; label: string; hint: string; icon: typeof SquarePen }[] = [
  { value: "box", label: "Box", hint: "Drag a box over the area you mean", icon: SquarePen },
  { value: "arrow", label: "Arrow", hint: "Drag from anywhere to point at the area you mean", icon: ArrowUpRight },
];

/** What the next drag draws. */
function ToolPicker({ tool, onPick }: { tool: AnnotationKind; onPick: (tool: AnnotationKind) => void }) {
  return (
    <div className="annotator-tools" role="group" aria-label="Annotation tool">
      {tools.map((entry) => {
        const Icon = entry.icon;
        return (
          <button
            type="button"
            key={entry.value}
            className={`annotator-tool ${entry.value === tool ? "active" : ""}`}
            aria-pressed={entry.value === tool}
            onClick={() => onPick(entry.value)}
          >
            <Icon size={15} aria-hidden="true" /> {entry.label}
          </button>
        );
      })}
    </div>
  );
}

/** What can be done to the mark under the pointer, drawn off its far corner. */
function MarkTools({ shape, frame, mark, onKeep, onEdit, onRemove }: {
  shape: Annotation;
  frame: Frame;
  mark: string;
  onKeep: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="annotator-marktools"
      style={{
        left: `${(shape.x + shape.width) * frame.width}px`,
        top: `${(shape.kind === "arrow" ? shape.y + shape.height : shape.y) * frame.height}px`,
      }}
      onPointerEnter={onKeep}
    >
      {shape.kind === "box" && (
        <button type="button" className="annotator-marktool" aria-label={`Edit note on mark ${mark}`} onClick={onEdit}>
          <Pencil size={11} />
        </button>
      )}
      <button
        type="button"
        className="annotator-marktool remove"
        aria-label={shape.kind === "arrow" ? "Delete arrow" : `Delete mark ${mark}`}
        onClick={onRemove}
      >
        <X size={11} />
      </button>
    </div>
  );
}

/** The note being typed, held under the box it belongs to. */
function MarkLabel({ inputRef, box, frame, label, onLabel, onCommit, onClose }: {
  inputRef: RefObject<HTMLInputElement | null>;
  box: Omit<Annotation, "kind" | "text">;
  frame: Frame;
  label: string;
  onLabel: (label: string) => void;
  onCommit: () => void;
  onClose: () => void;
}) {
  return (
    <input
      ref={inputRef}
      className="annotator-label"
      style={{ left: `${box.x * frame.width}px`, top: `${(box.y + box.height) * frame.height + 8}px` }}
      value={label}
      placeholder="What's wrong here? (Enter to add)"
      aria-label="Annotation note"
      onChange={(event) => onLabel(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    />
  );
}

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
  const [tool, setTool] = useState<AnnotationKind>("box");
  const [shapes, setShapes] = useState(annotations);
  const [hovered, setHovered] = useState<number | null>(null);
  const [pending, setPending] = useState<Omit<Annotation, "kind" | "text"> | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  useModalFocus(dialogRef);

  const composing = pending !== null || editing !== null;
  const { image, frame } = useAnnotatorImage(source, stageRef);
  const { draft, handlers } = useMarkPointer({
    tool,
    frame,
    shapes,
    composing,
    onHover: setHovered,
    onArrow: (arrow) => setShapes((current) => [...current, { kind: "arrow", ...arrow, text: "" }]),
    onBox: setPending,
  });
  usePaintedMarks(canvasRef, { image, frame, shapes, pending, draft, prefix });

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
  /** The box the note being typed belongs to: a rect just drawn, or one already on the image. */
  const composeAt = pending ?? (editing === null ? null : shapes[editing] ?? null);

  // Portalled to the body: the composer's stacking context sits below the topbar, which would paint over the overlay.
  return createPortal(
    <div ref={dialogRef} className="annotator" role="dialog" aria-modal="true" aria-label="Annotate screenshot" tabIndex={-1}>
      <div className="annotator-panel">
        <header className="annotator-head">
          <ToolPicker
            tool={tool}
            onPick={(picked) => {
              commitLabel();
              setTool(picked);
            }}
          />
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
                {...handlers}
              />
              {hovered !== null && shapes[hovered] && !composing && (
                <MarkTools
                  shape={shapes[hovered]}
                  frame={frame}
                  mark={`${prefix}${markNumber(hovered)}`}
                  onKeep={() => setHovered(hovered)}
                  onEdit={() => {
                    setLabel(shapes[hovered].text);
                    setEditing(hovered);
                    setHovered(null);
                  }}
                  onRemove={() => {
                    setShapes((current) => current.filter((_, at) => at !== hovered));
                    setHovered(null);
                  }}
                />
              )}
              {composeAt && (
                <MarkLabel
                  inputRef={labelRef}
                  box={composeAt}
                  frame={frame}
                  label={label}
                  onLabel={setLabel}
                  onCommit={commitLabel}
                  onClose={closeLabel}
                />
              )}
            </div>
          )}
          </div>
        </div>
        <footer className="annotator-bar">
          <span className="annotator-count">{shapes.length === 0 ? activeTool.hint : `${shapes.length} mark${shapes.length === 1 ? "" : "s"}. Point at one to edit or remove it.`}</span>
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
