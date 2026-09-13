import { apply } from "./workspace-reducer/dispatch.js";
import { reconcileSnoozes } from "./thread-snooze.js";
import { shownPageEffects } from "./workspace-reducer/browser-tabs.js";
import { prunedWorkflowPanels, TAKE_KEYS } from "./workspace-reducer/dock-tabs.js";
import { prunedFind } from "./workspace-reducer/find.js";
import { rejected, settled } from "./workspace-reducer/shared.js";
import { activeComputer, leavesComputer, routeInput, type InputRoute } from "./computers.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import { dockFor, dockOwner, findTargetFor, keyboardTerminalId, recordVisit, threadSlots, type WorkspaceState } from "./workspace-state.js";
import type { AppCommand } from "../contracts/commands.js";
import type { AgentEvent } from "../contracts/ipc.js";
import { slotShortcutIndex, type ShortcutSurface } from "../domain/shortcuts.js";
import { defaultEffortFor, defaultModelFor, effortForModel, effortsFor } from "../domain/agent-engine.js";

export type { WorkspaceCommandResult, WorkspaceEffect, WorkspaceEvent, WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
export { WORKSPACE_ERRORS } from "./workspace-reducer/errors.js";
export { DIFF_PANEL, WORKFLOW_PANEL } from "./workspace-state.js";

/**
 * The single writer for workspace state. Commands come from the UI (and, later, from anything else
 * driving the app); events report what the outside world did back. Nothing here touches Electron.
 */
export function reduce(state: WorkspaceState, input: WorkspaceInput): WorkspaceTransition {
  /** A keystroke is whatever the user could have clicked, so it re-enters here as those commands. */
  if (input.type === "view.shortcut") return runCommands(state, shortcutCommands(state, input.action, input.surface));
  if (input.type === "view.escape") return runCommands(state, escapeCommands(state));
  /** A frame's reports, folded in arrival order so no report overtakes the one before it. */
  if (input.type === "agent.events") {
    return input.events.reduce<WorkspaceTransition>((transition, event) => {
      const next = reduce(transition.state, agentEventInput(event));
      return combineTransitions(transition, next);
    }, settled(state));
  }
  const route = routeInput(state, input);
  if (route.kind === "refuse") return rejected(state, route.message);
  if (route.kind === "computer" && !route.also) return forwarded(state, route);
  const carried = route.kind === "computer" ? [forwardEffect(route)] : [];
  const left = leavingComputer(state, input);
  const applied = reconcileSnoozes(left, apply(left, input), input);
  applied.effects = [...leftBehind(state, left), ...carried, ...applied.effects];
  const transition = { ...applied, state: prunedWorkflowPanels(prunedFind(applied.state)) };
  if (transition.state.browserOrigins !== state.browserOrigins || (input.type === "task.set-policy" && transition.state !== state) || input.type === "store.loaded" || input.type === "preferences.loaded" || transition.effects.some((effect) => ["browser.open", "browser.navigate", "browser.act", "browser.history", "browser.reload"].includes(effect.type))) {
    transition.effects = [{ type: "browser.permissions", permissions: browserPermissions(transition.state) }, ...transition.effects];
  }
  if (transition.state.currentId === state.currentId) return transition;
  if (transition.state.openMenu === "session:location") transition.state = { ...transition.state, openMenu: null };
  const landed = transition.state.currentId !== null && input.type !== "view.go-back" && input.type !== "view.go-forward"
    ? recordVisit(transition.state, transition.state.currentId)
    : transition.state;
  /**
   * The dock the thread was left in comes back as it was; only the panel's own page has to follow. The
   * keys come back to the window too, since the page they were on belongs to the thread just left.
   */
  return { ...transition, state: landed, effects: [...transition.effects, ...shownPageEffects(landed), ...(landed.focused ? TAKE_KEYS : [])] };
}

function forwardEffect(route: Extract<InputRoute, { kind: "computer" }>): WorkspaceEffect {
  return { type: "computer.forward", id: route.computer.id, inputs: route.inputs, ...(route.draftKey === undefined ? {} : { draftKey: route.draftKey }) };
}

/** A command that moves this window to one of its own threads takes the paired computer off screen. */
function leavingComputer(state: WorkspaceState, input: WorkspaceInput): WorkspaceState {
  if (state.computers.active === null || !leavesComputer(input)) return state;
  return { ...state, computers: { ...state.computers, active: null } };
}

/**
 * A computer whose thread the window has just left is told to open nothing, so a run that settles
 * there afterwards is marked unseen, which is what this window announces and counts.
 */
function leftBehind(before: WorkspaceState, after: WorkspaceState): WorkspaceEffect[] {
  const left = activeComputer(before);
  if (!left || after.computers.active === left.id) return [];
  return [{ type: "computer.forward", id: left.id, inputs: [{ type: "task.new" }] }];
}

/**
 * A command on its way to the computer holding its thread. Selecting one of that computer's threads
 * puts that computer on screen; a send carries the draft typed here, which stays until it is taken.
 */
function forwarded(state: WorkspaceState, route: Extract<InputRoute, { kind: "computer" }>): WorkspaceTransition {
  let next = state;
  if (route.select) next = { ...next, computers: { ...next.computers, active: route.computer.id }, actionError: null };
  return { state: next, effects: [...leftBehind(state, next), forwardEffect(route)], result: { ok: true } };
}

/** Which channel a report arrived on: a run's own, or the thread's, which outlives every run. */
export function agentEventInput(event: AgentEvent): WorkspaceInput {
  if (event.type === "engine.settings-reload-status") return event;
  return "runId" in event ? { type: "run.event", event } : { type: "thread.event", event };
}

function runCommands(state: WorkspaceState, commands: AppCommand[]): WorkspaceTransition {
  return commands.reduce<WorkspaceTransition>((transition, command) => {
    const next = reduce(transition.state, command);
    return combineTransitions(transition, next);
  }, settled(state));
}

function combineTransitions(previous: WorkspaceTransition, next: WorkspaceTransition): WorkspaceTransition {
  const combined: WorkspaceTransition = { ...next, effects: [...previous.effects, ...next.effects] };
  if (previous.result && (previous.result.ok === false || !next.result)) combined.result = previous.result;
  return combined;
}

/**
 * What Esc means: the nearest layer claims it first — an overlay, then a menu, the settings sheet,
 * the find bar — and only when none is open does it reach a run. The run it reaches is the one in
 * the surface holding the caret, so Esc in a side chat stops that chat and never the main thread.
 */
export function escapeCommands(state: WorkspaceState): AppCommand[] {
  if (state.viewingImage) return [{ type: "image.close" }];
  if (state.jump) return [{ type: "view.jump-close" }];
  if (state.openMenu !== null) return [{ type: "view.set-menu", menu: null }];
  if (state.settingsOpen || state.computerUseSetup) return [{ type: "view.set-settings-open", open: false }];
  if (state.find) return [{ type: "view.find-close" }];
  const chat = state.sideChats.find((item) => item.id === state.keyboardTab);
  return [chat ? { type: "run.cancel", taskId: chat.id } : { type: "run.cancel" }];
}

/** The project a new thread starts in: the one the current thread is in, else the one being drafted. */
function currentProjectId(state: WorkspaceState): string | undefined {
  const thread = state.threads.find((item) => item.id === state.currentId);
  return (state.currentId ? thread?.projectId : state.draftProjectId) ?? undefined;
}

/**
 * What a bound keystroke means. Only the surface it was pressed on decides between a thread and a
 * page: everything else reads the same state the buttons do.
 */
export function shortcutCommands(state: WorkspaceState, action: string, surface: ShortcutSurface): AppCommand[] {
  const projectId = currentProjectId(state);
  const newThread: AppCommand = { type: "task.new", ...(projectId ? { projectId } : {}) };
  /** Settings are drawn over the whole window, so a keystroke that moves the user somewhere leaves them. */
  const leaving: AppCommand[] = state.settingsOpen || state.computerUseSetup ? [{ type: "view.set-settings-open", open: false }] : [];
  /**
   * A digit means the nth of whatever the keyboard is in. A panel view holding it counts that panel's
   * tabs, the last of them on ⌘9 the way a browser does; anywhere else counts the sidebar's threads.
   */
  const slot = slotShortcutIndex(action);
  if (slot !== null) {
    if (state.keyboardTab !== null) return [{ type: "view.select-dock-index", index: slot === 8 ? -1 : slot }];
    const threadId = threadSlots(state)[slot];
    if (!threadId) return [];
    return [...leaving, ...(state.jump ? [{ type: "view.jump-close" } as AppCommand] : []), { type: "task.select", taskId: threadId }];
  }
  switch (action) {
    case "app.check-for-updates": return [{ type: "app.check-for-updates" }];
    case "app.open-source-licenses": return [{ type: "app.open-source-licenses" }];
    case "thread.new": return [...leaving, newThread];
    case "thread.new-worktree": return [...leaving, newThread, { type: "task.set-worktree", worktree: true }];
    case "run.cancel": return [{ type: "run.cancel" }];
    case "run.allow":
    case "run.deny": {
      const taskId = state.sideChats.find((chat) => chat.id === state.keyboardTab)?.id ?? state.currentId;
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const approval = active ? state.approvals[active.runId] : undefined;
      return approval ? [{ type: "run.decide", taskId: approval.taskId, runId: approval.runId, approvalId: approval.approvalId, allow: action === "run.allow" }] : [];
    }
    case "composer.focus": return [{ type: "view.focus-composer" }];
    case "effort.increase":
    case "effort.decrease": {
      const chat = state.sideChats.find((item) => item.id === state.keyboardTab);
      const thread = state.threads.find((item) => item.id === (chat?.id ?? state.currentId));
      const engine = thread?.engine ?? state.draftEngine;
      const model = thread ? thread.model ?? defaultModelFor(engine) : state.draftModel;
      const effort = thread ? thread.effort ?? defaultEffortFor(engine) : state.draftEffort;
      const choices = effortsFor(model);
      const index = choices.findIndex((choice) => choice.id === effortForModel(model, effort));
      const next = choices[index + (action === "effort.increase" ? -1 : 1)];
      if (index < 0 || !next) return [];
      const command: AppCommand = { type: "task.set-effort", engine, effort: next.id };
      if (chat) command.taskId = chat.id;
      return [command];
    }
    /** The panel is a place the keystroke takes you to and back from, so the same keys close it. */
    case "thread.jump": return state.jump ? [{ type: "view.jump-close" }] : [...leaving, { type: "view.jump-open" }];
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

export function browserPermissions(state: WorkspaceState) {
  return { origins: state.browserOrigins, autonomousTaskIds: state.threads.filter((thread) => thread.executionPolicy === "autonomous").map((thread) => thread.id) };
}
