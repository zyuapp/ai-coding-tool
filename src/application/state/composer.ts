import type { Annotation, AttachedFile, PastedText, StagedImage } from "../../domain/conversation.js";
import type { ReadingPoint } from "../../contracts/commands.js";
import type { AttachmentSendState } from "../composer-attachments.js";
import type { AnnotationReveal } from "../composer-drafts.js";

/** What each composer holds before it sends, keyed by the thread it sends to. */
export type ComposerState = {
  prompts: Record<string, string>;
  /** Annotations waiting in each composer, keyed the way `prompts` is. */
  annotations: Record<string, Annotation[]>;
  /** Pasted blocks waiting in each composer, keyed the way `prompts` is. */
  pastes: Record<string, PastedText[]>;
  /** Images waiting in each composer, keyed the way `prompts` is. */
  images: Record<string, StagedImage[]>;
  /** Files and folders waiting in each composer, keyed the way `prompts` is. */
  files: Record<string, AttachedFile[]>;
  /** Bumped whenever something asks for the caret, which is all the composer needs to take it. */
  composerFocus: number;
  /** Where each thread was left reading, keyed by thread id. Session-only, and never persisted. */
  readingPoints: Record<string, ReadingPoint>;
  /** The drafted annotation a transcript was last asked to show, and a count bumped by each ask. Session-only. */
  annotationReveal: AnnotationReveal | null;
  /** Where each composer's images stand between its send and the run, keyed by the thread it sends to. */
  attachmentSends: Record<string, AttachmentSendState>;
};

export function initialComposerState(): ComposerState {
  return { prompts: {}, annotations: {}, pastes: {}, images: {}, files: {}, composerFocus: 0, readingPoints: {}, annotationReveal: null, attachmentSends: {} };
}

/** The new-thread composer's one draft, kept whichever project or computer it is pointed at. */
export const NEW_THREAD_DRAFT = "draft:";

export function withPrompt<State extends Pick<ComposerState, "prompts">>(state: State, key: string, prompt: string): State {
  if (prompt) return { ...state, prompts: { ...state.prompts, [key]: prompt } };
  const { [key]: _cleared, ...prompts } = state.prompts;
  return { ...state, prompts };
}

/** Whether two reading points name the same place, which decides whether a report is worth making. */
export function sameReadingPoint(a: ReadingPoint, b: ReadingPoint) {
  if (a === null || b === null) return a === b;
  return a.anchor === b.anchor && a.depth === b.depth;
}
