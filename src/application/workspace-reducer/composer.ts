/** The composer draft: its text, and everything staged alongside it. */
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { composerDraft } from "../composer-drafts.js";
import { promptKey, sameReadingPoint, withPrompt, type WorkspaceState } from "../workspace-state.js";

type ComposerInput = Extract<WorkspaceInput, {
  type: "annotation.add" | "annotation.note" | "annotation.remove" | "annotation.recall" | "paste.add"
    | "paste.remove" | "paste.recall" | "image.add" | "image.remove" | "image.recall"
    | "file.attach" | "file.detach" | "file.recall" | "view.set-prompt" | "view.reading-point"
    | "view.dismiss-action-error" | "view.dismiss-hidden-tasks";
}>;

export function reduceComposer(state: WorkspaceState, input: ComposerInput): WorkspaceTransition {
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
      return settled(composerDraft(state, input, input.taskId ?? promptKey(state)));

    case "view.set-prompt":
      return settled(withPrompt(state, input.taskId ?? promptKey(state), input.prompt));

    /** A place whose row the thread no longer has is dropped when it is next read, not here. */
    case "view.reading-point": {
      const { point } = input;
      const wellFormed = point === null || (point.anchor.length > 0 && Number.isFinite(point.depth));
      if (!wellFormed || !state.tasks.some((task) => task.id === input.taskId)) return settled(state);
      if (sameReadingPoint(state.readingPoints[input.taskId] ?? null, point)) return settled(state);
      return settled({ ...state, readingPoints: { ...state.readingPoints, [input.taskId]: point } });
    }

    case "view.dismiss-action-error":
      return settled({ ...state, actionError: null, actionErrorPage: null });

    case "view.dismiss-hidden-tasks":
      return settled({ ...state, hiddenTasks: 0 });
  }
}
