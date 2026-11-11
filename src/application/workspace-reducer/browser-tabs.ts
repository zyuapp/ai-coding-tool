/** The pages a dock holds: what loads in them, which one the panel draws, and who may open them. */
import { docksOf, editDock, focusDockTabIn, persistView, showDockTabIn, type DocksEdit } from "./dock-tabs.js";
import { afterward, ownFields, type SliceTransition, type Step } from "./slice.js";
import type { WorkspaceEffect } from "./types.js";
import type { BrowserState } from "../state/browser.js";
import { browserTarget, dockFor, dockOwner, dockTabAfterClosing, frontDock, type WorkspaceState } from "../workspace-state.js";
import { browserOrigin, type BrowserTab } from "../../domain/browser.js";

/** What the browser panel itself owns: the sites a run may reach, and the one waiting on the user. */
export type BrowserOwn = Pick<BrowserState, "browserOrigins" | "browserApproval">;

/** The browser's own state as one input leaves it. Only the functions here make one. */
class BrowserChange {
  private declare readonly owned: never;
  constructor(readonly view: BrowserOwn) {}
}

export type BrowserEdit = BrowserChange;

export function browserOf(state: BrowserOwn): BrowserEdit {
  return new BrowserChange(ownFields<BrowserOwn>(state, { browserOrigins: true, browserApproval: true }));
}

/** A run's ask to browse goes with the thread that asked, once that thread is gone for good. */
export function approvalForgottenIn(edit: BrowserEdit, removed: Set<string>): BrowserEdit {
  const approval = edit.view.browserApproval;
  return new BrowserChange({ ...edit.view, browserApproval: approval && !removed.has(approval.taskId) ? approval : null });
}

type Pages = SliceTransition<BrowserOwn>;

/** The browser's own state with this input's changes so far. */
function current(state: WorkspaceState, own: Pages["patch"]): BrowserOwn {
  return { browserOrigins: own?.browserOrigins ?? state.browserOrigins, browserApproval: own && "browserApproval" in own ? own.browserApproval ?? null : state.browserApproval };
}

export function patchBrowserTab(docks: DocksEdit, owner: string, tabId: string, patch: Partial<BrowserTab>): DocksEdit {
  return editDock(docks, owner, { browserTabs: dockFor(docks.view, owner).browserTabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab) });
}

/**
 * Loads the page, in the tab named or a new one. The origin is remembered when the user is the one
 * asking, which is what lets a run reach a site the user has already signed into. Only the user's
 * own load takes the panel: a run leaves the dock on whatever tab it was showing, open or closed,
 * and its page loads parked out of sight.
 */
export function loadBrowserPage(state: WorkspaceState, own: Pages["patch"], owner: string, url: string, tabId: string | undefined, newTab: boolean, byUser: boolean, taskId?: string): Pages {
  const origin = browserOrigin(url);
  const before = current(state, own);
  const allowing = byUser && origin && !before.browserOrigins.includes(origin);
  const browserOrigins = allowing ? [...before.browserOrigins, origin] : before.browserOrigins;
  const docks = docksOf(state);
  const target = newTab ? undefined : browserTarget(dockFor(docks.view, owner), tabId);
  const patch = { ...own, ...(allowing ? { browserOrigins } : {}), browserApproval: before.browserApproval?.tabId === target?.id ? null : before.browserApproval };
  const settledWith = (changed: DocksEdit, effects: (after: WorkspaceState) => WorkspaceEffect[]): Pages => ({
    patch, clearsError: true, edits: [changed], effects: effects(afterward(state, { patch, clearsError: true, edits: [changed] })),
  });
  if (target) {
    const surfaced = byUser ? showDockTabIn(docks, owner, target.id) : docks;
    const shown = editDock(patchBrowserTab(surfaced, owner, target.id, { url, loading: true, error: undefined }), owner, { browserTabId: target.id });
    const navigating = byUser ? focusDockTabIn(shown, owner, target.id) : { docks: shown, effects: [] };
    return settledWith(navigating.docks, (after) => [
      { type: "browser.navigate", tabId: target.id, url, ...(taskId ? { taskId } : {}) },
      ...persistView(after),
      ...navigating.effects,
    ]);
  }
  const tab: BrowserTab = { id: crypto.randomUUID(), url, title: "", loading: true, canGoBack: false, canGoForward: false };
  const surfaced = byUser ? showDockTabIn(docks, owner, tab.id) : docks;
  const shown = editDock(surfaced, owner, { browserTabs: [...dockFor(docks.view, owner).browserTabs, tab], browserTabId: tab.id });
  const opened = byUser ? focusDockTabIn(shown, owner, tab.id) : { docks: shown, effects: [] };
  return settledWith(opened.docks, (after) => [
    { type: "browser.open", tabId: tab.id, url, ...(taskId ? { taskId } : {}) },
    /** The panel draws one page, so a tab nobody is looking at never claims it. */
    ...(byUser ? [{ type: "browser.show" as const, tabId: tab.id }] : []),
    ...persistView(after),
    ...opened.effects,
  ]);
}

