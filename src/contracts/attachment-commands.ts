import type { Annotation, AnnotationAnchor, AttachedFile, AttachedFileDraft, PastedText } from "../domain/conversation.js";
import { isImageSource } from "../domain/message-artifacts.js";
import { array, literals, number, object, optional, optionalText, record, step, text, type Declarations, type Validator } from "./command-declaration.js";
import * as phone from "./phone-commands.js";

/**
 * Highlights of the assistant's output waiting in a composer, kept as drafts are: per task, with the
 * chat id as the `taskId` for a side chat's composer. They ride the next send and are cleared by it.
 */
export type AnnotationCommand =
  /** Without an `anchor` the quote is a bare reference: no highlight marks it and no note is taken on it. */
  | { type: "annotation.add"; taskId?: string; quote: string; note?: string; anchor?: AnnotationAnchor }
  | { type: "annotation.note"; taskId?: string; annotationId: string; note: string }
  | { type: "annotation.remove"; taskId?: string; annotationId: string }
  | { type: "annotation.recall"; taskId?: string; annotations: Annotation[] }
  /** Scrolls the transcript that drafted the annotation to its passage and flashes its marker. */
  | { type: "annotation.reveal"; taskId?: string; annotationId: string };

/**
 * Text pasted into a composer, kept aside as a pill instead of filling the prompt. Drafted the way
 * annotations are: per task, cleared by the send that carries them.
 */
export type PasteCommand =
  | { type: "paste.add"; taskId?: string; text: string }
  | { type: "paste.remove"; taskId?: string; pasteId: string }
  | { type: "paste.recall"; taskId?: string; pastes: PastedText[] };

/**
 * An image waiting in a composer, already on disk. Drafted the way pastes are: per task, cleared by
 * the send that carries it.
 */
export type ImageCommand =
  | { type: "image.add"; taskId?: string; path: string; label: string; source?: string }
  | { type: "image.remove"; taskId?: string; imageId: string }
  /** Images offered back with a sent message, named by where the app keeps them. */
  | { type: "image.recall"; taskId?: string; paths: string[] };

/** Enlarges a picture without changing a composer's attachments. `gallery` holds its neighbours, in order, for stepping through. */
export type ImageViewCommand =
  | { type: "image.open"; source: string; gallery?: string[] }
  | { type: "image.step"; delta: -1 | 1 }
  | { type: "image.close" }
  | { type: "image.download" };

/**
 * A file named in a message, opened in whatever the desktop opens that kind of file with. Relative
 * paths are read against the thread's own checkout, so only files that thread can see ever open.
 */
export type FileCommand =
  | { type: "file.open"; taskId?: string; path: string; line?: number }
  /**
   * Files and folders dropped or pasted into a composer, held aside as pills. Drafted the way pastes
   * are: per task, cleared by the send that carries them.
   */
  | { type: "file.attach"; taskId?: string; files: AttachedFileDraft[] }
  | { type: "file.detach"; taskId?: string; fileId: string }
  | { type: "file.recall"; taskId?: string; files: AttachedFile[] };

const imageGallery: Validator<string[]> = (value): value is string[] => array(isImageSource)(value) && value.length <= 500;
const pastedText = object<PastedText>({ id: text, text });
const attachedFileDraft = object<AttachedFileDraft>({ path: text, name: text, folder: optional(literals(true)) });
const attachedFile = object<AttachedFile>({ id: text, path: text, name: text, folder: optional(literals(true)) });
const annotation = object<Annotation>({ id: text, quote: text, note: text, anchor: optional(isAnnotationAnchor) });

function isAnnotationAnchor(value: unknown): value is AnnotationAnchor {
  if (!record(value)) return false;
  if (value.kind === "message") return text(value.messageId) && number(value.start) && number(value.end);
  if (value.kind === "diff") return text(value.comparison) && text(value.path) && text(value.start) && text(value.end) && (value.side === "old" || value.side === "new");
  return false;
}

const MAX_QUOTE_LENGTH = 100_000;
/** How many drafted annotations or pastes one recall may carry. */
const MAX_RECALL = 100;

function isAnchor(value: unknown): value is AnnotationAnchor {
  if (!phone.isRecord(value)) return false;
  if (value.kind === "message") return phone.isString(value.messageId) && phone.isCount(value.start) && phone.isCount(value.end);
  if (value.kind !== "diff") return false;
  return phone.isString(value.comparison, 4_096)
    && phone.isString(value.path, 4_096)
    && phone.isString(value.start)
    && phone.isString(value.end)
    && (value.side === "old" || value.side === "new");
}

