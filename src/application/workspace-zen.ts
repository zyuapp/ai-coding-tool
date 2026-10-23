/** Zen mode: the window shows the thread on screen, its conversation and its composer, and nothing else. */
import { selectedComputer } from "./computers.js";
import { frontDock } from "./workspace-dock.js";
import type { WorkspaceState } from "./workspace-state.js";

/** A draft or an empty thread has no conversation to focus on, so only a thread with messages may enter it. */
export function zenAllowed(state: WorkspaceState): boolean {
  const shown = selectedComputer(state)?.state ?? state;
  const thread = shown.currentId ? shown.threads.find((item) => item.id === shown.currentId) : undefined;
  return Boolean(thread && thread.messages.length > 0);
}

function shownThread(state: WorkspaceState): string {
  return `${state.computers.active ?? ""}\u0000${state.currentId ?? ""}\u0000${selectedComputer(state)?.state?.currentId ?? ""}`;
}

function dockOpen(state: WorkspaceState): boolean {
  const shown = selectedComputer(state)?.state;
  return shown ? frontDock(shown).dock.open : frontDock(state).dock.open;
}

/**
 * Zen mode belongs to the thread it was entered on, so moving to another thread ends it. Opening
 * anything it hides ends it too, since that is the user asking for the rest of the window back.
 */
export function settledZen(before: WorkspaceState, after: WorkspaceState): WorkspaceState {
  if (!after.zen || !before.zen) return after;
  const left = shownThread(before) !== shownThread(after);
  const revealed = (!before.sidebarOpen && after.sidebarOpen)
    || (!before.sessionPanelOpen && after.sessionPanelOpen)
    || (!dockOpen(before) && dockOpen(after));
  return left || revealed || !zenAllowed(after) ? { ...after, zen: false } : after;
}
