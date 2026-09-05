/** What the store and the preferences hand back on the way in, and what failed on the way out. */
import { settled, rejected } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { viewPreferenceState } from "../view-preferences.js";
import { dockFor, withStoreData, type WorkspaceState } from "../workspace-state.js";
import { browserUrl, type BrowserTab } from "../../domain/browser.js";

type StoreInput = Extract<WorkspaceInput, {
  type: "store.loaded" | "store.thread-loaded" | "store.absent" | "store.persisted" | "preferences.loaded" | "store.failed" | "action.failed";
}>;

export function reduceStore(state: WorkspaceState, input: StoreInput): WorkspaceTransition {
  switch (input.type) {
    case "store.loaded":
      return settled({ ...withStoreData(state, input.data), hiddenThreads: input.hiddenTasks ?? 0, restored: true });

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
      return settled({ ...state, ...viewPreferenceState(input.preferences), docks });
    }

    case "store.persisted":
      return settled({ ...state, writable: true, storageError: null });

    case "store.failed":
      return settled({ ...state, writable: false, storageError: input.message, restored: true });

    case "action.failed":
      return rejected(state, input.message);
  }
}
