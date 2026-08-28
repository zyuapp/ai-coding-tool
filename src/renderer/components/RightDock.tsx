import { useCallback, useRef, type ReactNode } from "react";
import { LuGitFork as GitFork, LuGlobe as Globe, LuSquareTerminal as SquareTerminal } from "react-icons/lu";
import { DockContent } from "./DockContent";
import { DockTabStrip } from "./DockTabStrip";
import { ADD_TAB_MENU, type DockLauncher, type DockPanel, type DockTab } from "./dock-registry";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { useDismissibleLayer } from "../focus";
import { browserTabTitle } from "../../domain/browser";
import type { FindView } from "../../application/workspace-state";

type Workspace = ReturnType<typeof useTaskWorkspace>;

function resizeRightDock(target: HTMLElement, clientX: number) {
  const panel = target.parentElement;
  const parent = panel?.parentElement;
  if (!panel || !parent) return;
  const bounds = parent.getBoundingClientRect();
  parent.style.setProperty("--right-dock-width", `${Math.min(bounds.width - 320, Math.max(320, bounds.right - clientX))}px`);
}

/** The right dock: its tab strip, the view the selected tab draws, and the edge that resizes it. */
export function RightDock({ workspace, panels, launchers, open, expanded, sidebarOpen, settingsVisible, find, findBar }: {
  workspace: Workspace;
  panels: DockPanel[];
  launchers: DockLauncher[];
  open: boolean;
  expanded: boolean;
  sidebarOpen: boolean;
  settingsVisible: boolean;
  find: FindView | null;
  findBar: ReactNode;
}) {
  const activeTab = workspace.dockTab;
  const addMenuOpen = workspace.openMenu === ADD_TAB_MENU;
  const addMenu = useRef<HTMLDivElement>(null);
  const addMenuTrigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(addMenuOpen, [addMenu], () => workspace.actions.setOpenMenu(null), addMenuTrigger);

  /** Which dock tab was last asked to take the keyboard, as the count the view watches. */
  const dockFocus = workspace.dockFocus;
  const focusTokenFor = useCallback((tab: string) => dockFocus?.tab === tab ? dockFocus.count : 0, [dockFocus]);

  const tabs: DockTab[] = [
    ...panels.filter((panel) => workspace.dockPanels.includes(panel.id)).map(({ id, title, icon, badge }) => ({ id, title, icon, badge })),
    ...workspace.browserTabs.map((tab) => ({ id: tab.id, title: browserTabTitle(tab), icon: Globe })),
    ...workspace.terminals.map((terminal) => ({ id: terminal.id, title: terminal.title, icon: SquareTerminal })),
    ...workspace.sideChats.map((chat) => ({ id: chat.id, title: chat.title, icon: GitFork })),
  ];

  /** The strip keeps the keyboard when a tab goes, so closing several in a row never needs the mouse. */
  const held = useRef({ workspace });
  held.current.workspace = workspace;
  const closeTab = useCallback(async (id: string) => {
    const { dockPanels, browserTabs, terminals, actions, dispatch } = held.current.workspace;
    if (dockPanels.includes(id)) await actions.closeDockPanel(id);
    else if (browserTabs.some((tab) => tab.id === id)) await actions.closeBrowserTab(id);
    else if (terminals.some((terminal) => terminal.id === id)) await actions.closeTerminal(id);
    else await dispatch({ type: "side-chat.close", chatId: id });
    requestAnimationFrame(() => {
      (document.querySelector<HTMLElement>('.right-dock-tab.active [role="tab"]') ?? addMenuTrigger.current)?.focus();
    });
  }, []);
  const onCloseTab = useCallback((id: string) => void closeTab(id), [closeTab]);

  return (
    <aside className="right-dock" aria-label="Right panel" hidden={!open}>
      <div
        className="right-dock-resizer"
        role="separator"
        aria-label="Resize right panel"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeRightDock(event.currentTarget, event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const panel = event.currentTarget.parentElement;
          if (panel) resizeRightDock(event.currentTarget, panel.getBoundingClientRect().left + (event.key === "ArrowLeft" ? -10 : 10));
        }}
      />
      <DockTabStrip
        workspace={workspace}
        tabs={tabs}
        launchers={launchers}
        activeTab={activeTab}
        expanded={expanded}
        sidebarOpen={sidebarOpen}
        addMenuOpen={addMenuOpen}
        addMenu={addMenu}
        addMenuTrigger={addMenuTrigger}
        onCloseTab={onCloseTab}
      />
      <DockContent
        workspace={workspace}
        panels={panels}
        launchers={launchers}
        activeTab={activeTab}
        find={find}
        findBar={findBar}
        dockOpen={open}
        settingsVisible={settingsVisible}
        focusTokenFor={focusTokenFor}
        onCloseTab={onCloseTab}
      />
    </aside>
  );
}
