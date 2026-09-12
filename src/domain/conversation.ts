export type ConversationMessageKind = "user" | "assistant" | "tool" | "system";

/** Where a drafted annotation stays visible until the send that carries it. */
export type AnnotationAnchor =
  | { kind: "message"; messageId: string; start: number; end: number }
  | { kind: "diff"; comparison: string; path: string; start: string; end: string; side: "old" | "new" };

/** A piece of the assistant's output the user highlighted, with their note on it. */
export type Annotation = {
  id: string;
  quote: string;
  note: string;
  /** Only while drafted, and never on a reference handed to a side chat; sending drops it. */
  anchor?: AnnotationAnchor;
};

/** A block of text pasted into a composer, held aside as a pill instead of filling the prompt. */
export type PastedText = {
  id: string;
  text: string;
};

/** How many images one message may carry. */
export const MAX_ATTACHMENTS = 6;

/** How many files or folders one message may name. */
export const MAX_ATTACHED_FILES = 10;

/**
 * A file or folder the user dropped or pasted into a composer. The app never reads it: the message
 * names where it is, and the agent opens it from disk itself.
 */
export type AttachedFile = {
  id: string;
  path: string;
  name: string;
  /** Set when the path is a directory, so the chip and the prompt both say so. */
  folder?: true;
};

/** One before the composer gives it an id, which is what a drop and a paste both hand over. */
export type AttachedFileDraft = Omit<AttachedFile, "id">;

/** An image waiting in a composer, already written to the attachments directory. */
export type StagedImage = {
  id: string;
  path: string;
  /** What the image is of, such as the app whose window the desktop hotkey grabbed. */
  label: string;
  /** Where a dropped image came from. Two drops of the same file are one image; a paste has none. */
  source?: string;
};

export type ConversationMessage = {
  id: string;
  kind: ConversationMessageKind;
  text: string;
  /** A delivered artifact or its failure stays visible when intermediate work folds away. */
  artifact?: true;
  detail?: string;
  /** A system message is a neutral notice unless it reports a failure. */
  tone?: "error";
  /** Absolute paths of images sent with this message. The agent reads them from disk; the timeline shows them inline. */
  attachments?: string[];
  /** Highlights of earlier output sent with this message. The agent gets them in the prompt; the timeline shows quote cards. */
  annotations?: Annotation[];
  /** Blocks pasted into the composer and sent with this message. The agent gets them in the prompt; the timeline shows pills. */
  pastes?: PastedText[];
  /** Files and folders named by this message. The agent opens them from disk; the timeline shows pills. */
  files?: AttachedFile[];
  /** Written by a tick that surfaced nothing. It stays in the thread and out of the thread's activity. */
  withdrawn?: true;
  at: number;
};

/** Images sent into a run, grouped by path with one positional label per annotation. */
export type RunAttachment = {
  path: string;
  context?: ScreenshotContext;
  /** Label per annotation, positional: index 0 is the box marked "1". Empty strings are unlabelled boxes. */
  labels: string[];
};

/**
 * An image a composer is about to send, before anything of it is on disk: the pixels it was last
 * drawn from, the marks drawn over them, and where a staged image already sits.
 */
export type OutgoingAttachment = {
  id: string;
  /** A data URL. The marks are drawn over it on the way out, so this stays what the user picked. */
  source: string;
  annotations: ImageAnnotation[];
  path?: string;
  context?: ScreenshotContext;
};

export function createConversationMessage(kind: ConversationMessage["kind"], text: string, detail?: string, attachments?: string[], annotations?: Annotation[], pastes?: PastedText[], files?: AttachedFile[]): ConversationMessage {
  return {
    id: crypto.randomUUID(),
    kind,
    text,
    ...(detail === undefined ? {} : { detail }),
    ...(attachments?.length ? { attachments } : {}),
    ...(annotations?.length ? { annotations } : {}),
    ...(pastes?.length ? { pastes } : {}),
    ...(files?.length ? { files } : {}),
    at: Date.now(),
  };
}

export function createFailureMessage(text: string): ConversationMessage {
  return { ...createConversationMessage("system", text), tone: "error" };
}

/**
 * What the composer offers back on ↑: prompts the user sent themselves, oldest first. A user message
 * carries a detail only when an automation tick wrote it, so a labelled one was never typed.
 */
/** A message the composer can put back: what was typed, and what rode along with it. */
export type RecalledMessage = {
  text: string;
  annotations: Annotation[];
  pastes: PastedText[];
  files: AttachedFile[];
  /** Images this message carried, by where the app keeps them. */
  attachments: string[];
};

const sentPromptCache = new WeakMap<ConversationMessage[], RecalledMessage[]>();

export function sentPrompts(messages: ConversationMessage[]): RecalledMessage[] {
  const cached = sentPromptCache.get(messages);
  if (cached) return cached;
  const prompts: RecalledMessage[] = [];
  for (const message of messages) {
    if (message.kind === "user" && message.detail === undefined) {
      prompts.push({ text: message.text, annotations: message.annotations ?? [], pastes: message.pastes ?? [], files: message.files ?? [], attachments: message.attachments ?? [] });
    }
  }
  sentPromptCache.set(messages, prompts);
  return prompts;
}
import type { ScreenshotContext } from "./screenshot-context.js";
import type { ImageAnnotation } from "./image-annotation.js";
