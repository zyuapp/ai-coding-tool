import { LuPencil as Pencil, LuX as X } from "react-icons/lu";
import { useEffect, useId, useRef, useState } from "react";
import type { Annotation } from "../../domain/task";

/** Whether a line-clamped element cuts its text, so the fade only covers text that is really there. */
function useClamped(text: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clamped, setClamped] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setClamped(element.scrollHeight > element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return [ref, clamped] as const;
}

/** The card a pill raises on hover or keyboard focus: which annotation, what was quoted, what the user wrote. */
function AnnotationCard({ annotation, index, id }: { annotation: Annotation; index: number; id: string }) {
  const note = annotation.note.trim();
  const [quote, quoteClamped] = useClamped(annotation.quote);
  const [written, noteClamped] = useClamped(note);

  return (
    <span className="annotation-card" id={id} role="tooltip">
      <span className="annotation-card-head">
        <span className="annotation-pill-number">{index + 1}</span>
        Annotation
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

/** One annotation at rest: its number, then the note the user wrote, falling back to the quote. */
function AnnotationPill({ annotation, index, onRemove }: {
  annotation: Annotation;
  index: number;
  onRemove?: (annotationId: string) => void;
}) {
  const cardId = useId();
  const note = annotation.note.trim();

  return (
    <span className="annotation-pill" role="listitem" tabIndex={0} aria-label={`Annotation ${index + 1}`} aria-describedby={cardId}>
      <span className="annotation-pill-number">{index + 1}</span>
      <span className="annotation-pill-label">
        {note || <span className="annotation-pill-quote">“{annotation.quote}</span>}
      </span>
      {onRemove && (
        <button type="button" aria-label={`Remove annotation ${index + 1}`} onClick={() => onRemove(annotation.id)}>
          <X size={12} />
        </button>
      )}
      <AnnotationCard annotation={annotation} index={index} id={cardId} />
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
