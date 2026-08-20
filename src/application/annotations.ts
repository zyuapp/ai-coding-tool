import type { Annotation } from "../domain/task.js";

/** A quote longer than this is cut when the annotation is made, so a select-all cannot flood the prompt. */
export const ANNOTATION_QUOTE_LIMIT = 2000;

export function clampQuote(quote: string) {
  const trimmed = quote.trim();
  return trimmed.length > ANNOTATION_QUOTE_LIMIT ? `${trimmed.slice(0, ANNOTATION_QUOTE_LIMIT - 1)}…` : trimmed;
}

const ANNOTATION_HEADING = "Annotations on your earlier output (each quotes your words, then my note on them):";

/** How annotations reach the agent. The stored message keeps them structured; only the prompt is flat. */
export function promptWithAnnotations(text: string, annotations: Annotation[]) {
  if (annotations.length === 0) return text;
  const blocks = annotations.map((annotation) => {
    const quote = annotation.quote.split("\n").map((line) => `> ${line}`).join("\n");
    const note = annotation.note.trim();
    return note ? `${quote}\n${note}` : quote;
  });
  return [text, `${ANNOTATION_HEADING}\n\n${blocks.join("\n\n")}`].filter((part) => part.length > 0).join("\n\n");
}
