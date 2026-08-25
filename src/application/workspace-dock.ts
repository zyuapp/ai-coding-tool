/**
 * The right dock as data: one per thread, the tabs it holds, and which of them the keyboard is in.
 * Nothing here reaches back into the workspace at runtime, so the state module can own the record
 * while the tab arithmetic every command does lives in one place.
 */
import type { BrowserTab } from "../domain/browser.js";
import type { TerminalSession } from "../domain/terminal.js";
import type { SideChat } from "./workspace-state.js";

/**
 * One thread's right dock: whether it is showing, which panels are open as tabs, which tab is on top,
 * and the pages and shells that thread opened. A page and a shell belong to the thread that asked for
 * one, so a run drives its own dock and never the dock of whichever thread the user is looking at.
 * Only the records live here. What a page holds and what a shell has printed never become state.
 */
export type ThreadDock = {
  open: boolean;
  /** Whether the dock is taking the whole workspace, which only a dock that is showing ever does. */
  expanded: boolean;
  panels: string[];
  tab: string;
  /** The workflow the dock's workflow panel is following, kept per thread the way its panels are. */
  workflowId: string | null;
  browserTabs: BrowserTab[];
  browserTabId: string | null;
  terminals: TerminalSession[];
  terminalId: string | null;
};

/** What a dock helper needs of the workspace: whose dock is in front, and every dock there is. */
export type DockState = {
  currentId: string | null;
  sideChats: SideChat[];
  docks: Record<string, ThreadDock>;
  keyboardTab: string | null;
};

/** The dock tab that offers the panels, shown whenever no panel is on top. */
export const DOCK_PICKER = "home";

/** The dock the app shows while no thread is current, so a draft has a dock of its own too. */
export const DRAFT_DOCK = "draft";

export const EMPTY_DOCK: ThreadDock = {
  open: false,
  expanded: false,
  panels: [],
  tab: DOCK_PICKER,
  workflowId: null,
  browserTabs: [],
  browserTabId: null,
  terminals: [],
  terminalId: null,
};

/**
 * Whose dock a command belongs in: the thread it names, else the one the user is looking at. A side
 * chat is a tab within its source thread's dock, so its own commands land in that same dock.
 */
export function dockOwner(state: Pick<DockState, "currentId" | "sideChats">, taskId?: string | null): string {
  const id = taskId ?? state.currentId;
  if (!id) return DRAFT_DOCK;
  return state.sideChats.find((chat) => chat.id === id)?.sourceTaskId ?? id;
}

export function dockFor(state: Pick<DockState, "docks">, owner: string): ThreadDock {
  return state.docks[owner] ?? EMPTY_DOCK;
}

/** The dock tab the review is drawn in, which the picker and the composer both name. */
export const DIFF_PANEL = "diff";

/** The dock tab one workflow is followed in. */
export const WORKFLOW_PANEL = "workflow";

/** The dock in front, and whose it is: the pair every view command starts from. */
export function frontDock(state: Pick<DockState, "currentId" | "sideChats" | "docks">): { owner: string; dock: ThreadDock } {
  const owner = dockOwner(state);
  return { owner, dock: dockFor(state, owner) };
}

export function withDock<S extends Pick<DockState, "docks">>(state: S, owner: string, patch: Partial<ThreadDock>): S {
  return { ...state, docks: { ...state.docks, [owner]: { ...dockFor(state, owner), ...patch } } };
}

/** Which dock holds a page or a shell, for the events and commands that only name its id. */
export function ownerOfBrowserTab(state: Pick<DockState, "docks">, tabId: string): string | undefined {
  return Object.keys(state.docks).find((owner) => state.docks[owner].browserTabs.some((tab) => tab.id === tabId));
}

export function ownerOfTerminal(state: Pick<DockState, "docks">, terminalId: string): string | undefined {
  return Object.keys(state.docks).find((owner) => state.docks[owner].terminals.some((terminal) => terminal.id === terminalId));
}

