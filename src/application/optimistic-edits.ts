/**
 * Text a person has typed but the workspace has not published yet. The authoritative state arrives a
 * revision at a time, so what is drawn is that state with every unacknowledged edit replayed over it.
 * An edit is held until the revision that carries it arrives, and is dropped the moment the
 * authoritative text catches up.
 */
import { sameFindTarget, type FindTarget } from "../domain/find.js";
import { clampTitle } from "../domain/thread.js";
import { annotationsFor } from "./composer-drafts.js";
import { reduce, type WorkspaceInput } from "./workspace-reducer.js";
import { promptKey, type WorkspaceState } from "./workspace-state.js";

type TextInput = Extract<WorkspaceInput, { type: "view.set-prompt" | "task.rename" | "worktree.menu-search" | "view.find-query" | "view.jump-query" | "annotation.note" }>;

/**
 * One field's pending text. `key` names the field, so a newer edit replaces the one it supersedes.
 * `revision` is the workspace revision that will carry the edit, known once the command is answered.
 */
export type OptimisticEdit = { key: string; input: TextInput; findTarget?: FindTarget; revision?: number };

/** Text edits name the field visible when they were typed, even if selection changes in transit. */
export function optimisticEdit(state: WorkspaceState, input: WorkspaceInput): OptimisticEdit | null {
  switch (input.type) {
    case "view.set-prompt":
    case "annotation.note": {
      const taskId = input.taskId ?? promptKey(state);
      const key = [input.type, taskId];
      if (input.type === "annotation.note") key.push(input.annotationId);
      return { key: JSON.stringify(key), input: { ...input, taskId } };
    }
    case "task.rename": return { key: JSON.stringify([input.type, input.taskId]), input };
    case "worktree.menu-search": return { key: JSON.stringify([input.type, input.list]), input };
    case "view.jump-query": return { key: input.type, input };
    case "view.find-query":
      return state.find ? { key: input.type, input, findTarget: state.find.target } : null;
    default: return null;
  }
}

/**
 * Whether the state already reads the way the edit would leave it. Replaying an edit the workspace
 * has caught up with makes a copy that draws the same thing, and every copy costs a render.
 */
function alreadyDrawn(state: WorkspaceState, input: TextInput): boolean {
  switch (input.type) {
    case "view.set-prompt":
      return (state.prompts[input.taskId ?? promptKey(state)] ?? "") === input.prompt;
    case "annotation.note": {
      const annotation = annotationsFor(state, input.taskId ?? promptKey(state)).find((item) => item.id === input.annotationId);
      return annotation === undefined || annotation.note === input.note;
    }
    case "task.rename": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      return thread !== undefined && thread.titleByUser === true && thread.title === clampTitle(input.title);
    }
    case "worktree.menu-search":
      return state.worktreeMenuSearch[input.list] === input.query;
    case "view.find-query":
      return state.find !== null && state.find.query === input.query && state.find.index === 0 && state.findResults === null;
    case "view.jump-query":
      return state.jump !== null && state.jump.query === input.query && state.jump.index === 0;
  }
}

/** What to draw, and which edits are still waiting, once the workspace has published `revision`. */
export type OptimisticView = { state: WorkspaceState; edits: OptimisticEdit[] };

/**
 * Replays the pending edits, oldest first, over the authoritative state. An edit whose revision has
 * arrived is settled and drops out; a search edit whose find target has moved on is held but not
 * drawn, because it no longer describes the field on screen. An edit the state already reads as is
 * left unreplayed, so the authoritative state is drawn as it stands.
 */
export function applyOptimisticEdits(authoritative: WorkspaceState, pending: Iterable<OptimisticEdit>, revision: number): OptimisticView {
  let state = authoritative;
  const edits: OptimisticEdit[] = [];
  for (const edit of pending) {
    // Command replies and state patches can arrive in either order across the process boundary.
    if (edit.revision !== undefined && edit.revision <= revision) continue;
    edits.push(edit);
    if (edit.findTarget && (!state.find || !sameFindTarget(edit.findTarget, state.find.target))) continue;
    if (alreadyDrawn(state, edit.input)) continue;
    state = reduce(state, edit.input).state;
  }
  return { state, edits };
}
