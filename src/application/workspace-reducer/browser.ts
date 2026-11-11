/** The browser panel's pages, and what they report back. */
import { askToBrowse, browserAllowed, browserEffectsForTab, closeBrowserTab, loadBrowserPage, patchBrowserTab, withBlankTab, type BrowserOwn } from "./browser-tabs.js";
import { docksOf, editDock, focusDockTabIn, persistView, showDockTabIn } from "./dock-tabs.js";
import { BROWSER_TAB_ERROR, BROWSER_URL_ERROR } from "./errors.js";
import { afterward, type SliceTransition, type Step } from "./slice.js";
import type { WorkspaceEffect, WorkspaceInput } from "./types.js";
import { browserTarget, dockFor, dockOwner, ownerOfBrowserTab, type WorkspaceState } from "../workspace-state.js";
import { browserOrigin, browserUrl } from "../../domain/browser.js";
import type { BrowserPageEvent } from "../../contracts/ipc.js";
import type { BrowserAction, BrowserPermissions } from "../../domain/browser.js";

export const BROWSER_INPUTS = [
  "browser.open", "browser.new-tab", "browser.decide", "browser.select-tab", "browser.close-tab", "browser.go", "browser.reload", "browser.act",
  "browser.clear-data", "browser.updated"
] as const;
type BrowserInput = Extract<WorkspaceInput, { type: (typeof BROWSER_INPUTS)[number] }>;

/** What a page in the browser panel did. Main watches the page; the reducer keeps the record. */
export type BrowserEvent = { type: "browser.updated"; page: BrowserPageEvent };

/** The browser panel's pages. `open` is idempotent: a tab that already has a view keeps it. */
export type BrowserEffect =
  | { type: "browser.permissions"; permissions: BrowserPermissions }
  | { type: "browser.open"; taskId?: string; tabId: string; url?: string }
  | { type: "browser.navigate"; taskId?: string; tabId: string; url: string }
  | { type: "browser.history"; taskId?: string; tabId: string; delta: -1 | 1 }
  | { type: "browser.reload"; taskId?: string; tabId: string }
  | { type: "browser.act"; taskId?: string; tabId: string; action: BrowserAction }
  | { type: "browser.close"; tabId: string }
  /** Which tab the panel shows. Where it shows is the panel's own to report. */
  | { type: "browser.show"; tabId: string | null }
  | { type: "browser.clear-data" }
  | { type: "focus-browser"; tabId: string };

/** A blank page in the dock in front, shown and holding the keys. */
export function newBrowserTab(state: WorkspaceState): Step {
  const owner = dockOwner(state);
  const { docks: opened, tab } = withBlankTab(docksOf(state), owner);
  const focused = focusDockTabIn(opened, owner, tab.id);
  return { edits: [focused.docks], effects: [{ type: "browser.open", tabId: tab.id }, { type: "browser.show", tabId: tab.id }, ...focused.effects] };
}

export function reduceBrowser(state: WorkspaceState, input: BrowserInput): SliceTransition<BrowserOwn> {
  switch (input.type) {
    case "browser.open": {
      const owner = dockOwner(state, input.taskId);
      const url = browserUrl(input.url);
      if (!url) return { refusal: BROWSER_URL_ERROR };
      const byUser = input.taskId === undefined;
      if (!byUser && !browserAllowed(state, input.taskId!, url)) return askToBrowse(state, owner, url, input.taskId!, input.tabId, input.newTab === true);
      return loadBrowserPage(state, undefined, owner, url, input.tabId, input.newTab === true, byUser, input.taskId);
    }

    case "browser.new-tab":
      return newBrowserTab(state);

    case "browser.decide": {
      const approval = state.browserApproval;
      if (!approval || approval.approvalId !== input.approvalId) return {};
      const owner = dockOwner(state, approval.taskId);
      /** A blank tab only existed to carry the ask, so blocking takes it away again. */
      if (!input.allow) return closeBrowserTab(state, { browserApproval: null }, owner, approval.tabId, { onlyIfBlank: true });
      const origin = browserOrigin(approval.url);
      const allowed = origin ? { browserOrigins: [...state.browserOrigins, origin] } : undefined;
      return loadBrowserPage(state, allowed, owner, approval.url, approval.tabId, approval.tabId === undefined, false, approval.taskId);
    }

    case "browser.select-tab": {
      const owner = ownerOfBrowserTab(state, input.tabId) ?? dockOwner(state, input.taskId);
      const tab = dockFor(state, owner).browserTabs.find((item) => item.id === input.tabId);
      if (!tab) return {};
      return { edits: [editDock(showDockTabIn(docksOf(state), owner, tab.id), owner, { browserTabId: tab.id })], effects: browserEffectsForTab(state, owner, tab.id) };
    }

    case "browser.close-tab":
      return closeBrowserTab(state, undefined, ownerOfBrowserTab(state, input.tabId) ?? dockOwner(state, input.taskId), input.tabId);

    case "browser.go":
    case "browser.reload":
    case "browser.act": {
      const owner = (input.tabId ? ownerOfBrowserTab(state, input.tabId) : undefined) ?? dockOwner(state, input.taskId);
      const target = browserTarget(dockFor(state, owner), input.tabId);
      if (!target) return { refusal: BROWSER_TAB_ERROR };
      if (input.type === "browser.act") return { effects: [{ type: "browser.act", tabId: target.id, action: input.action, taskId: input.taskId }] };
      const effect: WorkspaceEffect = input.type === "browser.go"
        ? { type: "browser.history", tabId: target.id, delta: input.delta, taskId: input.taskId }
        : { type: "browser.reload", tabId: target.id, taskId: input.taskId };
      return { edits: [patchBrowserTab(docksOf(state), owner, target.id, { loading: true, error: undefined })], effects: [effect] };
    }

    case "browser.clear-data":
      return { patch: { browserOrigins: [] }, effects: [{ type: "browser.clear-data" }], persists: true };

    case "browser.updated": {
      const { tabId, navigationRequest, ...patch } = input.page;
      const owner = ownerOfBrowserTab(state, tabId);
      const current = owner ? dockFor(state, owner).browserTabs.find((tab) => tab.id === tabId) : undefined;
      if (!owner || !current) return {};
      if (navigationRequest && owner === dockOwner(state, navigationRequest.taskId)) {
        return askToBrowse(state, owner, navigationRequest.url, navigationRequest.taskId, tabId, false);
      }
      /** Landing on a different page clears the error the page before it left behind. */
      const clearing = current.error !== undefined && patch.error === undefined && patch.url !== undefined && patch.url !== current.url;
      const docks = patchBrowserTab(docksOf(state), owner, tabId, clearing ? { ...patch, error: undefined } : patch);
      return { edits: [docks], effects: patch.url === undefined ? [] : persistView(afterward(state, { edits: [docks] })) };
    }
  }
}