/** The forks a dock draws as tabs: the ones taken from the thread that owns it. */
export function dockSideChats(state: Pick<DockState, "sideChats">, owner: string) {
  return state.sideChats.filter((chat) => chat.sourceTaskId === owner);
}

/**
 * What a dock tab is showing. A page and a shell are tabs in their own right rather than tabs within
 * a panel, so `tab` names one of them directly and there is one strip in the app, not two.
 */
export function dockTabKind(state: DockState, owner: string, tab: string) {
  const dock = dockFor(state, owner);
  if (dock.browserTabs.some((page) => page.id === tab)) return "browser" as const;
  if (dock.terminals.some((terminal) => terminal.id === tab)) return "terminal" as const;
  if (dockSideChats(state, owner).some((chat) => chat.id === tab)) return "side-chat" as const;
  return dock.panels.includes(tab) ? "panel" as const : "picker" as const;
}

/** Every tab in the dock, in the order the strip draws them. */
export function dockTabIds(state: DockState, owner: string) {
  const dock = dockFor(state, owner);
  return [
    ...dock.panels,
    ...dock.browserTabs.map((page) => page.id),
    ...dock.terminals.map((terminal) => terminal.id),
    ...dockSideChats(state, owner).map((chat) => chat.id),
  ];
}

/**
 * A dock tab holds the keyboard only while the dock in front is open and still has that tab. This is
 * deliberately not "is the tab in front": focus lands on a tab's button before the click that selects
 * it, so requiring that would throw the report away the instant it arrived.
 */
export function dockHoldsTab(state: DockState, tab: string): boolean {
  const { owner, dock } = frontDock(state);
  if (!dock.open) return false;
  return dock.panels.includes(tab)
    || dock.browserTabs.some((page) => page.id === tab)
    || dock.terminals.some((terminal) => terminal.id === tab)
    || dockSideChats(state, owner).some((chat) => chat.id === tab);
}

/** The shell holding the keyboard, when the tab holding it is one. ⌘J is about shells, not panels. */
export function keyboardTerminalId(state: DockState): string | null {
  const tab = state.keyboardTab;
  return tab && dockTabKind(state, dockOwner(state), tab) === "terminal" ? tab : null;
}

/** Which tab takes over when `tab` closes: its neighbour on the left, else on the right, else the picker. */
export function dockTabAfterClosing(state: DockState, owner: string, tab: string) {
  const tabs = dockTabIds(state, owner);
  const index = tabs.indexOf(tab);
  if (index === -1) return dockFor(state, owner).tab;
  const remaining = tabs.filter((id) => id !== tab);
  return remaining[index - 1] ?? remaining[index] ?? DOCK_PICKER;
}

export function activeBrowserTab(dock: ThreadDock) {
  return dock.browserTabs.find((tab) => tab.id === dock.browserTabId);
}

/** Which tab a browser command acts on: the one it names, else the one that dock is showing. */
export function browserTarget(dock: ThreadDock, tabId: string | undefined) {
  return tabId === undefined ? activeBrowserTab(dock) : dock.browserTabs.find((tab) => tab.id === tabId);
}

export function activeTerminal(dock: ThreadDock) {
  return dock.terminals.find((terminal) => terminal.id === dock.terminalId);
}

/**
 * Which terminal a read acts on: the one it names, else the one the asking thread opened, else the
 * one its dock is showing. A thread with a shell of its own never reads somebody else's by accident.
 */
export function terminalTarget(dock: ThreadDock, terminalId: string | undefined, taskId?: string) {
  if (terminalId !== undefined) return dock.terminals.find((terminal) => terminal.id === terminalId);
  const own = taskId === undefined ? undefined : dock.terminals.reduceRight<TerminalSession | undefined>((found, terminal) => found ?? (terminal.taskId === taskId ? terminal : undefined), undefined);
  return own ?? activeTerminal(dock);
}
