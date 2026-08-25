/** The dock itself: its tabs, its panels, and how much of the window it takes. */
import { apply } from "./dispatch.js";
import { DIFF_PANEL, TAKE_KEYS, WORKFLOW_PANEL, browserEffectsForTab, focusDockTab, initialRange, readDiff, settled } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { diffFor, dockOwner, dockTabAfterClosing, dockTabIds, dockTabKind, frontDock, withDock, type WorkspaceState } from "../workspace-state.js";

type DockInput = Extract<WorkspaceInput, {
  type: "view.close-tab" | "view.new-tab" | "view.select-dock-index" | "view.set-dock-open" | "view.set-dock-expanded"
    | "view.open-dock-panel" | "view.open-workflow" | "view.close-dock-panel" | "view.select-dock-tab";
}>;

export function reduceDock(state: WorkspaceState, input: DockInput): WorkspaceTransition {
  switch (input.type) {
    case "view.close-tab": {
      const { owner, dock } = frontDock(state);
      if (state.projectEdit) return settled({ ...state, projectEdit: null });
      if (state.settingsOpen || state.computerUseSetup) return settled({ ...state, settingsOpen: false, computerUseSetup: false });
      if (!dock.open) return settled(state, [{ type: "close-window" }]);
      /** A dock across the whole workspace is the frontmost thing there is, so it gives that up first. */
      if (dock.expanded) return settled(withDock(state, owner, { expanded: false }));
      const kind = dockTabKind(state, owner, dock.tab);
      const closed = kind === "picker" ? settled(withDock(state, owner, { open: false }))
        : kind === "browser" ? apply(state, { type: "browser.close-tab", tabId: dock.tab })
        : kind === "terminal" ? apply(state, { type: "terminal.close", terminalId: dock.tab })
        : apply(state, kind === "side-chat"
          ? { type: "side-chat.close", chatId: dock.tab }
          : { type: "view.close-dock-panel", panel: dock.tab });
      /** Whatever the closed view was holding is gone with it, so the window takes the keys back. */
      return { state: closed.state, effects: [...closed.effects, ...TAKE_KEYS] };
    }

    /** ⌘W's inverse, answering with whatever the panel is showing rather than one fixed thing. */
    case "view.new-tab": {
      if (state.settingsOpen) return settled(state);
      const { owner, dock } = frontDock(state);
      const kind = dock.open ? dockTabKind(state, owner, dock.tab) : "picker";
      return apply(state, kind === "browser" ? { type: "browser.new-tab" } : { type: "terminal.open" });
    }

    case "view.select-dock-index": {
      const owner = dockOwner(state);
      const tabs = dockTabIds(state, owner);
      const tab = input.index === -1 ? tabs[tabs.length - 1] : tabs[input.index];
      return tab ? apply(state, { type: "view.select-dock-tab", tab }) : settled(state);
    }

    case "view.set-dock-open": {
      const { owner, dock } = frontDock(state);
      if (dock.open === input.open) return settled(state);
      const toggled = withDock(state, owner, { open: input.open });
      /** A panel shown is one to work in; a panel hidden must not leave a page it was drawing with the keys. */
      if (!input.open) return settled(withDock(toggled, owner, { expanded: false }), TAKE_KEYS);
      return dockTabKind(toggled, owner, dock.tab) === "picker" ? settled(toggled) : focusDockTab(toggled, owner, dock.tab);
    }

    case "view.set-dock-expanded": {
      const { owner, dock } = frontDock(state);
      if (dock.expanded === input.expanded) return settled(state);
      /** Taking the whole workspace is also a way of asking for the dock, so expanding shows it. */
      const toggled = withDock(state, owner, { expanded: input.expanded, open: input.expanded || dock.open });
      return dockTabKind(toggled, owner, dock.tab) === "picker" ? settled(toggled) : focusDockTab(toggled, owner, dock.tab);
    }

    case "view.open-dock-panel": {
      const { owner, dock } = frontDock(state);
      const panels = dock.panels.includes(input.panel) ? dock.panels : [...dock.panels, input.panel];
      const shown = focusDockTab(withDock(state, owner, { open: true, panels, tab: input.panel }), owner, input.panel);
      const opened = shown.state;
      const effects = [...browserEffectsForTab(opened, owner, input.panel), ...shown.effects];
      /** However the review is reached, it opens on a list read now rather than one read last time. */
      if (input.panel !== DIFF_PANEL) return settled(opened, effects);
      const diff = diffFor(opened, owner);
      const read = readDiff(opened, owner, initialRange(opened, diff));
      return { state: read.state, effects: [...effects, ...read.effects] };
    }

    case "view.open-workflow": {
      const listed = state.currentId ? state.workflows[state.currentId] ?? [] : [];
      if (!listed.some((workflow) => workflow.id === input.workflowId)) return settled(state);
      const opened = withDock(state, dockOwner(state), { workflowId: input.workflowId });
      return apply(opened, { type: "view.open-dock-panel", panel: WORKFLOW_PANEL });
    }

    case "view.close-dock-panel": {
      const { owner, dock } = frontDock(state);
      if (!dock.panels.includes(input.panel)) return settled(state);
      const tab = dock.tab === input.panel ? dockTabAfterClosing(state, owner, input.panel) : dock.tab;
      const closed = withDock(state, owner, {
        panels: dock.panels.filter((panel) => panel !== input.panel),
        tab,
        ...(input.panel === WORKFLOW_PANEL ? { workflowId: null } : {}),
      });
      return settled(closed, browserEffectsForTab(closed, owner, tab));
    }

    case "view.select-dock-tab": {
      const owner = dockOwner(state);
      const kind = dockTabKind(state, owner, input.tab);
      const shown = withDock(state, owner, {
        tab: input.tab,
        open: true,
        ...(kind === "browser" ? { browserTabId: input.tab } : {}),
        ...(kind === "terminal" ? { terminalId: input.tab } : {}),
      });
      const selected = focusDockTab(shown, owner, input.tab);
      return settled(selected.state, [...browserEffectsForTab(selected.state, owner, input.tab), ...selected.effects]);
    }
  }
}
