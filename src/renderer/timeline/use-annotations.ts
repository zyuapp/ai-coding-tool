import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Annotation, AnnotationAnchor } from "../../domain/conversation";
import { useDismissibleLayer } from "../focus";
import { ANNOTATION_HIGHLIGHT, highlights, renderedOffset, renderedRange } from "./highlights";

/** Selected assistant text, held where it was selected so the popover can sit on it. */
export type Selected = { quote: string; anchor: AnnotationAnchor; x: number; y: number };

/** The note being written or rewritten at a highlight: for a new annotation, or an existing one. */
export type NoteDraft = { annotationId?: string; quote: string; anchor: AnnotationAnchor; note: string; x: number; y: number };

/** A numbered handle at the end of an anchored annotation, placed in the timeline's own terms. */
export type AnnotationMarker = { id: string; number: number; x: number; y: number };

type AnnotateHandlers = {
  onAnnotateAdd?: (draft: { quote: string; note: string; anchor: AnnotationAnchor }) => void;
  onAnnotateNote?: (annotationId: string, note: string) => void;
  onAnnotateRemove?: (annotationId: string) => void;
  onAnnotateSide?: (quote: string) => void;
};

/** The selection and the note being written on it, and every way either of them is put away. */
export function useAnnotationSelection({ onAnnotateAdd, onAnnotateNote, onAnnotateRemove, onAnnotateSide }: AnnotateHandlers) {
  const [selection, setSelection] = useState<Selected | null>(null);
  const [noting, setNoting] = useState<NoteDraft | null>(null);
  const selectionToolbar = useRef<HTMLDivElement>(null);
  const noteEditor = useRef<HTMLDivElement>(null);
  const noteReturn = useRef<HTMLElement>(null);
  useDismissibleLayer(selection !== null && noting === null, [selectionToolbar], () => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, null);
  useDismissibleLayer(noting !== null, [noteEditor], () => dismissNote(), noteReturn);

  function openNote(selected: Selected) {
    setNoting({ quote: selected.quote, anchor: selected.anchor, note: "", x: selected.x, y: selected.y });
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  function referToSide(selected: Selected) {
    onAnnotateSide?.(selected.quote);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }

  function commitNote(noted: NoteDraft) {
    if (noted.annotationId) onAnnotateNote?.(noted.annotationId, noted.note);
    else onAnnotateAdd?.({ quote: noted.quote, note: noted.note, anchor: noted.anchor });
    setNoting(null);
  }

  /**
   * A note the user has typed is work, and clicking back into the transcript is how they pick the
   * next thing to annotate. So anything that puts the editor away keeps what they wrote, and only
   * drops a note still empty. Escape throws it away, which is the one gesture that means "never mind".
   */
  function dismissNote() {
    if (noting && noting.note.trim()) commitNote(noting);
    else setNoting(null);
  }

  function removeNote(annotationId: string) {
    onAnnotateRemove?.(annotationId);
    setNoting(null);
  }

  return {
    selection, setSelection, noting, setNoting, selectionToolbar, noteEditor, noteReturn,
    openNote, referToSide, commitNote, dismissNote, removeNote, closeNote: () => setNoting(null),
  };
}

type CaptureOptions = {
  timelineRef: RefObject<HTMLDivElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  threadId?: string;
  onAnnotateAdd?: AnnotateHandlers["onAnnotateAdd"];
  setSelection: Dispatch<SetStateAction<Selected | null>>;
  /** Puts an open note away, keeping whatever the user had already typed into it. */
  dismissNote: () => void;
};

/**
 * The part of a selection that lies inside one message. A double click on a block's last word runs
 * the selection past the block and into whatever follows it, which under an answer is the answer's
 * own row of buttons. Clipping it keeps that click a selection of the word rather than of nothing.
 */
function clippedTo(message: Element, range: Range) {
  const bounds = document.createRange();
  bounds.selectNodeContents(message);
  const inside = range.cloneRange();
  if (inside.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) inside.setStart(bounds.startContainer, bounds.startOffset);
  if (inside.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) inside.setEnd(bounds.endContainer, bounds.endOffset);
  return inside;
}

/** Selected assistant text grows an annotate popover; anything else puts it away. */
export function useSelectionCapture({ timelineRef, scrollContainerRef, threadId, onAnnotateAdd, setSelection, dismissNote }: CaptureOptions) {
  useEffect(() => {
    if (!onAnnotateAdd) return;
    let frame = 0;
    const read = () => {
      const root = timelineRef.current;
      const selected = window.getSelection();
      if (!root || !selected || selected.isCollapsed || selected.rangeCount === 0) return setSelection(null);
      const range = selected.getRangeAt(0);
      /** A highlight lives in one message, so a selection is only offered within a single one. */
      const messageOf = (node: Node) => {
        const element = node instanceof Element ? node : node.parentElement;
        if (!element || !root.contains(element) || !element.closest(".message.assistant")) return null;
        return element.closest("[data-message-id]");
      };
      const startMessage = messageOf(range.startContainer);
      const endMessage = messageOf(range.endContainer);
      /** Two messages are two highlights, which is one more than an annotation can wear. */
      if (startMessage && endMessage && startMessage !== endMessage) return setSelection(null);
      const message = startMessage ?? endMessage;
      const messageId = message?.getAttribute("data-message-id");
      if (!message || !messageId) return setSelection(null);
      const inside = clippedTo(message, range);
      const quote = inside.toString().trim();
      if (!quote) return setSelection(null);
      const rect = inside.getBoundingClientRect();
      setSelection({
        quote,
        anchor: {
          kind: "message",
          messageId,
          start: renderedOffset(message, inside.startContainer, inside.startOffset),
          end: renderedOffset(message, inside.endContainer, inside.endOffset),
        },
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    };
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Shift" || event.shiftKey) settle();
    };
    document.addEventListener("pointerup", settle);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerup", settle);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [onAnnotateAdd]);

  /** Popovers sit where the selection was, so any scroll puts them away rather than leaving them adrift. */
  const putAway = useRef(dismissNote);
  putAway.current = dismissNote;
  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller || !onAnnotateAdd) return;
    const dismiss = () => {
      setSelection((current) => (current ? null : current));
      putAway.current();
    };
    scroller.addEventListener("scroll", dismiss, { passive: true });
    return () => scroller.removeEventListener("scroll", dismiss);
  }, [onAnnotateAdd, scrollContainerRef, threadId]);
}

type MarkerOptions = {
  timelineRef: RefObject<HTMLDivElement | null>;
  annotations: Annotation[];
  /** The rows on screen, so the markers are replaced whenever what holds them is redrawn. */
  rendered: string;
  messageCount: number;
};

/** Anchored annotations are painted as highlights, each with a numbered marker at its end. */
export function useAnnotationMarkers({ timelineRef, annotations, rendered, messageCount }: MarkerOptions) {
  const [markers, setMarkers] = useState<AnnotationMarker[]>([]);
  useEffect(() => {
    const registry = highlights();
    const timeline = timelineRef.current;
    registry?.delete(ANNOTATION_HIGHLIGHT);
    const ranges: Range[] = [];
    const placed: AnnotationMarker[] = [];
    if (timeline) {
      const timelineRect = timeline.getBoundingClientRect();
      annotations.forEach((annotation, index) => {
        if (annotation.anchor?.kind !== "message") return;
        const root = timeline.querySelector(`[data-message-id="${annotation.anchor.messageId}"]`);
        const range = root && renderedRange(root, annotation.anchor.start, annotation.anchor.end);
        if (!range) return;
        ranges.push(range);
        const rects = range.getClientRects();
        const tail = rects[rects.length - 1] ?? range.getBoundingClientRect();
        placed.push({ id: annotation.id, number: index + 1, x: tail.right - timelineRect.left, y: tail.top - timelineRect.top });
      });
    }
    if (registry && ranges.length) registry.set(ANNOTATION_HIGHLIGHT, new Highlight(...ranges));
    /** Placements repeat far more often than they move, so an unchanged set is not a render. */
    setMarkers((current) => {
      const same = current.length === placed.length && current.every((marker, index) => {
        const next = placed[index];
        return marker.id === next.id && marker.number === next.number && marker.x === next.x && marker.y === next.y;
      });
      return same ? current : placed;
    });
    return () => {
      registry?.delete(ANNOTATION_HIGHLIGHT);
    };
  }, [annotations, rendered, messageCount]);
  return markers;
}
