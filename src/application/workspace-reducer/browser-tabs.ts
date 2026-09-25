/** The pages a dock holds: what loads in them, which one the panel draws, and who may open them. */
import { focusDockTab, persistView, showDockTab } from "./dock-tabs.js";
import { rejected, settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import { browserTarget, dockFor, dockOwner, dockTabAfterClosing, frontDock, withDock, type WorkspaceState } from "../workspace-state.js";
import { browserOrigin, type BrowserTab } from "../../domain/browser.js";

function withBrowserTabs(state: WorkspaceState, owner: string, browserTabs: BrowserTab[]): WorkspaceState {
  return withDock(state, owner, { browserTabs });
}

export function patchBrowserTab(state: WorkspaceState, owner: string, tabId: string, patch: Partial<BrowserTab>): WorkspaceState {
  return withBrowserTabs(state, owner, dockFor(state, owner).browserTabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
}

/**
 * Loads the page, in the tab named or a new one. The origin is remembered when the user is the one
 * asking, which is what lets a run reach a site the user has already signed into. Only the user's
 * own load takes the panel: a run leaves the dock on whatever tab it was showing, open or closed,
 * and its page loads parked out of sight.
 */
export function loadBrowserPage(state: WorkspaceState, owner: string, url: string, tabId: string | undefined, newTab: boolean, byUser: boolean, taskId?: string): WorkspaceTransition {
  const origin = browserOrigin(url);
  const allowing = byUser && origin && !state.browserOrigins.includes(origin);
  const remembered = allowing ? { ...state, browserOrigins: [...state.browserOrigins, origin] } : state;
  const target = newTab ? undefined : browserTarget(dockFor(remembered, owner), tabId);
  const cleared = { ...remembered, browserApproval: remembered.browserApproval?.tabId === target?.id ? null : remembered.browserApproval, actionError: null };
  if (target) {
    const surfaced = byUser ? showDockTab(cleared, owner, target.id) : cleared;
    const shown = withDock(patchBrowserTab(surfaced, owner, target.id, { url, loading: true, error: undefined }), owner, { browserTabId: target.id });
    const navigating = byUser ? focusDockTab(shown, owner, target.id) : settled(shown);
    return settled(navigating.state, [
      { type: "browser.navigate", tabId: target.id, url, ...(taskId ? { taskId } : {}) },
      ...persistView(navigating.state),
      ...navigating.effects,
    ]);
  }
  const tab: BrowserTab = { id: crypto.randomUUID(), url, title: "", loading: true, canGoBack: false, canGoForward: false };
  const surfaced = byUser ? showDockTab(cleared, owner, tab.id) : cleared;
  const shown = withDock(surfaced, owner, { browserTabs: [...dockFor(cleared, owner).browserTabs, tab], browserTabId: tab.id });
  const opened = byUser ? focusDockTab(shown, owner, tab.id) : settled(shown);
  return settled(opened.state, [
    { type: "browser.open", tabId: tab.id, url, ...(taskId ? { taskId } : {}) },
    /** The panel draws one page, so a tab nobody is looking at never claims it. */
    ...(byUser ? [{ type: "browser.show" as const, tabId: tab.id }] : []),
    ...persistView(opened.state),
    ...opened.effects,
  ]);
}

/** A page waiting for an address. It is a dock tab of its own from the moment it exists. */
export function withBlankTab(state: WorkspaceState, owner: string) {
  const tab: BrowserTab = { id: crypto.randomUUID(), url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
  const opened = withDock(showDockTab(state, owner, tab.id), owner, { browserTabs: [...dockFor(state, owner).browserTabs, tab], browserTabId: tab.id });
  return { state: opened, tab };
}

/**
 * Puts the navigation to the user. The ask always names the tab it would load in — a blank one when
 * the run wanted a new page — so it is shown in that tab rather than needing a panel of its own.
 */
export function askToBrowse(state: WorkspaceState, owner: string, url: string, taskId: string, tabId: string | undefined, newTab: boolean): WorkspaceTransition {
  if (state.browserApproval) return rejected(state, "A site is already waiting for approval. Wait for that decision before opening another site.");
  const approvalId = crypto.randomUUID();
  const target = newTab ? undefined : browserTarget(dockFor(state, owner), tabId);
  if (target) return settled({ ...showDockTab(state, owner, target.id), browserApproval: { approvalId, url, taskId, tabId: target.id } });
  const { state: opened, tab } = withBlankTab(state, owner);
  return settled({ ...opened, browserApproval: { approvalId, url, taskId, tabId: tab.id } }, [
    { type: "browser.open", tabId: tab.id },
    { type: "browser.show", tabId: tab.id },
  ]);
}

/** Closing a page hands the dock its neighbour, and the panel whichever page that turns out to be. */
export function closeBrowserTab(state: WorkspaceState, owner: string, tabId: string | undefined, options: { onlyIfBlank?: boolean } = {}): WorkspaceTransition {
  const dock = dockFor(state, owner);
  const index = dock.browserTabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return settled(state);
  if (options.onlyIfBlank && dock.browserTabs[index].url) return settled(state);
  const tab = dock.tab === tabId ? dockTabAfterClosing(state, owner, tabId) : dock.tab;
  const browserTabs = dock.browserTabs.filter((page) => page.id !== tabId);
  const next = dock.browserTabId === tabId ? browserTabs[index - 1] ?? browserTabs[index] ?? null : browserTabs.find((page) => page.id === dock.browserTabId) ?? null;
  const cleared = state.browserApproval?.tabId === tabId ? { ...state, browserApproval: null } : state;
  const closed = withDock(cleared, owner, { browserTabs, browserTabId: next?.id ?? null, tab });
  const showing = browserTabs.find((page) => page.id === tab);
  /** Only the dock on screen owns the panel, so closing a page in a dock behind it changes nothing there. */
  const shows = owner === dockOwner(state)
    ? showing ? browserEffectsForTab(closed, owner, showing.id) : [{ type: "browser.show" as const, tabId: null }]
    : [];
  return settled(closed, [
    { type: "browser.close", tabId: tabId! },
    ...shows,
    ...persistView(closed),
  ]);
}

/**
 * Whether a run may load this page without asking. One session serves the whole app, so a run browses
 * with every login the user has: an origin the user has never visited is theirs to allow, unless the
 * thread is already trusted to act without asking.
 */
export function browserAllowed(state: WorkspaceState, taskId: string, url: string) {
  const origin = browserOrigin(url);
  if (origin && state.browserOrigins.includes(origin)) return true;
  return state.threads.find((thread) => thread.id === taskId)?.executionPolicy === "autonomous";
}

/** Bringing a page to the front is what gives a restored one its view, and only then. */
export function browserEffectsForTab(state: WorkspaceState, owner: string, dockTab: string): WorkspaceEffect[] {
  const tab = dockFor(state, owner).browserTabs.find((page) => page.id === dockTab);
  if (!tab) return [];
  return [{ type: "browser.open", tabId: tab.id, ...(tab.url ? { url: tab.url } : {}) }, { type: "browser.show", tabId: tab.id }];
}

/**
 * Which page the panel draws once the dock on screen changes. One panel serves every dock, so the
 * thread the user lands on hands it its own page, or takes the page away when it has none.
 */
export function shownPageEffects(state: WorkspaceState): WorkspaceEffect[] {
  const { owner, dock } = frontDock(state);
  const effects = browserEffectsForTab(state, owner, dock.tab);
  return effects.length ? effects : [{ type: "browser.show", tabId: null }];
}
