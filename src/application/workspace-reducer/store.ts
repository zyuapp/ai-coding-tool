/** What the store and the preferences hand back on the way in, and what failed on the way out. */
import { settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { viewPreferenceState } from "../view-preferences.js";
import { dockFor, withStoreData, type WorkspaceState } from "../workspace-state.js";
import { browserUrl, type BrowserTab } from "../../domain/browser.js";

type StoreInput = Extract<WorkspaceInput, {
  type: "store.loaded" | "store.absent" | "preferences.loaded" | "store.failed" | "action.failed";
}>;

export function reduceStore(state: WorkspaceState, input: StoreInput): WorkspaceTransition {
  switch (input.type) {
    case "store.loaded":
      return settled({ ...withStoreData(state, input.data), restored: true });

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

    case "store.failed":
      return settled({ ...state, writable: false, storageError: input.message, restored: true });

    case "action.failed":
      return settled({ ...state, actionError: input.message });
  }
}
