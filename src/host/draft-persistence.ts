import { TaskStore, type KeyValueStorage } from "../application/task-store.js";
import { NEW_THREAD_DRAFT, sideChatIds, type WorkspaceState } from "../application/workspace-state.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import { errorMessage } from "./errors.js";

export const DRAFT_PROMPTS_KEY = "aicodingtool.draft-prompts.v1";

function loadDraftPrompts(storage: KeyValueStorage): Record<string, string> {
  const raw = storage.getItem(DRAFT_PROMPTS_KEY);
  if (raw === null) return {};
  const prompts: unknown = JSON.parse(raw);
  if (!prompts || typeof prompts !== "object" || Array.isArray(prompts) || Object.values(prompts).some((text) => typeof text !== "string")) {
    throw new Error("Saved draft text could not be read.");
  }
  return withOneNewThreadDraft(prompts as Record<string, string>);
}

/** Builds that kept a new-thread draft per project saved several; the composer now has one, so the first kept wins. */
function withOneNewThreadDraft(prompts: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [owner, text] of Object.entries(prompts)) {
    const key = owner.startsWith(NEW_THREAD_DRAFT) ? NEW_THREAD_DRAFT : owner;
    if (!kept[key]) kept[key] = text;
  }
  return kept;
}

type DraftState = Pick<WorkspaceState, "prompts" | "sideChats" | "threads" | "computers">;

/**
 * Whose drafts are known: the new thread's, and this computer's threads and every paired computer's once
 * each has answered. Until then a draft may belong to a computer yet to answer, so none is nobody's.
 */
function draftOwners(state: DraftState): Set<string> | null {
  const remotes = state.computers.paired.map((computer) => computer.state);
  if (remotes.some((remote) => !remote)) return null;
  const owners = new Set([NEW_THREAD_DRAFT]);
  for (const held of [state, ...remotes as WorkspaceState[]]) {
    for (const thread of held.threads) owners.add(thread.id);
  }
  return owners;
}

function saveDraftPrompts(storage: KeyValueStorage, state: DraftState): void {
  const temporary = sideChatIds(state);
  const owners = draftOwners(state);
  const kept = Object.entries(state.prompts).filter(([owner]) => !temporary.has(owner) && (owners === null || owners.has(owner)));
  storage.setItem(DRAFT_PROMPTS_KEY, JSON.stringify(Object.fromEntries(kept)));
}

/** Save text off the typing path, and synchronously finish the last write before quitting. */
export function createDraftPersistence(storage: KeyValueStorage, state: () => WorkspaceState, dispatch: (input: WorkspaceInput) => Promise<void>) {
  let ready = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function flush() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (ready) saveDraftPrompts(storage, state());
  }
  return {
    /** Every draft comes back; one nobody owns is dropped at the next save, once every paired computer has answered. */
    async restore() {
      const current = ++generation;
      for (const [taskId, prompt] of Object.entries(loadDraftPrompts(storage))) {
        if (current !== generation) return;
        if (!(taskId in state().prompts)) await dispatch({ type: "view.set-prompt", taskId, prompt });
      }
      if (current === generation) ready = true;
    },
    changed() {
      if (!ready || timer !== undefined) return;
      timer = setTimeout(() => {
        try { flush(); }
        catch (error) { void dispatch({ type: "action.failed", message: `Could not save draft text: ${errorMessage(error)}` }); }
      }, 250);
    },
    flush,
    dispose() {
      generation += 1;
      ready = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function createTaskStore(storage: KeyValueStorage) {
  return new TaskStore(storage);
}
