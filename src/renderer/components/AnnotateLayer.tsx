import { LuCheck as Check, LuGitFork as GitFork, LuMessageSquareQuote as MessageSquareQuote, LuX as X } from "react-icons/lu";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Annotation } from "../../domain/conversation";
import type { AnnotationMarker, NoteDraft, Selected } from "../timeline/use-annotations";
import { MAC } from "../platform";
import { shortcutTip } from "./TooltipLayer";

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
      data-annotation-id={marker.id}
      style={{ left: marker.x, top: marker.y }}
      aria-label={`Edit annotation ${marker.number}`}
      data-tip="Edit annotation"
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

/** Keys a page already answers on the element that has focus. */
const ANSWERS_KEYS = "input, textarea, select, button, a[href], [contenteditable=''], [contenteditable='true'], [role='button'], [role='option'], [role='menuitem'], [role='tab']";

export function AnnotatePopover({ selection, toolbarRef, noteReturn, onNote, onSide }: PopoverProps) {
  const latest = useRef({ selection, onNote, onSide });
  useLayoutEffect(() => {
    latest.current = { selection, onNote, onSide };
  });
  /** Enter adds the selection to the chat and Mod+Enter to the side chat, so a selection made from the keyboard is annotated from it too. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || event.defaultPrevented || event.shiftKey || event.altKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest(ANSWERS_KEYS)) return;
      const { selection, onNote, onSide } = latest.current;
      const mod = MAC ? event.metaKey : event.ctrlKey;
      if (mod && !onSide) return;
      if (!mod && (event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      if (mod) onSide?.(selection);
      else {
        noteReturn.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        onNote(selection);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [noteReturn]);
  return createPortal(
    <div ref={toolbarRef} className="annotate-popover" role="toolbar" aria-label="Annotate selection" style={{ left: selection.x, top: selection.y }}>
      <button type="button" aria-keyshortcuts="Enter" data-tip={shortcutTip("Add to chat", "Enter")} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { noteReturn.current = event.currentTarget; onNote(selection); }}>
        <MessageSquareQuote size={14} aria-hidden="true" />Add to chat
      </button>
      {onSide && (
        <button type="button" aria-keyshortcuts={MAC ? "Meta+Enter" : "Control+Enter"} data-tip={shortcutTip("Add to side chat", "Mod+Enter")} onMouseDown={(event) => event.preventDefault()} onClick={() => onSide(selection)}>
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
        aria-label="Annotation note"
        onInput={(event) => onChange({ ...noting, note: event.currentTarget.value })}
        onKeyDown={(event) => {
          /** Both keys close the editor, and neither may go on to land in the composer behind it. */
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          if (event.key === "Enter") onCommit(noting);
          else onClose();
        }}
      />
      <button type="button" className="annotate-editor-save" aria-label="Save annotation" data-tip={shortcutTip("Save", "Enter")} onClick={() => onCommit(noting)}>
        <Check size={14} aria-hidden="true" />
      </button>
      {noting.annotationId && (
        <button
          type="button"
          className="annotate-editor-remove"
          aria-label="Remove annotation"
          data-tip="Remove"
          onClick={() => onRemove(noting.annotationId!)}
        >
          <X size={14} />
        </button>
      )}
    </div>,
    document.body,
  );
}