/** A page waiting for an address. It is a dock tab of its own from the moment it exists. */
export function withBlankTab(docks: DocksEdit, owner: string) {
  const tab: BrowserTab = { id: crypto.randomUUID(), url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
  const opened = editDock(showDockTabIn(docks, owner, tab.id), owner, { browserTabs: [...dockFor(docks.view, owner).browserTabs, tab], browserTabId: tab.id });
  return { docks: opened, tab };
}

/**
 * Puts the navigation to the user. The ask always names the tab it would load in — a blank one when
 * the run wanted a new page — so it is shown in that tab rather than needing a panel of its own.
 */
export function askToBrowse(state: WorkspaceState, owner: string, url: string, taskId: string, tabId: string | undefined, newTab: boolean): Pages {
  if (state.browserApproval) return { refusal: "A site is already waiting for approval. Wait for that decision before opening another site." };
  const approvalId = crypto.randomUUID();
  const docks = docksOf(state);
  const target = newTab ? undefined : browserTarget(dockFor(docks.view, owner), tabId);
  if (target) return { patch: { browserApproval: { approvalId, url, taskId, tabId: target.id } }, edits: [showDockTabIn(docks, owner, target.id)] };
  const { docks: opened, tab } = withBlankTab(docks, owner);
  return {
    patch: { browserApproval: { approvalId, url, taskId, tabId: tab.id } },
    edits: [opened],
    effects: [{ type: "browser.open", tabId: tab.id }, { type: "browser.show", tabId: tab.id }],
  };
}

/** Closing a page hands the dock its neighbour, and the panel whichever page that turns out to be. */
export function closeBrowserTab(state: WorkspaceState, own: Pages["patch"], owner: string, tabId: string | undefined, options: { onlyIfBlank?: boolean } = {}): Pages {
  const dock = dockFor(state, owner);
  const index = dock.browserTabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return own ? { patch: own } : {};
  if (options.onlyIfBlank && dock.browserTabs[index].url) return own ? { patch: own } : {};
  const tab = dock.tab === tabId ? dockTabAfterClosing(state, owner, tabId) : dock.tab;
  const browserTabs = dock.browserTabs.filter((page) => page.id !== tabId);
  const next = dock.browserTabId === tabId ? browserTabs[index - 1] ?? browserTabs[index] ?? null : browserTabs.find((page) => page.id === dock.browserTabId) ?? null;
  const patch = current(state, own).browserApproval?.tabId === tabId ? { ...own, browserApproval: null } : own;
  const docks = editDock(docksOf(state), owner, { browserTabs, browserTabId: next?.id ?? null, tab });
  const showing = browserTabs.find((page) => page.id === tab);
  /** Only the dock on screen owns the panel, so closing a page in a dock behind it changes nothing there. */
  const shows = owner === dockOwner(state)
    ? showing ? browserEffectsForTab(docks.view, owner, showing.id) : [{ type: "browser.show" as const, tabId: null }]
    : [];
  return {
    ...(patch ? { patch } : {}),
    edits: [docks],
    effects: [
      { type: "browser.close", tabId: tabId! },
      ...shows,
      ...persistView(afterward(state, { patch, edits: [docks] })),
    ],
  };
}

/** {@link closeBrowserTab} of the user's own accord, which any slice can carry. */
export function browserTabClosed(state: WorkspaceState, owner: string, tabId: string): Step {
  const { patch, ...closed } = closeBrowserTab(state, undefined, owner, tabId);
  return patch ? { ...closed, edits: [new BrowserChange({ ...browserOf(state).view, ...patch }), ...closed.edits ?? []] } : closed;
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
export function browserEffectsForTab(state: Pick<WorkspaceState, "docks">, owner: string, dockTab: string): WorkspaceEffect[] {
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
