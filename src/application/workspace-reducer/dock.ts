/** The dock itself: its tabs, its panels, and how much of the window it takes. */
import { newBrowserTab } from "./browser.js";
import { reduceTerminal } from "./terminal.js";
import { andThen, type Step } from "./slice.js";
import { settingsShown } from "./settings.js";
import { sideChatsClosed } from "./side-chats.js";
import { browserEffectsForTab, browserTabClosed } from "./browser-tabs.js";
import { moveDismissedIn, worktreesOf } from "./worktree-claims.js";
import { editorClosedIn, projectsOf } from "../project-commands.js";
import { archivePromptIn, dialogsOf, forkNameIn } from "../workspace-dialogs.js";
import { defaultBranchRange, diffRead, initialRange } from "./diff-reads.js";
import { subjectWorkspaceId } from "./environment.js";
import { TAKE_KEYS, docksOf, editDock, focusDockTabIn, overviewFoldIn, type DocksEdit } from "./dock-tabs.js";
import { followUps } from "./shared.js";
import { readIn, threadsOf } from "./thread-edits.js";
import type { WorkspaceInput } from "./types.js";
import { isOverviewSection } from "../../domain/coordination.js";
import { DIFF_PANEL, DOCK_PICKER, OVERVIEW_PANEL, WORKFLOW_PANEL, diffFor, dockOwner, dockTabAfterClosing, dockTabIds, dockTabKind, frontDock, ownerOfBrowserTab, type WorkspaceState } from "../workspace-state.js";

export const DOCK_INPUTS = [
  "view.close-tab", "view.new-tab", "view.select-dock-index", "view.set-dock-open", "view.set-dock-expanded", "view.open-dock-panel",
  "view.open-workflow", "view.close-dock-panel", "view.select-dock-tab", "view.close-thread-tab", "view.set-overview-group"
] as const;
type DockInput = Extract<WorkspaceInput, { type: (typeof DOCK_INPUTS)[number] }>;

/** Reads the review for the checkout it is about now, starting over when that is another checkout. */
function reviewSubject(state: WorkspaceState, owner: string): Step {
  const diff = diffFor(state, owner);
  if (diff.workspaceId === null || diff.workspaceId === subjectWorkspaceId(state, owner)) return diffRead(state, owner, initialRange(state, owner, diff));
  const range = diff.mode === "uncommitted" ? diff.range : defaultBranchRange(state, owner);
  return diffRead(state, owner, range, { result: null, collapsed: [], viewed: {} });
}

/** ⌘W: whatever is in front closes, a dialog before the settings, the settings before the dock, and the dock's tab before the window. */
function closeFront(state: WorkspaceState): Step {
  const { owner, dock } = frontDock(state);
  if (state.worktreeMove) return { edits: [moveDismissedIn(worktreesOf(state))] };
  if (state.forkName) return { edits: [forkNameIn(dialogsOf(state), null)] };
  if (state.archivePrompt) return { edits: [archivePromptIn(dialogsOf(state), null)] };
  if (state.projectEdit) return { edits: [editorClosedIn(projectsOf(state))] };
  if (state.settingsOpen || state.computerUseSetup) return settingsShown(state, false);
  if (!dock.open) return { effects: [{ type: "close-window" }] };
  /** A dock across the whole workspace is the frontmost thing there is, so it gives that up first. */
  if (dock.expanded) return { edits: [editDock(docksOf(state), owner, { expanded: false })] };
  const kind = dockTabKind(state, owner, dock.tab);
  /** Overview does not close, so ⌘W on it hides the dock the way it does on the picker. */
  const closed = kind === "picker" || dock.tab === OVERVIEW_PANEL ? { edits: [editDock(docksOf(state), owner, { open: false })] }
    : kind === "browser" ? browserTabClosed(state, ownerOfBrowserTab(state, dock.tab) ?? dockOwner(state), dock.tab)
    : kind === "terminal" ? reduceTerminal(state, { type: "terminal.close", terminalId: dock.tab })
    : kind === "side-chat" ? sideChatsClosed(state, state.sideChats.filter((chat) => chat.id === dock.tab))
    : kind === "thread" ? reduceDock(state, { type: "view.close-thread-tab", taskId: dock.tab })
    : reduceDock(state, { type: "view.close-dock-panel", panel: dock.tab });
  /** Whatever the closed view was holding is gone with it, so the window takes the keys back. */
  return { ...closed, effects: [...closed.effects ?? [], ...TAKE_KEYS] };
}