function isAnnotation(value: unknown): value is Annotation {
  if (!phone.isRecord(value)) return false;
  return phone.isString(value.id)
    && phone.isString(value.quote, MAX_QUOTE_LENGTH)
    && phone.isBlankable(value.note, MAX_QUOTE_LENGTH)
    && (value.anchor === undefined || isAnchor(value.anchor));
}

function isPastedText(value: unknown): value is PastedText {
  return phone.isRecord(value) && phone.isString(value.id) && phone.isString(value.text, phone.MAX_PROMPT_LENGTH);
}

function isBoundedList<T>(value: unknown, item: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.length <= MAX_RECALL && value.every(item);
}

const annotates: phone.PhoneRule = (command) => phone.named(command)
  && phone.isString(command.quote, MAX_QUOTE_LENGTH)
  && (command.note === undefined || phone.isBlankable(command.note, MAX_QUOTE_LENGTH))
  && (command.anchor === undefined || isAnchor(command.anchor));

const notesAnnotation: phone.PhoneRule = (command) => phone.named(command) && phone.isString(command.annotationId) && phone.isBlankable(command.note, MAX_QUOTE_LENGTH);

const removesAnnotation: phone.PhoneRule = (command) => phone.named(command) && phone.isString(command.annotationId);

const recallsAnnotations: phone.PhoneRule = (command) => phone.named(command) && isBoundedList(command.annotations, isAnnotation);

const pastes: phone.PhoneRule = (command) => phone.named(command) && phone.isString(command.text, phone.MAX_PROMPT_LENGTH);

const removesPaste: phone.PhoneRule = (command) => phone.named(command) && phone.isString(command.pasteId);

const recallsPastes: phone.PhoneRule = (command) => phone.named(command) && isBoundedList(command.pastes, isPastedText);

export const annotationCommands = {
  "annotation.add": { fields: { taskId: optionalText, quote: text, note: optionalText, anchor: optional(isAnnotationAnchor) }, at: "local", phone: annotates },
  "annotation.note": { fields: { taskId: optionalText, annotationId: text, note: text }, at: "local", phone: notesAnnotation },
  "annotation.remove": { fields: { taskId: optionalText, annotationId: text }, at: "local", phone: removesAnnotation },
  "annotation.recall": { fields: { taskId: optionalText, annotations: array(annotation) }, at: "local", phone: recallsAnnotations },
  "annotation.reveal": { fields: { taskId: optionalText, annotationId: text }, at: "local" },
} satisfies Declarations<AnnotationCommand>;

export const pasteCommands = {
  "paste.add": { fields: { taskId: optionalText, text: text }, at: "local", phone: pastes },
  "paste.remove": { fields: { taskId: optionalText, pasteId: text }, at: "local", phone: removesPaste },
  "paste.recall": { fields: { taskId: optionalText, pastes: array(pastedText) }, at: "local", phone: recallsPastes },
} satisfies Declarations<PasteCommand>;

export const imageCommands = {
  "image.add": { fields: { taskId: optionalText, path: text, label: text, source: optionalText }, at: "local" },
  "image.remove": { fields: { taskId: optionalText, imageId: text }, at: "local" },
  "image.recall": { fields: { taskId: optionalText, paths: array(text) }, at: "local" },
} satisfies Declarations<ImageCommand>;

export const imageViewCommands = {
  "image.open": { fields: { source: isImageSource, gallery: optional(imageGallery) }, at: "local" },
  "image.step": { fields: { delta: step }, at: "local" },
  "image.close": { fields: {}, at: "local" },
  "image.download": { fields: {}, at: "local" },
} satisfies Declarations<ImageViewCommand>;

export const fileCommands = {
  "file.open": { fields: { taskId: optionalText, path: text, line: optional(number) }, at: "own" },
  "file.attach": { fields: { taskId: optionalText, files: array(attachedFileDraft) }, at: "local" },
  "file.detach": { fields: { taskId: optionalText, fileId: text }, at: "local" },
  "file.recall": { fields: { taskId: optionalText, files: array(attachedFile) }, at: "local" },
} satisfies Declarations<FileCommand>;
