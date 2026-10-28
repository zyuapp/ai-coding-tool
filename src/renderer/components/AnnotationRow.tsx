import { LuPencil as Pencil, LuX as X } from "react-icons/lu";
import { useEffect, useId, useRef, useState } from "react";
import type { Annotation } from "../../domain/conversation";

/** Whether a clamped or ellipsized element cuts its text, so what stands in for the rest only shows when there is a rest. */
export function useClamped<T extends HTMLElement = HTMLSpanElement>(text: string) {
  const ref = useRef<T>(null);
  const [clamped, setClamped] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return [ref, clamped] as const;
}

/** The card a pill raises on hover or keyboard focus: which annotation, what was quoted, what the user wrote. */
function AnnotationCard({ annotation, index, id, revealable }: { annotation: Annotation; index: number; id: string; revealable: boolean }) {
  const note = annotation.note.trim();
  const [quote, quoteClamped] = useClamped(annotation.quote);
  const [written, noteClamped] = useClamped(note);

  return (
    <span className="annotation-card" id={id} role="tooltip">
      <span className="annotation-card-head">
        <span className="annotation-pill-number">{index + 1}</span>
        Annotation
        {revealable && <span className="annotation-card-hint">Click to show in transcript</span>}
      </span>
      <span className="annotation-card-body">
        <span ref={quote} className="annotation-card-quote" data-clamped={quoteClamped || undefined}>{annotation.quote}</span>
        {note ? (
          <span className="annotation-card-note">
            <Pencil size={12} aria-hidden="true" />
            <span ref={written} data-clamped={noteClamped || undefined}>{note}</span>
          </span>
        ) : (
          <span className="annotation-card-note empty">No note taken.</span>
        )}
      </span>
    </span>
  );
}

const FLASH_MS = 1800;

/** Brings a drafted annotation's marker into view in the transcript and flashes it. */
function revealPassage(annotation: Annotation) {
  if (annotation.anchor?.kind !== "message") return;
  const { messageId } = annotation.anchor;
  const marker = () => [...document.querySelectorAll<HTMLElement>(".annotation-marker")].find((element) => element.dataset.annotationId === annotation.id);
  const target = marker() ?? [...document.querySelectorAll<HTMLElement>("[data-message-id]")].find((element) => element.dataset.messageId === messageId);
  target?.scrollIntoView({ block: "center" });
  requestAnimationFrame(() => {
    const found = marker();
    if (!found) return;
    found.classList.add("flash");
    setTimeout(() => found.classList.remove("flash"), FLASH_MS);
  });
}

/** One annotation at rest: its number, then the note the user wrote, falling back to the quote. */
function AnnotationPill({ annotation, index, onRemove }: {
  annotation: Annotation;
  index: number;
  onRemove?: (annotationId: string) => void;
}) {
  const cardId = useId();
  const note = annotation.note.trim();
  const revealable = annotation.anchor?.kind === "message";
  const face = (
    <>
      <span className="annotation-pill-number">{index + 1}</span>
      <span className="annotation-pill-label">
        {note || <span className="annotation-pill-quote">“{annotation.quote}</span>}
      </span>
    </>
  );

  return (
    <span className="annotation-pill" role="listitem">
      {revealable ? (
        <button type="button" className="annotation-pill-face" aria-label={`Show annotation ${index + 1}`} aria-describedby={cardId} onClick={() => revealPassage(annotation)}>{face}</button>
      ) : (
        <span className="annotation-pill-face" tabIndex={0} aria-label={`Annotation ${index + 1}`} aria-describedby={cardId}>{face}</span>
      )}
      {onRemove && (
        <button type="button" className="annotation-pill-remove" aria-label={`Remove annotation ${index + 1}`} data-tip="Remove" onClick={() => onRemove(annotation.id)}>
          <X size={12} />
        </button>
      )}
      <AnnotationCard annotation={annotation} index={index} id={cardId} revealable={revealable} />
    </span>
  );
}

/** Annotations as numbered pills: removable while drafted in a composer, read-only on a sent message. */
export function AnnotationRow({ annotations, onRemove }: {
  annotations: Annotation[];
  onRemove?: (annotationId: string) => void;
}) {
  if (annotations.length === 0) return null;

  return (
    <div className="annotation-row" role="list" aria-label="Annotations">
      {annotations.map((annotation, index) => (
        <AnnotationPill key={annotation.id} annotation={annotation} index={index} onRemove={onRemove} />
      ))}
    </div>
  );
}
