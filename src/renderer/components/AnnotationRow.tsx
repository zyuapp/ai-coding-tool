import { LuPencil as Pencil } from "react-icons/lu";
import { useEffect, useId, useRef, useState } from "react";
import type { Annotation } from "../../domain/conversation";
import "../ui/glass.css";
import { AttachedPill, AttachedRow } from "./AttachedPill";

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
function AnnotationCard({ annotation, index, id }: { annotation: Annotation; index: number; id: string }) {
  const note = annotation.note.trim();
  const [quote, quoteClamped] = useClamped(annotation.quote);
  const [written, noteClamped] = useClamped(note);

  return (
    <span className="glass-float annotation-card" id={id} role="tooltip">
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
function AnnotationPill({ annotation, index, onRemove, onReveal }: {
  annotation: Annotation;
  index: number;
  onRemove?: ((annotationId: string) => void) | undefined;
  onReveal?: ((annotationId: string) => void) | undefined;
}) {
  const cardId = useId();
  const note = annotation.note.trim();
  const revealable = Boolean(onReveal) && annotation.anchor?.kind === "message";
  const face = (
    <>
      <span className="annotation-pill-number">{index + 1}</span>
      <span className="annotation-pill-label">
        {note || <span className="annotation-pill-quote">“{annotation.quote}</span>}
      </span>
    </>
  );

  return (
    <AttachedPill
      className="annotation-pill"
      tone="info"
      removeLabel={`Remove annotation ${index + 1}`}
      removeClassName="annotation-pill-remove"
      onRemove={onRemove && (() => onRemove(annotation.id))}
      after={<AnnotationCard annotation={annotation} index={index} id={cardId} />}
    >
      {revealable ? (
        <button type="button" className="attached-pill-face annotation-pill-face" aria-label={`Show annotation ${index + 1}`} aria-describedby={cardId} onClick={() => onReveal?.(annotation.id)}>{face}</button>
      ) : (
        <span className="attached-pill-face annotation-pill-face" tabIndex={0} aria-label={`Annotation ${index + 1}`} aria-describedby={cardId}>{face}</span>
      )}
    </AttachedPill>
  );
}

/** Annotations as numbered pills: removable and revealable while drafted in a composer, read-only on a sent message. */
export function AnnotationRow({ annotations, onRemove, onReveal }: {
  annotations: Annotation[];
  onRemove?: (annotationId: string) => void;
  /** Shows a drafted annotation's passage in the transcript it was taken from. */
  onReveal?: (annotationId: string) => void;
}) {
  if (annotations.length === 0) return null;

  return (
    <AttachedRow className="annotation-row" label="Annotations">
      {annotations.map((annotation, index) => (
        <AnnotationPill key={annotation.id} annotation={annotation} index={index} onRemove={onRemove} onReveal={onReveal} />
      ))}
    </AttachedRow>
  );
}
