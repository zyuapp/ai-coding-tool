import { TaskStore, type KeyValueStorage } from "../application/task-store.js";
import { sideChatIds, type WorkspaceState } from "../application/workspace-state.js";
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
  return prompts as Record<string, string>;
}

function saveDraftPrompts(storage: KeyValueStorage, state: Pick<WorkspaceState, "prompts" | "sideChats">): void {
  const temporary = sideChatIds(state);
  storage.setItem(DRAFT_PROMPTS_KEY, JSON.stringify(Object.fromEntries(Object.entries(state.prompts).filter(([owner]) => !temporary.has(owner)))));
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
    /**
     * Every draft comes back but one for a folder that is gone. A draft keyed by a thread id is kept
     * whether or not the thread is here, since the thread may be on a paired computer that has yet
     * to answer.
     */
    async restore() {
      const current = ++generation;
      const initial = state();
      const folders = new Set(["draft:", ...initial.projects.map((project) => `draft:${project.id}`)]);
      for (const [taskId, prompt] of Object.entries(loadDraftPrompts(storage))) {
        if (current !== generation) return;
        const kept = taskId.startsWith("draft:") ? folders.has(taskId) : true;
        if (kept && !(taskId in state().prompts)) await dispatch({ type: "view.set-prompt", taskId, prompt });
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
