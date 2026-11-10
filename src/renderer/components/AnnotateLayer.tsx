import { LuCheck as Check, LuGitFork as GitFork, LuMessageSquareQuote as MessageSquareQuote, LuX as X } from "react-icons/lu";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Annotation } from "../../domain/conversation";
import type { AnnotationMarker, NoteDraft, Selected } from "../timeline/use-annotations";
import { modHeld, platformCapabilities } from "../platform";
import { shortcutTip } from "./TooltipLayer";
import { Button, IconButton } from "../ui/Button";
import "../ui/glass.css";

type MarkersProps = {
  markers: AnnotationMarker[];
  annotations: Annotation[];
  /** The marker a note was opened from, which takes focus back when the editor closes. */
  noteReturn: RefObject<HTMLElement | null>;
  onEdit: (note: NoteDraft) => void;
  /** The marker a reveal is flashing. */
  flashing?: string | null;
};

export function AnnotationMarkers({ markers, annotations, noteReturn, onEdit, flashing = null }: MarkersProps) {
  return markers.map((marker) => (
    <button
      type="button"
      key={marker.id}
      className={marker.id === flashing ? "annotation-marker flash" : "annotation-marker"}
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
      const mod = modHeld(event);
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
    <div ref={toolbarRef} className="glass-capsule annotate-popover" role="toolbar" aria-label="Annotate selection" style={{ left: selection.x, top: selection.y }}>
      <Button variant="ghost" pill icon={<MessageSquareQuote size={14} aria-hidden="true" />} aria-keyshortcuts="Enter" data-tip={shortcutTip("Add to chat", "Enter")} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { noteReturn.current = event.currentTarget; onNote(selection); }}>
        Add to chat
      </Button>
      {onSide && (
        <Button variant="ghost" pill icon={<GitFork size={14} aria-hidden="true" />} aria-keyshortcuts={`${platformCapabilities().modKey}+Enter`} data-tip={shortcutTip("Add to side chat", "Mod+Enter")} onMouseDown={(event) => event.preventDefault()} onClick={() => onSide(selection)}>
          Add to side chat
        </Button>
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
    <div ref={editorRef} className="glass-capsule annotate-editor" role="dialog" aria-label={noting.annotationId ? "Edit annotation" : "New annotation"} style={{ left: noting.x, top: noting.y }}>
      <input
        autoFocus
        value={noting.note}
        placeholder="Add a note"
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
      <Button className="annotate-editor-save" variant="primary" pill icon={<Check size={14} aria-hidden="true" />} aria-label="Save annotation" data-tip={shortcutTip("Save", "Enter")} onClick={() => onCommit(noting)} />
      {noting.annotationId && (
        <IconButton className="annotate-editor-remove" variant="danger" round label="Remove annotation" tip="Remove" onClick={() => onRemove(noting.annotationId!)}>
          <X size={14} />
        </IconButton>
      )}
    </div>,
    document.body,
  );
}
