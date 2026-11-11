/** Which tab a dock shows, which of them has the keys, and what a dock leaves behind. */
import { settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import { viewPreferences } from "../view-preferences.js";
import { isCoordinator } from "../../domain/coordination.js";
import { DOCK_PICKER, DRAFT_DOCK, OVERVIEW_PANEL, WORKFLOW_PANEL, dockFor, dockTabAfterClosing, withDock, type ThreadDock, type WorkspaceState } from "../workspace-state.js";
import { workflowById } from "../state/runs.js";
import type { DocksState } from "../state/dock.js";

/** The caret goes to the tab a side chat is drawn in, because its composer is not the thread's own. */
export function focusedTab<S extends Pick<WorkspaceState, "dockFocus">>(state: S, owner: string, tab: string): S {
  return { ...state, dockFocus: { owner, tab, count: (state.dockFocus?.count ?? 0) + 1 } };
}

/** The window has the keys again, which a page in the panel is otherwise holding. */
export const TAKE_KEYS: WorkspaceEffect[] = [{ type: "focus-window" }];


/** The docks as one input leaves them. Only the functions here make one, so a slice changes a dock through them. */
class DocksChange {
  private declare readonly owned: never;
  constructor(readonly view: DocksState) {}
}

export type DocksEdit = DocksChange;

export function docksOf(state: DocksState): DocksEdit {
  const { overviewFolds, dockFocus, docks, diffs, keyboardTab } = state;
  return new DocksChange({ overviewFolds, dockFocus, docks, diffs, keyboardTab });
}

/** The dock tab holding the keyboard, or none. */
export function keyboardTabIn(edit: DocksEdit, tab: string | null): DocksEdit {
  return new DocksChange({ ...edit.view, keyboardTab: tab });
}

/** The review the next new thread's draft was left looking at, gone, so a fresh draft compares its own project. */
export function draftReviewDroppedIn(edit: DocksEdit): DocksEdit {
  const { [DRAFT_DOCK]: _lastDraft, ...diffs } = edit.view.diffs;
  return new DocksChange({ ...edit.view, diffs });
}

export function editDock(edit: DocksEdit, owner: string, patch: Partial<ThreadDock>): DocksEdit {
  return new DocksChange(withDock(edit.view, owner, patch));
}

export function showDockTabIn(edit: DocksEdit, owner: string, tab: string): DocksEdit {
  return editDock(edit, owner, { open: true, tab });
}

/** {@link focusedTab}, on the docks an input is changing. */
export function focusedTabIn(edit: DocksEdit, owner: string, tab: string): DocksEdit {
  return new DocksChange(focusedTab(edit.view, owner, tab));
}

/** {@link focusDockTab}, on the docks an input is changing. */
export function focusDockTabIn(edit: DocksEdit, owner: string, tab: string): { docks: DocksEdit; effects: WorkspaceEffect[] } {
  const focused = new DocksChange(focusedTab(edit.view, owner, tab));
  const page = dockFor(focused.view, owner).browserTabs.find((item) => item.id === tab);
  return { docks: focused, effects: page?.url ? [] : TAKE_KEYS };
}

/** Brings a tab to the front of its own dock, so a page or a shell nobody asked to see still lands somewhere. */
export function showDockTab(state: WorkspaceState, owner: string, tab: string): WorkspaceState {
  return withDock(state, owner, { open: true, tab });
}

/**
 * Hands a dock tab the keyboard. The view watches the count rather than being told to focus, and the
 * window takes the keys back on its way, because only a page can hold them itself.
 */
export function focusDockTab(state: WorkspaceState, owner: string, tab: string): WorkspaceTransition {
  const focused = focusedTab(state, owner, tab);
  const page = dockFor(focused, owner).browserTabs.find((item) => item.id === tab);
  return settled(focused, page?.url ? [] : TAKE_KEYS);
}

/** The window is gone: its shells went with it, and its pages wait to be drawn again. */
export function closedWindowDocks(edit: DocksEdit): DocksEdit {
  const docks = { ...edit.view.docks };
  for (const [owner, dock] of Object.entries(docks)) {
    const tab = dock.terminals.some((terminal) => terminal.id === dock.tab) ? DOCK_PICKER : dock.tab;
    docks[owner] = {
      ...dock,
      tab,
      terminals: [],
      terminalId: null,
      browserTabs: dock.browserTabs.map(({ error: _error, ...page }) => ({ ...page, loading: false, canGoBack: false, canGoForward: false })),
    };
  }
  return new DocksChange({ ...edit.view, docks, keyboardTab: null });
}

export function persistView(state: WorkspaceState): WorkspaceEffect[] {
  return [{ type: "persist-preferences", preferences: viewPreferences(state) }];
}

/** The dock a draft was composed in belongs to the thread that send creates, pages, shells and all. */
export function handOverDraftDock(state: WorkspaceState, taskId: string): WorkspaceState {
  const { [DRAFT_DOCK]: draft, ...docks } = state.docks;
  const { [DRAFT_DOCK]: draftDiff, ...diffs } = state.diffs;
  const moved = draft ? { ...state, docks: { ...docks, [taskId]: draft } } : state;
  return draftDiff ? { ...moved, diffs: { ...diffs, [taskId]: draftDiff } } : moved;
}

/** A thread that is gone for good takes its dock with it: its pages close and its shells stop. */
export function disposeDocks(state: WorkspaceState, owners: Iterable<string>): WorkspaceTransition {
  const docks = { ...state.docks };
  const diffs = { ...state.diffs };
  const effects: WorkspaceEffect[] = [];
  let emptied = false;
  for (const owner of owners) {
    if (diffs[owner]) {
      delete diffs[owner];
      emptied = true;
    }
    const dock = docks[owner];
    if (!dock) continue;
    effects.push(...dock.browserTabs.map((tab): WorkspaceEffect => ({ type: "browser.close", tabId: tab.id })));
    effects.push(...dock.terminals.map((terminal): WorkspaceEffect => ({ type: "terminal.close", terminalId: terminal.id })));
    delete docks[owner];
    emptied = true;
  }
  return emptied ? { state: { ...state, docks, diffs }, effects } : settled(state);
}

/** A dock follows a workflow only while its record is there, so a run that clears one closes its panel. */
const validWorkflowPanels = new WeakMap<WorkspaceState["docks"], WeakSet<WorkspaceState["workflows"]>>();

export function prunedWorkflowPanels(state: WorkspaceState): WorkspaceState {
  if (validWorkflowPanels.get(state.docks)?.has(state.workflows)) return state;
  let next = state;
  for (const [owner, dock] of Object.entries(state.docks)) {
    if (!dock.workflowId || workflowById(state, dock.workflowId)) continue;
    const panels = dock.panels.filter((panel) => panel !== WORKFLOW_PANEL), tab = dock.tab === WORKFLOW_PANEL ? dockTabAfterClosing(next, owner, WORKFLOW_PANEL) : dock.tab;
    next = withDock(next, owner, { workflowId: null, panels, tab });
  }
  if (next === state) { const workflows = validWorkflowPanels.get(state.docks) ?? new WeakSet(); workflows.add(state.workflows); validWorkflowPanels.set(state.docks, workflows); }
  return next;
}

/** Docks already matched to these threads' coordinators, so a reduction that changes neither skips the pass. */
const checkedOverviews = new WeakMap<WorkspaceState["docks"], WeakSet<WorkspaceState["threads"]>>();

/**
 * A coordinator's dock leads with its Overview, where its threads are followed and what they run on
 * is chosen. Threads usually arrive from an agent while the user is elsewhere, so the dock is never
 * opened or switched for it: a closed dock with nothing chosen just opens on the Overview next time.
 * A thread that stops coordinating loses the tab.
 */
export function withOverviewPanels(state: WorkspaceState): WorkspaceState {
  if (checkedOverviews.get(state.docks)?.has(state.threads)) return state;
  const leads = new Set(state.threads.filter((thread) => isCoordinator(thread)).map((thread) => thread.id));
  let next = state;
  for (const owner of leads) {
    const dock = dockFor(next, owner);
    if (dock.panels.includes(OVERVIEW_PANEL)) continue;
    const tab = !dock.open && dock.tab === DOCK_PICKER ? OVERVIEW_PANEL : dock.tab;
    next = withDock(next, owner, { panels: [OVERVIEW_PANEL, ...dock.panels], tab });
  }
  for (const [owner, dock] of Object.entries(next.docks)) {
    if (leads.has(owner) || !dock.panels.includes(OVERVIEW_PANEL)) continue;
    const tab = dock.tab === OVERVIEW_PANEL ? dockTabAfterClosing(next, owner, OVERVIEW_PANEL) : dock.tab;
    next = withDock(next, owner, { panels: dock.panels.filter((panel) => panel !== OVERVIEW_PANEL), tab });
  }
  const checked = checkedOverviews.get(next.docks) ?? new WeakSet();
  checked.add(next.threads);
  checkedOverviews.set(next.docks, checked);
  return next;
}
