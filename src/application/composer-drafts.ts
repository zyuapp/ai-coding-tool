/**
 * What a composer holds before a send: highlights taken from the transcript, blocks pasted in,
 * images grabbed or dropped, and files named by where they sit. Each is drafted per thread and
 * cleared by the send that carries it, so this is the one place their shapes and limits live.
 */
import { clampQuote } from "./annotations.js";
import type { WorkspaceState } from "./workspace-state.js";
import { withPrompt, type ComposerState } from "./state/composer.js";
import type { AttachmentSendState } from "./composer-attachments.js";
import type { AnnotationCommand, FileCommand, ImageCommand, PasteCommand } from "../contracts/commands.js";
import { MAX_ATTACHED_FILES, MAX_ATTACHMENTS, type Annotation, type AttachedFile, type AttachedFileDraft, type PastedText, type StagedImage } from "../domain/conversation.js";

/** The composers as one input leaves them. Only the functions here make one, so a slice changes a composer through them. */
class ComposerChange {
  private declare readonly owned: never;
  constructor(readonly view: ComposerState) {}
}

export type ComposerEdit = ComposerChange;

export function composerOf(state: ComposerState): ComposerEdit {
  const { prompts, annotations, pastes, images, files, composerFocus, readingPoints, annotationReveal, attachmentSends } = state;
  return new ComposerChange({ prompts, annotations, pastes, images, files, composerFocus, readingPoints, annotationReveal, attachmentSends });
}

export function withPromptIn(edit: ComposerEdit, key: string, prompt: string): ComposerEdit {
  return new ComposerChange(withPrompt(edit.view, key, prompt));
}

export function focusComposerIn(edit: ComposerEdit): ComposerEdit {
  return new ComposerChange(focusComposer(edit.view));
}

/** Where one composer's send stands, which also carries what a recording into it has to say. */
export function withAttachmentSendIn(edit: ComposerEdit, key: string, send: AttachmentSendState): ComposerEdit {
  return new ComposerChange({ ...edit.view, attachmentSends: { ...edit.view.attachmentSends, [key]: send } });
}

const TOO_MANY_IMAGES_ERROR = `You can attach up to ${MAX_ATTACHMENTS} images.`;
const TOO_MANY_FILES_ERROR = `You can attach up to ${MAX_ATTACHED_FILES} files.`;

/** Nothing drafted, shared by every empty composer so a read never makes a new array. */
const NO_DRAFTS: never[] = [];

function draftsFor<T>(held: Record<string, T[]>, key: string): T[] {
  return held[key] ?? NO_DRAFTS;
}

/** One composer's drafts of one kind, with the whole entry dropped once nothing is left in it. */
function withDrafts<T>(held: Record<string, T[]>, key: string, drafted: T[]): Record<string, T[]> {
  if (drafted.length) return { ...held, [key]: drafted };
  const { [key]: _cleared, ...remaining } = held;
  return remaining;
}

export function annotationsFor(state: Pick<WorkspaceState, "annotations">, key: string): Annotation[] {
  return draftsFor(state.annotations, key);
}

export function withAnnotations(state: WorkspaceState, key: string, annotations: Annotation[]): WorkspaceState {
  return { ...state, annotations: withDrafts(state.annotations, key, annotations) };
}

/** A transcript asked to show one of its drafted annotations. Each ask bumps `count`, which is what the transcript answers. */
export type AnnotationReveal = { taskId: string; annotationId: string; messageId: string; count: number };

/** The reveal meant for the transcript a composer drafts into, so no other transcript scrolls to it. */
export function annotationRevealFor(state: Pick<WorkspaceState, "annotationReveal">, key: string): AnnotationReveal | null {
  return state.annotationReveal?.taskId === key ? state.annotationReveal : null;
}

/** Asks the transcript that drafted an annotation to show its passage. One with no passage there is left alone. */
export function revealAnnotation(state: WorkspaceState, key: string, annotationId: string): WorkspaceState {
  const anchor = annotationsFor(state, key).find((item) => item.id === annotationId)?.anchor;
  if (anchor?.kind !== "message") return state;
  return { ...state, annotationReveal: { taskId: key, annotationId, messageId: anchor.messageId, count: (state.annotationReveal?.count ?? 0) + 1 } };
}

export function pastesFor(state: Pick<WorkspaceState, "pastes">, key: string): PastedText[] {
  return draftsFor(state.pastes, key);
}

export function withPastes(state: WorkspaceState, key: string, pastes: PastedText[]): WorkspaceState {
  return { ...state, pastes: withDrafts(state.pastes, key, pastes) };
}

export function imagesFor(state: Pick<WorkspaceState, "images">, key: string): StagedImage[] {
  return draftsFor(state.images, key);
}

