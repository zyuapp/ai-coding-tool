import { LuGitFork as GitFork, LuMessageSquareQuote as MessageSquareQuote, LuX as X } from "react-icons/lu";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import type { Annotation } from "../../domain/task";
import type { AnnotationMarker, NoteDraft, Selected } from "../timeline/use-annotations";

type MarkersProps = {
  markers: AnnotationMarker[];
  annotations: Annotation[];
  /** The marker a note was opened from, which takes focus back when the editor closes. */
  noteReturn: RefObject<HTMLElement | null>;
  onEdit: (note: NoteDraft) => void;
};

export function AnnotationMarkers({ markers, annotations, noteReturn, onEdit }: MarkersProps) {
  return markers.map((marker) => (
    <button
      type="button"
      key={marker.id}
      className="annotation-marker"
      style={{ left: marker.x, top: marker.y }}
      aria-label={`Edit annotation ${marker.number}`}
      onClick={(event) => {
        const annotation = annotations.find((item) => item.id === marker.id);
        if (annotation?.anchor?.kind !== "message") return;
        const rect = event.currentTarget.getBoundingClientRect();
        noteReturn.current = event.currentTarget;
        onEdit({ annotationId: annotation.id, quote: annotation.quote, anchor: annotation.anchor, note: annotation.note, x: rect.left + rect.width / 2, y: rect.top });
      }}
    >
      {marker.number}
    </button>
  ));
}

type PopoverProps = {
  selection: Selected;
  toolbarRef: RefObject<HTMLDivElement | null>;
  noteReturn: RefObject<HTMLElement | null>;
  onNote: (selected: Selected) => void;
  onSide?: (selected: Selected) => void;
};

export function AnnotatePopover({ selection, toolbarRef, noteReturn, onNote, onSide }: PopoverProps) {
  return createPortal(
    <div ref={toolbarRef} className="annotate-popover" role="toolbar" aria-label="Annotate selection" style={{ left: selection.x, top: selection.y }}>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { noteReturn.current = event.currentTarget; onNote(selection); }}>
        <MessageSquareQuote size={14} aria-hidden="true" />Add to chat
      </button>
      {onSide && (
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onSide(selection)}>
          <GitFork size={14} aria-hidden="true" />Add to side chat
        </button>
      )}
    </div>,
    document.body,
  );
}

type NoteEditorProps = {
  noting: NoteDraft;
  editorRef: RefObject<HTMLDivElement | null>;
  onChange: (note: NoteDraft) => void;
  onCommit: (note: NoteDraft) => void;
  onClose: () => void;
  onRemove: (annotationId: string) => void;
};

export function NoteEditor({ noting, editorRef, onChange, onCommit, onClose, onRemove }: NoteEditorProps) {
  return createPortal(
    <div ref={editorRef} className="annotate-editor" role="dialog" aria-label={noting.annotationId ? "Edit annotation" : "New annotation"} style={{ left: noting.x, top: noting.y }}>
      <input
        autoFocus
        value={noting.note}
        placeholder="Annotate…"
        onInput={(event) => onChange({ ...noting, note: event.currentTarget.value })}
        onKeyDown={(event) => {
          /** Both keys close the editor, and neither may go on to land in the composer behind it. */
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          if (event.key === "Enter") onCommit(noting);
          else onClose();
        }}
      />
      {noting.annotationId && (
        <button
          type="button"
          aria-label="Remove annotation"
          onClick={() => onRemove(noting.annotationId!)}
        >
          <X size={13} />
        </button>
      )}
    </div>,
    document.body,
  );
}
