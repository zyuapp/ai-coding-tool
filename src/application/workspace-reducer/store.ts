/** What the store and the preferences hand back on the way in, and what failed on the way out. */
import { discardedLeads } from "./coordination-remote.js";
import { settled, rejected } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { viewPreferenceState } from "../view-preferences.js";
import { dockFor, withStoreData, type WorkspaceState } from "../workspace-state.js";
import { browserUrl, type BrowserTab } from "../../domain/browser.js";

export const STORE_INPUTS = [
  "store.loaded", "store.thread-loaded", "store.absent", "store.persisted", "preferences.loaded", "store.failed", "action.failed"
] as const;
type StoreInput = Extract<WorkspaceInput, { type: (typeof STORE_INPUTS)[number] }>;

export function reduceStore(state: WorkspaceState, input: StoreInput): WorkspaceTransition {
  switch (input.type) {
    case "store.loaded": {
      const arrived = withStoreData(state, input.data);
      /** A thread that outlived its time in the archive goes as one cleared from it does. */
      const kept = new Set(arrived.threads.map((thread) => thread.id));
      return discardedLeads({ ...arrived, hiddenThreads: input.hiddenTasks ?? 0, restored: true }, input.data.tasks.filter((thread) => !kept.has(thread.id)));
    }

    case "store.thread-loaded": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread?.historySummary) return settled(state);
      const { historySummary: _loaded, ...loaded } = thread;
      return settled({
        ...state,
        threads: state.threads.map((item) => item.id === input.taskId ? { ...loaded, messages: input.messages } : item),
      });
    }

    case "store.absent":
      return settled({ ...state, restored: true });

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

    case "store.persisted":
      return settled({ ...state, writable: true, storageError: null });

    case "store.failed":
      return settled({ ...state, writable: false, storageError: input.message, restored: true });

    case "action.failed":
      return rejected(state, input.message);
  }
}
