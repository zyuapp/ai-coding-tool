/** What the store and the preferences hand back on the way in, and what failed on the way out. */
import { discardedLeads } from "./coordination-remote.js";
import { settled } from "./shared.js";
import { historyLoadedIn, threadsOf } from "./thread-edits.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import type { SliceTransition } from "./slice.js";
import type { StoreState } from "../state/store.js";
import { viewPreferenceState } from "../view-preferences.js";
import { dockFor, type WorkspaceState } from "../workspace-state.js";
import { withStoreData } from "../workspace-load.js";
import { browserUrl, type BrowserTab } from "../../domain/browser.js";

/** The store and the preferences arriving, which fill in every owner's state at once. */
export const STORE_LOAD_INPUTS = ["store.loaded", "preferences.loaded"] as const;
type StoreLoadInput = Extract<WorkspaceInput, { type: (typeof STORE_LOAD_INPUTS)[number] }>;

export const STORE_INPUTS = ["store.thread-loaded", "store.absent", "store.persisted", "store.failed", "action.failed"] as const;
type StoreInput = Extract<WorkspaceInput, { type: (typeof STORE_INPUTS)[number] }>;

export function reduceStoreLoad(state: WorkspaceState, input: StoreLoadInput): WorkspaceTransition {
  switch (input.type) {
    case "store.loaded": {
      const arrived = withStoreData(state, input.data);
      /** A thread that outlived its time in the archive goes as one cleared from it does. */
      const kept = new Set(arrived.threads.map((thread) => thread.id));
      return discardedLeads({ ...arrived, hiddenThreads: input.hiddenTasks ?? 0, restored: true }, input.data.tasks.filter((thread) => !kept.has(thread.id)));
    }

    case "preferences.loaded": {
      /** A restored page keeps its record and gets its view back when the panel first shows it. */
      const docks = { ...state.docks };
      for (const [owner, urls] of Object.entries(input.preferences.browserTabs ?? {})) {
        const browserTabs = urls.flatMap((url): BrowserTab[] => {
          const loadable = browserUrl(url);
          return loadable ? [{ id: crypto.randomUUID(), url: loadable, title: "", loading: false, canGoBack: false, canGoForward: false }] : [];
        });
        if (browserTabs.length) docks[owner] = { ...dockFor(state, owner), browserTabs, browserTabId: browserTabs[0].id };
      }
      const computers = { ...state.computers, discardedLeads: input.preferences.discardedLeads ?? [] };
      return settled({ ...state, ...viewPreferenceState(input.preferences), browserImport: { ...state.browserImport, last: input.preferences.browserImport ?? null }, docks, computers });
    }
  }
}

export function reduceStore(state: WorkspaceState, input: StoreInput): SliceTransition<StoreState> {
  switch (input.type) {
    case "store.thread-loaded": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread?.historySummary) return {};
      return { edits: [historyLoadedIn(threadsOf(state), input.taskId, input.messages)] };
    }

    case "store.absent":
      return { patch: { restored: true } };

    case "store.persisted":
      return { patch: { writable: true, storageError: null } };

    case "store.failed":
      return { patch: { writable: false, storageError: input.message, restored: true } };

    case "action.failed":
      return { error: { message: input.message, page: input.page ?? null }, refusal: input.message };
  }
}

/** The note about threads this build cannot read, put away by the user. */
export function reduceHiddenThreadsDismissed(_state: StoreState): SliceTransition<StoreState> {
  return { patch: { hiddenThreads: 0 } };
}
