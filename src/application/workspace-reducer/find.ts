/** The find bar's target: what it asks of the view holding the text, and when that view is gone. */
import type { WorkspaceEffect } from "./types.js";
import { selectedComputer } from "../state/computers.js";
import { DIFF_PANEL, dockHoldsTab, dockSideChats, frontDock, ownerOfBrowserTab, ownerOfTerminal, type FindState, type WorkspaceState } from "../workspace-state.js";
import { searchesItself, type FindTarget } from "../../domain/find.js";
import type { FindResults } from "../../domain/find.js";

/** What a page or a shell found, counted by whoever holds the text. `index` counts from zero. */
export type FindEvent = { type: "find.results"; target: FindTarget; results: FindResults };

/**
 * Find, in the things that hold their own text. The transcript needs no effect: the timeline reads
 * the match out of state and reveals it, folds and virtual rows and all.
 */
export type FindEffect =
  | { type: "find-in-page"; tabId: string; query: string; forward: boolean; findNext: boolean }
  | { type: "stop-find-in-page"; tabId: string }
  | { type: "find-in-terminal"; terminalId: string; query: string; forward: boolean }
  | { type: "stop-find-in-terminal"; terminalId: string };

/** What a search asks of whoever holds the text. A thread and a review are counted where they are drawn. */
export function searchEffects(find: FindState, { findNext, forward }: { findNext: boolean; forward: boolean }): WorkspaceEffect[] {
  const query = find.query.trim();
  if (!query || !searchesItself(find.target)) return [];
  return find.target.kind === "browser"
    ? [{ type: "find-in-page", tabId: find.target.tabId, query, forward, findNext }]
    : find.target.kind === "terminal" ? [{ type: "find-in-terminal", terminalId: find.target.terminalId, query, forward }] : [];
}

/** A page and a shell keep highlighting what was found until they are told to stop. */
export function stopSearchEffects(find: FindState | null): WorkspaceEffect[] {
  if (!find || !searchesItself(find.target)) return [];
  return find.target.kind === "browser"
    ? [{ type: "stop-find-in-page", tabId: find.target.tabId }]
    : find.target.kind === "terminal" ? [{ type: "stop-find-in-terminal", terminalId: find.target.terminalId }] : [];
}

/** Find belongs to the view it is searching, so it goes when that view does. */
function findViewGone(state: WorkspaceState, target: FindTarget): boolean {
  const { owner, dock } = frontDock(state);
  switch (target.kind) {
    case "thread": return target.taskId !== state.currentId
      && !dockSideChats(state, owner).some((chat) => chat.id === target.taskId);
    case "browser": return !ownerOfBrowserTab(state, target.tabId);
    case "terminal": return !ownerOfTerminal(selectedComputer(state)?.state ?? state, target.terminalId);
    case "review": return target.owner !== owner || !dock.panels.includes(DIFF_PANEL);
    case "panel": return target.owner !== owner || !dock.panels.includes(target.panel);
  }
}

/**
 * Runs at the end of every reduce, which is also what validates an externally supplied target: a
 * review or a panel naming a dock that is not in front is cleared on the reduce that opened it.
 */
export function prunedFind(state: WorkspaceState): WorkspaceState {
  const keyboardTab = state.keyboardTab && dockHoldsTab(state, state.keyboardTab) ? state.keyboardTab : null;
  const gone = state.find !== null && findViewGone(state, state.find.target);
  if (!gone && keyboardTab === state.keyboardTab) return state;
  return { ...state, keyboardTab, ...(gone ? { find: null, findResults: null } : {}) };
}
