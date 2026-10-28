import { LuArrowUpRight as ArrowUpRight, LuCheck as Check, LuPencil as Pencil, LuSquarePen as SquarePen, LuUndo2 as Undo, LuX as X } from "react-icons/lu";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../focus";
import { MAC } from "../platform";
import { displayShortcut } from "../../domain/shortcuts";
import { shortcutTip } from "./TooltipLayer";
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

const tools: { value: AnnotationKind; label: string; key: string; hint: string; icon: typeof SquarePen }[] = [
  { value: "box", label: "Box", key: "b", hint: "Drag a box over the area you mean", icon: SquarePen },
  { value: "arrow", label: "Arrow", key: "a", hint: "Drag from anywhere to point at the area you mean", icon: ArrowUpRight },
];

/** Whether a key press belongs to a field being typed in rather than to the annotator. */
function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

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
            aria-keyshortcuts={entry.key.toUpperCase()}
            data-tip={shortcutTip(entry.label, entry.key.toUpperCase())}
            onClick={() => onPick(entry.value)}
          >
            <Icon size={16} aria-hidden="true" /> {entry.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What can be done to a mark, drawn off its far corner. Every mark carries them; the one last pointed
 * or walked to carries them in full, the rest faintly and outside the tab order, which the canvas walks.
 */
function MarkTools({ shape, frame, mark, picked, onKeep, onEdit, onRemove }: {
  shape: Annotation;
  frame: Frame;
  mark: string;
  picked: boolean;
  onKeep: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const tabIndex = picked ? undefined : -1;
  return (
    <div
      className={`annotator-marktools ${picked ? "picked" : ""}`.trimEnd()}
      style={{
        left: `${(shape.x + shape.width) * frame.width}px`,
        top: `${(shape.kind === "arrow" ? shape.y + shape.height : shape.y) * frame.height}px`,
      }}
      onPointerEnter={onKeep}
    >
      {shape.kind === "box" && (
        <button type="button" className="annotator-marktool" tabIndex={tabIndex} aria-label={`Edit note on mark ${mark}`} data-tip={shortcutTip("Edit note", "Enter")} onClick={onEdit}>
          <Pencil size={14} />
        </button>
      )}
      <button
        type="button"
        className="annotator-marktool remove"
        tabIndex={tabIndex}
        aria-label={shape.kind === "arrow" ? "Delete arrow" : `Delete mark ${mark}`}
        data-tip={shortcutTip("Delete", "Backspace")}
        onClick={onRemove}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** The note being typed, held under the box it belongs to. */
function MarkLabel({ box, frame, label, selected, onLabel, onCommit, onClose }: {
  box: Omit<Annotation, "kind" | "text">;
  frame: Frame;
  label: string;
  /** Set for a note already written, which is selected whole so typing replaces it. */
  selected: boolean;
  onLabel: (label: string) => void;
  onCommit: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    if (selected) inputRef.current?.select();
  }, []);
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

/** The marks, and every earlier set of them, newest last, so each change can be taken back. */
function useMarkHistory(annotations: Annotation[]) {
  const [shapes, setShapes] = useState(annotations);
  const [past, setPast] = useState<Annotation[][]>([]);
  return {
    shapes,
    changed: past.length > 0,
    change(next: Annotation[]) {
      setPast((earlier) => [...earlier, shapes]);
      setShapes(next);
    },
    undo() {
      const previous = past.at(-1);
      if (!previous) return false;
      setPast((earlier) => earlier.slice(0, -1));
      setShapes(previous);
      return true;
    },
  };
}

type Box = Omit<Annotation, "kind" | "text">;

/** The note being typed: onto a box just drawn, or onto one already on the image. */
function useMarkNote(shapes: Annotation[], change: (next: Annotation[]) => void) {
  const [pending, setPending] = useState<Box | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [label, setLabel] = useState("");

  function close() {
    setPending(null);
    setEditing(null);
    setLabel("");
  }

  function written(): Annotation[] | null {
    const text = label.trim();
    if (editing !== null) return shapes[editing] && shapes[editing].text !== text ? shapes.map((shape, index) => (index === editing ? { ...shape, text } : shape)) : null;
    return pending ? [...shapes, { kind: "box", ...pending, text }] : null;
  }

  return {
    pending,
    editing,
    label,
    setLabel,
    draw: setPending,
    composing: pending !== null || editing !== null,
    /** The box the note belongs to. */
    at: pending ?? (editing === null ? null : shapes[editing] ?? null),
    close,
    edit(index: number) {
      setLabel(shapes[index]?.text ?? "");
      setEditing(index);
    },
    /** The marks with the note being typed written in, or null when it changes nothing. */
    written,
    /** Writes the note onto its box; a box just drawn is kept even with no note. */
    commit() {
      if (pending === null && editing === null) return;
      const next = written();
      if (next) change(next);
      close();
    },
  };
}

/** Keys the whole annotator answers: Escape, undo, and a letter per tool. None of them reach a field being typed in. */
function useAnnotatorKeys({ composing, onEscape, onUndo, onTool }: {
  composing: boolean;
  onEscape: () => void;
  onUndo: () => void;
  onTool: (tool: AnnotationKind) => void;
}) {
  const latest = useRef({ composing, onEscape, onUndo, onTool });
  useLayoutEffect(() => {
    latest.current = { composing, onEscape, onUndo, onTool };
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const { composing, onEscape, onUndo, onTool } = latest.current;
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onEscape();
        return;
      }
      if (typing(event.target) || composing) return;
      if (event.key.toLowerCase() === "z" && (MAC ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        onUndo();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const picked = tools.find((entry) => entry.key === event.key.toLowerCase());
      if (picked) {
        event.preventDefault();
        onTool(picked.value);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}

function markHint(count: number, toolHint: string, canvasFocused: boolean) {
  if (count === 0) return toolHint;
  const marks = `${count} mark${count === 1 ? "" : "s"}.`;
  return canvasFocused ? `${marks} Arrow keys pick one, ${displayShortcut("Enter", MAC)} edits its note, ${displayShortcut("Backspace", MAC)} deletes it.` : marks;
}

/** Which mark an arrow key walks to from the one picked, wrapping at either end. */
function markStep(key: string, current: number | null, count: number) {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (!step) return null;
  return current === null ? (step > 0 ? 0 : count - 1) : (current + step + count) % count;
}

function AnnotatorFooter({ discarding, canUndo, hint, ready, onUndo, onKeep, onCancel, onDiscard, onDone }: {
  discarding: boolean;
  canUndo: boolean;
  hint: string;
  ready: boolean;
  onUndo: () => void;
  onKeep: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onDone: () => void;
}) {
  if (discarding) {
    return (
      <footer className="annotator-bar" role="alert">
        <span className="annotator-count">Discard the changes to these marks?</span>
        <button type="button" className="annotator-action" autoFocus onClick={onKeep}>Keep editing</button>
        <button type="button" className="annotator-action danger" onClick={onDiscard}>Discard</button>
      </footer>
    );
  }
  return (
    <footer className="annotator-bar">
      <button type="button" className="annotator-undo" aria-label="Undo" aria-keyshortcuts={MAC ? "Meta+Z" : "Control+Z"} data-tip={shortcutTip("Undo", "Mod+Z")} disabled={!canUndo} onClick={onUndo}>
        <Undo size={16} aria-hidden="true" />
      </button>
      <span className="annotator-count">{hint}</span>
      <button type="button" className="annotator-action" onClick={onCancel}>Cancel</button>
      <button type="button" className="annotator-action primary" disabled={!ready} onClick={onDone}>
        <Check size={16} /> Done
      </button>
    </footer>
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
  const [tool, setTool] = useState<AnnotationKind>("box");
  const history = useMarkHistory(annotations);
  const { shapes } = history;
  /** The mark last pointed at or walked to, until a change moves on. */
  const [hovered, setHovered] = useState<number | null>(null);
  /** The mark whose tools are showing: the one pointed at or walked to, else the newest. */
  const picked = hovered !== null && shapes[hovered] ? hovered : shapes.length ? shapes.length - 1 : null;
  const [canvasFocused, setCanvasFocused] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const note = useMarkNote(shapes, change);
  const { pending, editing, composing } = note;
  useModalFocus(dialogRef);
  const { image, frame } = useAnnotatorImage(source, stageRef);
  const { draft, handlers } = useMarkPointer({
    tool, frame, shapes, composing,
    onHover: (index) => { if (index !== null) setHovered(index); },
    onArrow: (arrow) => change([...shapes, { kind: "arrow", ...arrow, text: "" }]),
    onBox: note.draw,
  });
  usePaintedMarks(canvasRef, { image, frame, shapes, pending, draft, prefix });

  useAnnotatorKeys({
    composing,
    onEscape: () => {
      if (discarding) setDiscarding(false);
      else if (composing) note.close();
      else requestCancel();
    },
    onUndo: undo,
    onTool: setTool,
  });

  function change(next: Annotation[]) {
    history.change(next);
    setHovered(null);
    setDiscarding(false);
  }

  function undo() {
    if (history.undo()) setHovered(null);
  }

  function remove(index: number) {
    change(shapes.filter((_, at) => at !== index));
  }

  /** Closing throws the marks away, so marks changed since opening, or a note still being typed, are only dropped once confirmed. */
  function requestCancel() {
    if (!history.changed && !note.written()) onCancel();
    else setDiscarding(true);
  }

  /** Arrow keys walk the marks on the focused canvas; the walked-to mark takes Delete and Enter. */
  function canvasKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    if (composing || picked === null) return;
    const next = markStep(event.key, picked, shapes.length);
    if (next !== null) {
      event.preventDefault();
      setHovered(next);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      remove(picked);
    } else if (event.key === "Enter" && shapes[picked]!.kind === "box") {
      event.preventDefault();
      editMark(picked);
    }
  }

  function editMark(index: number) {
    note.edit(index);
    setHovered(null);
  }

  /** The number a box is drawn with, so what a control says matches what the screenshot shows. */
  function markNumber(index: number) {
    return shapes.slice(0, index + 1).filter((shape) => shape.kind === "box").length;
  }

  /** A note still being typed is part of what is applied. */
  function apply() {
    if (!image) return;
    const final = note.written() ?? shapes;
    onApply(final, renderAnnotated(image, final, prefix));
  }

  const activeTool = tools.find((entry) => entry.value === tool)!;

  // Portalled to the body: the composer's stacking context sits below the topbar, which would paint over the overlay.
  return createPortal(
    <div ref={dialogRef} className="annotator" role="dialog" aria-modal="true" aria-label="Annotate screenshot" tabIndex={-1}>
      <div className="annotator-panel">
        <header className="annotator-head">
          <ToolPicker
            tool={tool}
            onPick={(picked) => {
              note.commit();
              setTool(picked);
            }}
          />
          <button type="button" className="annotator-close" onClick={requestCancel} aria-label="Close annotator" data-tip={shortcutTip("Close", "Escape")}><X size={16} /></button>
        </header>
        <div className="annotator-stage">
          <div className="annotator-fit" ref={stageRef}>
          {image && frame.width > 0 && (
            <div
              className="annotator-frame"
              data-tool={tool}
              style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
            >
              <canvas
                ref={canvasRef}
                style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
                aria-label="Screenshot canvas"
                tabIndex={0}
                onKeyDown={canvasKeyDown}
                onFocus={() => setCanvasFocused(true)}
                onBlur={() => setCanvasFocused(false)}
                {...handlers}
              />
              {!composing && shapes.map((shape, index) => (
                <MarkTools
                  key={index}
                  shape={shape}
                  frame={frame}
                  mark={`${prefix}${markNumber(index)}`}
                  picked={index === picked}
                  onKeep={() => setHovered(index)}
                  onEdit={() => editMark(index)}
                  onRemove={() => remove(index)}
                />
              ))}
              {note.at && (
                <MarkLabel
                  box={note.at}
                  selected={editing !== null}
                  frame={frame}
                  label={note.label}
                  onLabel={note.setLabel}
                  onCommit={note.commit}
                  onClose={note.close}
                />
              )}
            </div>
          )}
          </div>
        </div>
        <AnnotatorFooter
          discarding={discarding}
          canUndo={history.changed}
          hint={markHint(shapes.length, activeTool.hint, canvasFocused)}
          ready={Boolean(image)}
          onUndo={undo}
          onKeep={() => setDiscarding(false)}
          onCancel={requestCancel}
          onDiscard={onCancel}
          onDone={apply}
        />
      </div>
    </div>,
    document.body,
  );
}
