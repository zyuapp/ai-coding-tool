import { apply } from "./workspace-reducer/dispatch.js";
import { prunedFind, prunedWorkflowPanels, settled, shownPageEffects, TAKE_KEYS } from "./workspace-reducer/shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import { dockFor, dockOwner, findTargetFor, keyboardTerminalId, recordVisit, type WorkspaceState } from "./workspace-state.js";
import type { AppCommand } from "../contracts/commands.js";
import { dockTabShortcutIndex, type ShortcutSurface } from "../domain/shortcuts.js";

export type { WorkspaceEffect, WorkspaceEvent, WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
export { DIFF_PANEL, WORKFLOW_PANEL, WORKSPACE_ERRORS } from "./workspace-reducer/shared.js";

/**
 * The single writer for workspace state. Commands come from the UI (and, later, from anything else
 * driving the app); events report what the outside world did back. Nothing here touches Electron.
 */
export function reduce(state: WorkspaceState, input: WorkspaceInput): WorkspaceTransition {
  /** A keystroke is whatever the user could have clicked, so it re-enters here as those commands. */
  if (input.type === "view.shortcut") {
    return shortcutCommands(state, input.action, input.surface).reduce<WorkspaceTransition>((transition, command) => {
      const next = reduce(transition.state, command);
      return { state: next.state, effects: [...transition.effects, ...next.effects] };
    }, settled(state));
  }
  const applied = apply(state, input);
  const transition = { state: prunedWorkflowPanels(prunedFind(applied.state)), effects: applied.effects };
  if (transition.state.currentId === state.currentId) return transition;
  const landed = transition.state.currentId !== null && input.type !== "view.go-back" && input.type !== "view.go-forward"
    ? recordVisit(transition.state, transition.state.currentId)
    : transition.state;
  /**
   * The dock the thread was left in comes back as it was; only the panel's own page has to follow. The
   * keys come back to the window too, since the page they were on belongs to the thread just left.
   */
  return { state: landed, effects: [...transition.effects, ...shownPageEffects(landed), ...(landed.focused ? TAKE_KEYS : [])] };
}

/** The project a new thread starts in: the one the current thread is in, else the one being drafted. */
function currentProjectId(state: WorkspaceState): string | undefined {
  const task = state.tasks.find((item) => item.id === state.currentId);
  return (state.currentId ? task?.projectId : state.draftProjectId) ?? undefined;
}

/**
 * What a bound keystroke means. Only the surface it was pressed on decides between a thread and a
 * page: everything else reads the same state the buttons do.
 */
export function shortcutCommands(state: WorkspaceState, action: string, surface: ShortcutSurface): AppCommand[] {
  const tab = dockTabShortcutIndex(action);
  if (tab !== null) return [{ type: "view.select-dock-index", index: tab }];
  const projectId = currentProjectId(state);
  const newThread: AppCommand = { type: "task.new", ...(projectId ? { projectId } : {}) };
  /** Settings are drawn over the whole window, so a keystroke that moves the user somewhere leaves them. */
  const leaving: AppCommand[] = state.settingsOpen || state.computerUseSetup ? [{ type: "view.set-settings-open", open: false }] : [];
  switch (action) {
    case "thread.new": return [...leaving, newThread];
    case "thread.new-worktree": return [...leaving, newThread, { type: "task.set-worktree", worktree: true }];
    case "run.cancel": return [{ type: "run.cancel" }];
    case "run.allow": return [{ type: "run.decide", allow: true }];
    case "run.deny": return [{ type: "run.decide", allow: false }];
    case "composer.focus": return [{ type: "view.focus-composer" }];
    /** A bar that is already open is the one being asked for again, so it keeps what it was searching. */
    case "find.open": return [state.find ? { type: "view.find-open" } : { type: "view.find-open", target: findTargetFor(state, surface) }];
    case "find.next":
    case "find.previous": {
      const delta = action === "find.next" ? 1 as const : -1 as const;
      return state.find ? [{ type: "view.find-step", delta }] : [{ type: "view.find-open", target: findTargetFor(state, surface) }];
    }
    case "nav.back": return surface === "browser" ? [{ type: "browser.go", delta: -1 }] : [...leaving, { type: "view.go-back" }];
    case "nav.forward": return surface === "browser" ? [{ type: "browser.go", delta: 1 }] : [...leaving, { type: "view.go-forward" }];
    case "page.reload": return [{ type: "browser.reload" }];
    case "tab.new": return [{ type: "view.new-tab" }];
    /**
     * A shell is asked for, not a second one: the dock's newest answers before a new one is spun up.
     * The shell that already has the keyboard is one the user is done with, so it goes away instead.
     */
    case "terminal.focus": {
      if (keyboardTerminalId(state)) return [{ type: "view.set-dock-open", open: false }, { type: "view.focus-composer" }];
      const latest = dockFor(state, dockOwner(state)).terminals.at(-1);
      return [...leaving, latest ? { type: "terminal.select", terminalId: latest.id } : { type: "terminal.open" }];
    }
    case "tab.close": return [{ type: "view.close-tab" }];
    case "dock.toggle": return [{ type: "view.set-dock-open", open: !dockFor(state, dockOwner(state)).open }];
    case "dock.expand": return [{ type: "view.set-dock-expanded", expanded: !dockFor(state, dockOwner(state)).expanded }];
    case "sidebar.toggle": return [{ type: "view.set-sidebar-open", open: !state.sidebarOpen }];
    case "settings.toggle": return [{ type: "view.set-settings-open", open: !state.settingsOpen }];
    default: return [];
  }
}
