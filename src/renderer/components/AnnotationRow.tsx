import { TextQuote, X } from "lucide-react";
import type { Annotation } from "../../domain/task";

/** What a pill says on hover: the quote, and the note when one was taken. */
function pillTitle(annotation: Annotation) {
  const note = annotation.note.trim();
  return note ? `“${annotation.quote}”\n— ${note}` : `“${annotation.quote}”`;
}

/** The annotations waiting in a composer, as numbered pills. Notes are edited at their highlight. */
export function AnnotationRow({ annotations, onRemove }: {
  annotations: Annotation[];
  onRemove: (annotationId: string) => void;
}) {
  if (annotations.length === 0) return null;

  return (
    <div className="annotation-row" role="list" aria-label="Annotations">
      {annotations.map((annotation, index) => (
        <span className="annotation-pill" role="listitem" key={annotation.id} title={pillTitle(annotation)}>
          <TextQuote size={12} aria-hidden="true" />
          <span className="annotation-pill-number">{index + 1}</span>
          <button type="button" aria-label={`Remove annotation ${index + 1}`} onClick={() => onRemove(annotation.id)}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