export function withImages(state: WorkspaceState, key: string, images: StagedImage[]): WorkspaceState {
  return { ...state, images: withDrafts(state.images, key, images) };
}

export function filesFor(state: Pick<WorkspaceState, "files">, key: string): AttachedFile[] {
  return draftsFor(state.files, key);
}

export function withFiles(state: WorkspaceState, key: string, files: AttachedFile[]): WorkspaceState {
  return { ...state, files: withDrafts(state.files, key, files) };
}

/** What a composer keeps once `sent` has gone: whatever was typed after it, or all of it if it was rewritten meanwhile. */
export function textAfterSend(typed: string, sent: string): string {
  return typed === sent ? "" : typed.startsWith(sent) ? typed.slice(sent.length).trimStart() : typed;
}

/** The caret goes back to the composer, which is where anything arriving in a draft is spoken about. */
export function focusComposer<S extends Pick<WorkspaceState, "composerFocus">>(state: S): S {
  return { ...state, composerFocus: state.composerFocus + 1 };
}

/** An image the app already holds, put back in a composer. What it is of is lost with the send. */
function stagedImage(path: string): StagedImage {
  return { id: crypto.randomUUID(), path, label: "" };
}

/** Files dropped or pasted at once, less the ones this composer already holds and any repeat. */
function freshFiles(held: AttachedFile[], arriving: AttachedFileDraft[]) {
  return arriving.filter((file, index) => file.path && file.name
    && !held.some((item) => item.path === file.path)
    && arriving.findIndex((item) => item.path === file.path) === index);
}

export type ComposerDraftCommand =
  | Exclude<AnnotationCommand, { type: "annotation.reveal" }>
  | PasteCommand
  | ImageCommand
  | Extract<FileCommand, { type: "file.attach" | "file.detach" | "file.recall" }>;

/** Every change to one composer's drafts, or why the change is refused. `key` is the composer: a thread's id, or the draft's. */
export function draftedComposer(state: WorkspaceState, input: ComposerDraftCommand, key: string): WorkspaceState | { state: WorkspaceState; error: string } {
  switch (input.type) {
    case "annotation.add": {
      const quote = clampQuote(input.quote);
      if (!quote) return state;
      return withAnnotations(state, key, [...annotationsFor(state, key), { id: crypto.randomUUID(), quote, note: input.note ?? "", ...(input.anchor ? { anchor: input.anchor } : {}) }]);
    }

    case "annotation.note":
      return withAnnotations(state, key, annotationsFor(state, key).map((item) => item.id === input.annotationId ? { ...item, note: input.note } : item));

    case "annotation.remove":
      return withAnnotations(state, key, annotationsFor(state, key).filter((item) => item.id !== input.annotationId));

    case "annotation.recall":
      return withAnnotations(state, key, input.annotations);

    case "paste.add":
      if (!input.text) return state;
      return withPastes(state, key, [...pastesFor(state, key), { id: crypto.randomUUID(), text: input.text }]);

    case "paste.remove":
      return withPastes(state, key, pastesFor(state, key).filter((item) => item.id !== input.pasteId));

    case "paste.recall":
      return withPastes(state, key, input.pastes);

    case "image.add": {
      const held = imagesFor(state, key);
      if (!input.path) return state;
      /** The same file dropped twice is the same one image, however many copies of it the app holds. */
      if (input.source && held.some((image) => image.source === input.source)) return state;
      if (held.length >= MAX_ATTACHMENTS) return { state, error: TOO_MANY_IMAGES_ERROR };
      /** An image only ever arrives to be captioned, so the caret goes where the caption is typed. */
      return focusComposer(withImages(state, key, [...held, { id: crypto.randomUUID(), path: input.path, label: input.label, ...(input.source ? { source: input.source } : {}) }]));
    }

    case "image.remove":
      return withImages(state, key, imagesFor(state, key).filter((item) => item.id !== input.imageId));

    case "image.recall":
      return withImages(state, key, input.paths.map((path) => stagedImage(path)));

    case "file.attach": {
      const held = filesFor(state, key);
      const fresh = freshFiles(held, input.files);
      if (fresh.length === 0) return state;
      const room = MAX_ATTACHED_FILES - held.length;
      if (room <= 0) return { state, error: TOO_MANY_FILES_ERROR };
      const attached = withFiles(state, key, [...held, ...fresh.slice(0, room).map((file) => ({ id: crypto.randomUUID(), ...file }))]);
      if (fresh.length > room) return { state: attached, error: TOO_MANY_FILES_ERROR };
      /** A file only ever arrives to be asked about, so the caret goes where the question is typed. */
      return focusComposer(attached);
    }

    case "file.detach":
      return withFiles(state, key, filesFor(state, key).filter((item) => item.id !== input.fileId));

    case "file.recall":
      return withFiles(state, key, input.files);
  }
}
