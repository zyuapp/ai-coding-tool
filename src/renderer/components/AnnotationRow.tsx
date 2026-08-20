import { TextQuote, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Annotation } from "../../domain/task";

/** The annotations waiting in a composer: each one's quote, an editable note, and a way out. */
export function AnnotationRow({ annotations, onNote, onRemove }: {
  annotations: Annotation[];
  onNote: (annotationId: string, note: string) => void;
  onRemove: (annotationId: string) => void;
}) {
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  const seen = useRef(new Set(annotations.map((annotation) => annotation.id)));

  /** A freshly added annotation takes the caret, so the note can be typed straight away. */
  useEffect(() => {
    const fresh = annotations.filter((annotation) => !seen.current.has(annotation.id));
    seen.current = new Set(annotations.map((annotation) => annotation.id));
    const newest = fresh.at(-1);
    if (newest) fields.current.get(newest.id)?.focus();
  }, [annotations]);

  if (annotations.length === 0) return null;

  return (
    <div className="annotation-row" role="list" aria-label="Annotations">
      {annotations.map((annotation, index) => (
        <div className="annotation-chip" role="listitem" key={annotation.id}>
          <TextQuote className="annotation-mark" size={14} aria-hidden="true" />
          <div className="annotation-body">
            <blockquote className="annotation-quote">{annotation.quote}</blockquote>
            <textarea
              className="annotation-note"
              rows={1}
              placeholder="Add a note…"
              value={annotation.note}
              ref={(element) => {
                if (element) fields.current.set(annotation.id, element);
                else fields.current.delete(annotation.id);
              }}
              onChange={(event) => onNote(annotation.id, event.target.value)}
            />
          </div>
          <button type="button" className="annotation-remove" aria-label={`Remove annotation ${index + 1}`} onClick={() => onRemove(annotation.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