export function reduceDock(state: WorkspaceState, input: DockInput): Step {
  switch (input.type) {
    case "view.close-tab":
      return closeFront(state);

    /** ⌘W's inverse, answering with whatever the panel is showing rather than one fixed thing. */
    case "view.new-tab": {
      if (state.settingsOpen) return {};
      const { owner, dock } = frontDock(state);
      const kind = dock.open ? dockTabKind(state, owner, dock.tab) : "picker";
      return kind === "browser" ? newBrowserTab(state) : reduceTerminal(state, { type: "terminal.open" });
    }

    case "view.select-dock-index": {
      const owner = dockOwner(state);
      const tabs = dockTabIds(state, owner);
      const tab = input.index === -1 ? tabs[tabs.length - 1] : tabs[input.index];
      return tab ? reduceDock(state, { type: "view.select-dock-tab", tab }) : {};
    }

    case "view.set-dock-open": {
      const { owner, dock } = frontDock(state);
      if (dock.open === input.open) return {};
      const toggled = editDock(docksOf(state), owner, { open: input.open });
      /** A panel shown is one to work in; a panel hidden must not leave a page it was drawing with the keys. */
      if (!input.open) return { edits: [editDock(toggled, owner, { expanded: false })], effects: TAKE_KEYS };
      return focusedUnlessPicker(state, toggled, owner, dock.tab);
    }

    case "view.set-dock-expanded": {
      const { owner, dock } = frontDock(state);
      if (dock.expanded === input.expanded) return {};
      /** Taking the whole workspace is also a way of asking for the dock, so expanding shows it. */
      return focusedUnlessPicker(state, editDock(docksOf(state), owner, { expanded: input.expanded, open: input.expanded || dock.open }), owner, dock.tab);
    }

    case "view.open-dock-panel": {
      const { owner, dock } = frontDock(state);
      const panels = dock.panels.includes(input.panel) ? dock.panels : [...dock.panels, input.panel];
      const subject = input.taskId && dock.threadTabs.includes(input.taskId) ? input.taskId : undefined;
      const { [input.panel]: _previous, ...others } = dock.subjects;
      const subjects = subject ? { ...others, [input.panel]: subject } : others;
      const shown = focusDockTabIn(editDock(docksOf(state), owner, { open: true, panels, tab: input.panel, subjects }), owner, input.panel);
      const opened: Step = { edits: [shown.docks], effects: [...browserEffectsForTab(shown.docks.view, owner, input.panel), ...shown.effects] };
      /** However the review is reached, it opens on a list read now rather than one read last time. */
      if (input.panel !== DIFF_PANEL) return opened;
      return andThen(state, opened, (next) => reviewSubject(next, owner));
    }

    case "view.open-workflow": {
      const listed = state.currentId ? state.workflows[state.currentId] ?? [] : [];
      if (!listed.some((workflow) => workflow.id === input.workflowId)) return {};
      const following: Step = { edits: [editDock(docksOf(state), dockOwner(state), { workflowId: input.workflowId })] };
      return andThen(state, following, (opened) => reduceDock(opened, { type: "view.open-dock-panel", panel: WORKFLOW_PANEL }));
    }

    case "view.close-dock-panel": {
      const { owner, dock } = frontDock(state);
      if (!dock.panels.includes(input.panel) || input.panel === OVERVIEW_PANEL) return {};
      const tab = dock.tab === input.panel ? dockTabAfterClosing(state, owner, input.panel) : dock.tab;
      const closed = editDock(docksOf(state), owner, {
        panels: dock.panels.filter((panel) => panel !== input.panel),
        tab,
        ...(input.panel === WORKFLOW_PANEL ? { workflowId: null } : {}),
      });
      return { edits: [closed], effects: browserEffectsForTab(closed.view, owner, tab) };
    }

    case "view.close-thread-tab": {
      const { owner, dock } = frontDock(state);
      if (!dock.threadTabs.includes(input.taskId)) return {};
      const last = dock.threadTabs.length === 1 && dock.panels.includes(OVERVIEW_PANEL);
      const tab = dock.tab !== input.taskId ? dock.tab : last ? OVERVIEW_PANEL : dockTabAfterClosing(state, owner, input.taskId);
      /** Closing a coordinator's last thread tab falls back to its Overview; with nothing to fall back to, the dock hides. */
      const open = dock.open && tab !== DOCK_PICKER;
      const subjects = Object.fromEntries(Object.entries(dock.subjects).filter(([, id]) => id !== input.taskId));
      const closed = editDock(docksOf(state), owner, { threadTabs: dock.threadTabs.filter((id) => id !== input.taskId), tab, open, subjects, ...(open ? {} : { expanded: false }) });
      const closing: Step = { edits: [closed], effects: open ? browserEffectsForTab(closed.view, owner, tab) : TAKE_KEYS };
      /** A review of the closed tab's checkout goes back to the dock's own. */
      if (dock.subjects[DIFF_PANEL] !== input.taskId || !dock.panels.includes(DIFF_PANEL)) return closing;
      return andThen(state, closing, (next) => {
        const reread = reviewSubject(next, owner);
        return { ...reread, effects: followUps(reread.effects ?? []) };
      });
    }

    case "view.set-overview-group": {
      /** The coordinator may run on a paired computer, so its id is not looked up here. */
      if (!isOverviewSection(input.group)) return {};
      const fold = state.overviewFolds[input.taskId]?.[input.group] ?? {};
      const next = { ...fold, ...(input.open === undefined ? {} : { open: input.open }), ...(input.all ? { all: true as const } : {}) };
      if (next.open === fold.open && next.all === fold.all) return {};
      return { edits: [overviewFoldIn(docksOf(state), input.taskId, input.group, next)] };
    }

    case "view.select-dock-tab": {
      const owner = dockOwner(state);
      const kind = dockTabKind(state, owner, input.tab);
      const shown = editDock(docksOf(state), owner, {
        tab: input.tab,
        open: true,
        ...(kind === "browser" ? { browserTabId: input.tab } : {}),
        ...(kind === "terminal" ? { terminalId: input.tab } : {}),
      });
      const selected = focusDockTabIn(shown, owner, input.tab);
      /** A side chat or a thread's tab is a thread, so bringing it to the front is landing on it. */
      const read = kind === "side-chat" || kind === "thread" ? [readIn(threadsOf(state), input.tab)] : [];
      return { edits: [...read, selected.docks], effects: [...browserEffectsForTab(selected.docks.view, owner, input.tab), ...selected.effects] };
    }
  }
}

/** A dock just shown or widened hands its tab the keys, unless that tab is the picker. */
function focusedUnlessPicker(state: WorkspaceState, docks: DocksEdit, owner: string, tab: string): Step {
  if (dockTabKind(state, owner, tab) === "picker") return { edits: [docks] };
  const focused = focusDockTabIn(docks, owner, tab);
  return { edits: [focused.docks], effects: focused.effects };
}
