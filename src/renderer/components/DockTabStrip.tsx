import type { RefObject } from "react";
import { LuMaximize2 as Maximize2, LuMinimize2 as Minimize2, LuPlus as Plus, LuX as X } from "react-icons/lu";
import { ADD_TAB_MENU, type DockLauncher, type DockTab } from "./dock-registry";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { moveListFocus } from "../focus";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The dock's tab strip: one row per open view, the add menu, and the expand and hide controls. */
export function DockTabStrip({ workspace, tabs, launchers, activeTab, expanded, sidebarOpen, addMenuOpen, addMenu, addMenuTrigger, onCloseTab }: {
  workspace: Workspace;
  tabs: DockTab[];
  launchers: DockLauncher[];
  activeTab: string;
  expanded: boolean;
  sidebarOpen: boolean;
  addMenuOpen: boolean;
  addMenu: RefObject<HTMLDivElement | null>;
  addMenuTrigger: RefObject<HTMLButtonElement | null>;
  onCloseTab: (id: string) => void;
}) {
  return (
    <div className={`right-dock-tabs ${expanded && !sidebarOpen ? "traffic-inset" : ""}`.trimEnd()}>
      <div role="tablist" aria-label="Right panel tabs">
        {/** Marked here as well as on the view, so clicking a tab reports it while the caret is on its button. */}
        {tabs.map((tab) => (
          <div className={`right-dock-tab ${activeTab === tab.id ? "active" : ""}`} key={tab.id} data-dock-tab={tab.id}>
            <button type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => void workspace.actions.selectDockTab(tab.id)}>
              <tab.icon size={15} aria-hidden="true" /><span>{tab.title}</span>
              {tab.badge ? <em>{tab.badge}</em> : null}
            </button>
            <button type="button" aria-label={`Close ${tab.title}`} onClick={() => onCloseTab(tab.id)}><X size={13} /></button>
          </div>
        ))}
      </div>
      <div ref={addMenu} className={`right-dock-add ${addMenuOpen ? "open" : ""}`.trimEnd()} data-popover-menu>
        <button
          ref={addMenuTrigger}
          type="button"
          aria-label="Add right panel tab"
          aria-haspopup="menu"
          aria-expanded={addMenuOpen}
          onClick={() => workspace.actions.setOpenMenu(addMenuOpen ? null : ADD_TAB_MENU)}
        >
          <Plus size={18} />
        </button>
        {addMenuOpen && (
          <div role="menu" onKeyDown={moveListFocus}>
            {launchers.map((launcher, index) => (
              <button key={launcher.id} type="button" role="menuitem" autoFocus={index === 0} disabled={launcher.disabled} onClick={() => { workspace.actions.setOpenMenu(null); launcher.open(); }}>
                <launcher.icon size={16} />{launcher.title}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        className="right-dock-hide"
        type="button"
        aria-label={`${expanded ? "Restore" : "Expand"} right panel`}
        aria-pressed={expanded}
        onClick={() => void workspace.actions.setDockExpanded(!expanded)}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <button className="right-dock-hide" type="button" aria-label="Hide right panel" onClick={() => void workspace.actions.setDockOpen(false)}><X size={17} /></button>
    </div>
  );
}
