/** The browser panel's pages, and what they report back. */
import { BROWSER_TAB_ERROR, BROWSER_URL_ERROR, askToBrowse, browserAllowed, browserEffectsForTab, closeBrowserTab, focusDockTab, loadBrowserPage, patchBrowserTab, persistView, settled, showDockTab, withBlankTab, rejected } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { browserTarget, dockFor, dockOwner, ownerOfBrowserTab, withDock, type WorkspaceState } from "../workspace-state.js";
import { browserOrigin, browserUrl } from "../../domain/browser.js";

type BrowserInput = Extract<WorkspaceInput, {
  type: "browser.open" | "browser.new-tab" | "browser.decide" | "browser.select-tab" | "browser.close-tab"
    | "browser.go" | "browser.reload" | "browser.act" | "browser.clear-data" | "browser.updated";
}>;

export function reduceBrowser(state: WorkspaceState, input: BrowserInput): WorkspaceTransition {
  switch (input.type) {
    case "browser.open": {
      const owner = dockOwner(state, input.taskId);
      const url = browserUrl(input.url);
      if (!url) return rejected(state, BROWSER_URL_ERROR);
      const byUser = input.taskId === undefined;
      if (!byUser && !browserAllowed(state, input.taskId!, url)) return askToBrowse(state, owner, url, input.taskId!, input.tabId, input.newTab === true);
      return loadBrowserPage(state, owner, url, input.tabId, input.newTab === true, byUser);
    }

    case "browser.new-tab": {
      const owner = dockOwner(state);
      const { state: opened, tab } = withBlankTab(state, owner);
      const focused = focusDockTab(opened, owner, tab.id);
      return settled(focused.state, [{ type: "browser.open", tabId: tab.id }, { type: "browser.show", tabId: tab.id }, ...focused.effects]);
    }

    case "browser.decide": {
      const approval = state.browserApproval;
      if (!approval) return settled(state);
      const owner = dockOwner(state, approval.taskId);
      /** A blank tab only existed to carry the ask, so blocking takes it away again. */
      if (!input.allow) return closeBrowserTab({ ...state, browserApproval: null }, owner, approval.tabId, { onlyIfBlank: true });
      const origin = browserOrigin(approval.url);
      const allowed = origin ? { ...state, browserOrigins: [...state.browserOrigins, origin] } : state;
      return loadBrowserPage(allowed, owner, approval.url, approval.tabId, approval.tabId === undefined, false);
    }

    case "browser.select-tab": {
      const owner = ownerOfBrowserTab(state, input.tabId) ?? dockOwner(state, input.taskId);
      const tab = dockFor(state, owner).browserTabs.find((item) => item.id === input.tabId);
      if (!tab) return settled(state);
      return settled(withDock(showDockTab(state, owner, tab.id), owner, { browserTabId: tab.id }), browserEffectsForTab(state, owner, tab.id));
    }

    case "browser.close-tab":
      return closeBrowserTab(state, ownerOfBrowserTab(state, input.tabId) ?? dockOwner(state, input.taskId), input.tabId);

    case "browser.go":
    case "browser.reload":
    case "browser.act": {
      const owner = (input.tabId ? ownerOfBrowserTab(state, input.tabId) : undefined) ?? dockOwner(state, input.taskId);
      const target = browserTarget(dockFor(state, owner), input.tabId);
      if (!target) return rejected(state, BROWSER_TAB_ERROR);
      if (input.type === "browser.act") return settled(state, [{ type: "browser.act", tabId: target.id, action: input.action }]);
      const effect: WorkspaceEffect = input.type === "browser.go"
        ? { type: "browser.history", tabId: target.id, delta: input.delta }
        : { type: "browser.reload", tabId: target.id };
      return settled(patchBrowserTab(state, owner, target.id, { loading: true, error: undefined }), [effect]);
    }

    case "browser.clear-data": {
      const cleared = { ...state, browserOrigins: [] };
      return settled(cleared, [{ type: "browser.clear-data" }, ...persistView(cleared)]);
    }

    case "browser.updated": {
      const { tabId, ...patch } = input.page;
      const owner = ownerOfBrowserTab(state, tabId);
      const current = owner ? dockFor(state, owner).browserTabs.find((tab) => tab.id === tabId) : undefined;
      if (!owner || !current) return settled(state);
      /** Landing on a different page clears the error the page before it left behind. */
      const clearing = current.error !== undefined && patch.error === undefined && patch.url !== undefined && patch.url !== current.url;
      const updated = patchBrowserTab(state, owner, tabId, clearing ? { ...patch, error: undefined } : patch);
      return settled(updated, patch.url === undefined ? [] : persistView(updated));
    }
  }
}
