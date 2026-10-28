import type { KeyboardEvent, RefObject, SyntheticEvent } from "react";
import { LuMaximize2 as Maximize2, LuMinimize2 as Minimize2, LuPanelRightClose as PanelRightClose, LuPlus as Plus, LuX as X } from "react-icons/lu";
import { ADD_TAB_MENU, type DockLauncher, type DockTab } from "./dock-registry";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { moveListFocus } from "../focus";
import { MAC } from "../platform";
import { displayShortcut } from "../../domain/shortcuts";

const tip = (label: string, binding: string) => `${label} (${displayShortcut(binding, MAC)})`;

/** Left and Right walk the tabs, Home and End jump to either end; the strip is one stop for Tab. */
function moveTabFocus(event: KeyboardEvent<HTMLElement>) {
  const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[event.key];
  if (step === undefined) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at === -1 || tabs.length === 0) return;
  event.preventDefault();
  const next = Number.isFinite(step) ? (at + step + tabs.length) % tabs.length : step < 0 ? 0 : tabs.length - 1;
  tabs[next].focus();
  tabs[next].scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** A tab names itself in a tooltip only while its title is cut short. */
function tipWhenClipped({ currentTarget: tab }: SyntheticEvent<HTMLElement>) {
  const title = tab.querySelector<HTMLElement>(":scope > span:not([role])");
  if (title && title.scrollWidth > title.clientWidth) tab.dataset.tip = title.textContent ?? "";
  else delete tab.dataset.tip;
}

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
      <div role="tablist" aria-label="Right panel tabs" onKeyDown={moveTabFocus}>
        {/** Marked here as well as on the view, so clicking a tab reports it while the caret is on its button. */}
        {tabs.map((tab, index) => (
          <div
            className={`right-dock-tab ${activeTab === tab.id ? "active" : ""}`}
            key={tab.id}
            data-dock-tab={tab.id}
            onAuxClick={tab.pinned ? undefined : (event) => { if (event.button === 1) onCloseTab(tab.id); }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id || (index === 0 && !tabs.some((other) => other.id === activeTab)) ? 0 : -1}
              onPointerEnter={tipWhenClipped}
              onFocus={tipWhenClipped}
              onClick={() => void workspace.actions.selectDockTab(tab.id)}
            >
              <tab.icon size={16} aria-hidden="true" /><span>{tab.title}</span>
              {tab.badge ? <em className={tab.attention ? "attention" : undefined} role="img" aria-label={tab.badgeLabel ?? String(tab.badge)} data-tip={tab.badgeLabel}>{tab.badge}</em> : null}
              {tab.unread ? <span className="right-dock-tab-attention" role="img" aria-label="Waiting for you" data-tip="Waiting for you" /> : null}
            </button>
            {!tab.pinned && <button type="button" aria-label={`Close ${tab.title}`} data-tip="Close tab" onClick={() => onCloseTab(tab.id)}><X size={14} /></button>}
          </div>
        ))}
      </div>
      <div ref={addMenu} className={`right-dock-add ${addMenuOpen ? "open" : ""}`.trimEnd()} data-popover-menu>
        <button
          ref={addMenuTrigger}
          type="button"
          aria-label="Add right panel tab"
          data-tip={addMenuOpen ? undefined : "New tab"}
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
                <launcher.icon size={16} aria-hidden="true" />
                <span><strong>{launcher.title}</strong>{launcher.disabledReason && <small>{launcher.disabledReason}</small>}</span>
                {!launcher.disabled && <kbd aria-hidden="true">/{launcher.command}</kbd>}
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
        data-tip={tip(expanded ? "Restore panel" : "Expand panel", "Mod+Shift+\\")}
        onClick={() => void workspace.actions.setDockExpanded(!expanded)}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <button className="right-dock-hide" type="button" aria-label="Hide right panel" data-tip={tip("Hide panel", "Mod+\\")} onClick={() => void workspace.actions.setDockOpen(false)}><PanelRightClose size={18} /></button>
    </div>
  );
}
