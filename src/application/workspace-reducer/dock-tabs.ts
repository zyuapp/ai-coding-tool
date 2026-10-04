/** Which tab a dock shows, which of them has the keys, and what a dock leaves behind. */
import { settled } from "./shared.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import { focusedTab } from "../composer-drafts.js";
import { viewPreferences } from "../view-preferences.js";
import { coordinatedThreadIds } from "../../domain/coordination.js";
import { DOCK_PICKER, DRAFT_DOCK, OVERVIEW_PANEL, WORKFLOW_PANEL, dockFor, dockTabAfterClosing, withDock, workflowById, type WorkspaceState } from "../workspace-state.js";

/** The window has the keys again, which a page in the panel is otherwise holding. */
export const TAKE_KEYS: WorkspaceEffect[] = [{ type: "focus-window" }];

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
 * A coordinator's dock leads with its Overview once a thread works under it, and shows it that first
 * time. A thread with nobody working under it any more loses the tab.
 */
export function withOverviewPanels(state: WorkspaceState): WorkspaceState {
  if (checkedOverviews.get(state.docks)?.has(state.threads)) return state;
  const members = coordinatedThreadIds(state.threads);
  const leads = new Set<string>();
  for (const thread of state.threads) if (thread.parentId && members.has(thread.id)) leads.add(thread.parentId);
  let next = state;
  for (const owner of leads) {
    const dock = dockFor(next, owner);
    if (dock.panels.includes(OVERVIEW_PANEL)) continue;
    const tab = dock.open && dock.tab !== DOCK_PICKER ? dock.tab : OVERVIEW_PANEL;
    next = withDock(next, owner, { panels: [OVERVIEW_PANEL, ...dock.panels], open: true, tab });
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
