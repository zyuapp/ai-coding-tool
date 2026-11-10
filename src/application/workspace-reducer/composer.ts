/** The composer draft: its text, and everything staged alongside it. */
import { focusedTabIn, docksOf } from "./dock-tabs.js";
import type { SliceTransition } from "./slice.js";
import type { WorkspaceInput } from "./types.js";
import { composerOf, draftedComposer, focusComposer, revealAnnotation, type ComposerDraftCommand } from "../composer-drafts.js";
import { promptKey, type WorkspaceState } from "../workspace-state.js";
import { sameReadingPoint, withPrompt, type ComposerState } from "../state/composer.js";
import { tabHolderOf } from "../workspace-dock.js";

export const COMPOSER_INPUTS = [
  "annotation.add", "annotation.note", "annotation.remove", "annotation.recall", "annotation.reveal", "paste.add", "paste.remove", "paste.recall", "image.add",
  "image.remove", "image.recall", "file.attach", "file.detach", "file.recall", "view.set-prompt", "view.reading-point"
] as const;
type ComposerInput = Extract<WorkspaceInput, { type: (typeof COMPOSER_INPUTS)[number] }>;

type Own = ComposerState;

/** The composers as `next` holds them, named only when they changed. */
function changed(state: WorkspaceState, next: WorkspaceState): SliceTransition<Own> {
  const composer = composerOf(next).view;
  return Object.entries(composer).some(([field, value]) => state[field as keyof Own] !== value) ? { patch: composer } : {};
}

/**
 * Where the caret lands once a draft changes. A fresh annotation is written to be sent, so it hands
 * the caret to the composer that will carry it. A comment on the diff keeps it, because the review
 * is worked down a row at a time and each comment would otherwise cost the reviewer their place.
 */
function focusAfter(state: WorkspaceState, drafted: WorkspaceState, input: ComposerDraftCommand, key: string): SliceTransition<Own> {
  if (input.type !== "annotation.add" || input.anchor?.kind === "diff") return changed(state, drafted);
  const holder = tabHolderOf(drafted, key);
  return holder ? { ...changed(state, drafted), docks: focusedTabIn(docksOf(drafted), holder, key) } : changed(state, focusComposer(drafted));
}

/** Every change to one composer's drafts. `key` is the composer: a thread's id, or the draft's. */
export function composerDraft(state: WorkspaceState, input: ComposerDraftCommand, key: string): SliceTransition<Own> {
  const drafted = draftedComposer(state, input, key);
  if ("error" in drafted) return { ...changed(state, drafted.state), refusal: drafted.error };
  return drafted === state ? {} : focusAfter(state, drafted, input, key);
}

export function reduceComposer(state: WorkspaceState, input: ComposerInput): SliceTransition<Own> {
  switch (input.type) {
    case "annotation.add":
    case "annotation.note":
    case "annotation.remove":
    case "annotation.recall":
    case "paste.add":
    case "paste.remove":
    case "paste.recall":
    case "image.add":
    case "image.remove":
    case "image.recall":
    case "file.attach":
    case "file.detach":
    case "file.recall":
      return composerDraft(state, input, input.taskId ?? promptKey(state));

    case "annotation.reveal":
      return changed(state, revealAnnotation(state, input.taskId ?? promptKey(state), input.annotationId));

    case "view.set-prompt":
      return { patch: withPrompt(composerOf(state).view, input.taskId ?? promptKey(state), input.prompt) };

    /** A place whose row the thread no longer has is dropped when it is next read, not here. */
    case "view.reading-point": {
      const { point } = input;
      const wellFormed = point === null || (point.anchor.length > 0 && Number.isFinite(point.depth));
      if (!wellFormed || !state.threads.some((thread) => thread.id === input.taskId)) return {};
      if (sameReadingPoint(state.readingPoints[input.taskId] ?? null, point)) return {};
      return { patch: { readingPoints: { ...state.readingPoints, [input.taskId]: point } } };
    }
  }
}
