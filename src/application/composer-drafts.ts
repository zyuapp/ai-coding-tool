/**
 * What a composer holds before a send: highlights taken from the transcript, blocks pasted in,
 * images grabbed or dropped, and files named by where they sit. Each is drafted per thread and
 * cleared by the send that carries it, so this is the one place their shapes and limits live.
 */
import { clampQuote } from "./annotations.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { AnnotationCommand, FileCommand, ImageCommand, PasteCommand } from "../contracts/commands.js";
import { MAX_ATTACHED_FILES, MAX_ATTACHMENTS, type Annotation, type AttachedFile, type AttachedFileDraft, type PastedText, type StagedImage } from "../domain/task.js";

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

/** The caret goes back to the composer, which is where anything arriving in a draft is spoken about. */
export function focusComposer(state: WorkspaceState): WorkspaceState {
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
  | AnnotationCommand
  | PasteCommand
  | ImageCommand
  | Extract<FileCommand, { type: "file.attach" | "file.detach" | "file.recall" }>;

/** Every change to one composer's drafts. `key` is the composer: a thread's id, or the draft's. */
export function composerDraft(state: WorkspaceState, input: ComposerDraftCommand, key: string): WorkspaceState {
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
      if (held.length >= MAX_ATTACHMENTS) return { ...state, actionError: TOO_MANY_IMAGES_ERROR };
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
      if (room <= 0) return { ...state, actionError: TOO_MANY_FILES_ERROR };
      const attached = withFiles(state, key, [...held, ...fresh.slice(0, room).map((file) => ({ id: crypto.randomUUID(), ...file }))]);
      if (fresh.length > room) return { ...attached, actionError: TOO_MANY_FILES_ERROR };
      /** A file only ever arrives to be asked about, so the caret goes where the question is typed. */
      return focusComposer(attached);
    }

    case "file.detach":
      return withFiles(state, key, filesFor(state, key).filter((item) => item.id !== input.fileId));

    case "file.recall":
      return withFiles(state, key, input.files);
  }
}
