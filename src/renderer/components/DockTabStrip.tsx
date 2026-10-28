import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject, type WheelEvent } from "react";
import { LuChevronDown as ChevronDown, LuMaximize2 as Maximize2, LuMinimize2 as Minimize2, LuPanelRightClose as PanelRightClose, LuPlus as Plus, LuX as X } from "react-icons/lu";
import { ADD_TAB_MENU, type DockLauncher, type DockTab } from "./dock-registry";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { moveListFocus, useDismissibleLayer } from "../focus";
import { shortcutTip } from "./TooltipLayer";

const TABS_MENU = "dock:tabs";

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

/** A mouse wheel turns the strip sideways, so tabs past its edge are reached without a trackpad. */
function scrollTabs(event: WheelEvent<HTMLElement>) {
  if (event.deltaX !== 0 || event.deltaY === 0) return;
  event.currentTarget.scrollLeft += event.deltaY;
}

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** Whether the strip holds more tabs than it can show at once. */
function useOverflowing(strip: RefObject<HTMLElement | null>, count: number) {
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [strip, count]);
  return overflowing;
}

/** Every open tab in one list, offered once the strip has clipped some of them past its edges. */
function TabList({ workspace, tabs, activeTab }: { workspace: Workspace; tabs: DockTab[]; activeTab: string }) {
  const open = workspace.openMenu === TABS_MENU;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(open, [root], () => workspace.actions.setOpenMenu(null), trigger);
  return (
    <div ref={root} className={`right-dock-add right-dock-overflow ${open ? "open" : ""}`.trimEnd()} data-popover-menu>
      <button
        ref={trigger}
        type="button"
        aria-label={`All tabs (${tabs.length})`}
        data-tip={open ? undefined : "All tabs"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => workspace.actions.setOpenMenu(open ? null : TABS_MENU)}
      >
        <ChevronDown size={16} />
      </button>
      {open && (
        <div role="menu" aria-label="Open tabs" onKeyDown={moveListFocus}>
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              role="menuitemradio"
              aria-checked={activeTab === tab.id}
              autoFocus={activeTab === tab.id || (index === 0 && !tabs.some((other) => other.id === activeTab))}
              onClick={() => { workspace.actions.setOpenMenu(null); void workspace.actions.selectDockTab(tab.id); }}
            >
              <tab.icon size={16} aria-hidden="true" />
              <span>{tab.title}</span>
              {tab.unread ? <span className="right-dock-tab-attention" role="img" aria-label="Waiting for you" /> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const strip = useRef<HTMLDivElement>(null);
  const overflowing = useOverflowing(strip, tabs.length);
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab]);
  return (
    <div className={`right-dock-tabs ${expanded && !sidebarOpen ? "traffic-inset" : ""}`.trimEnd()}>
      <div ref={strip} role="tablist" aria-label="Right panel tabs" onKeyDown={moveTabFocus} onWheel={scrollTabs}>
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
              data-tip={tab.title}
              data-tip-overflow
              onClick={() => void workspace.actions.selectDockTab(tab.id)}
            >
              <tab.icon size={16} aria-hidden="true" /><span>{tab.title}</span>
              {tab.badge ? <em className={tab.attention ? "attention" : undefined} role="img" aria-label={tab.badgeLabel ?? String(tab.badge)} data-tip={tab.badgeLabel}>{tab.badge}</em> : null}
              {tab.unread ? <span className="right-dock-tab-attention" role="img" aria-label="Waiting for you" data-tip="Waiting for you" /> : null}
            </button>
            {!tab.pinned && <button type="button" tabIndex={-1} aria-label={`Close ${tab.title}`} data-tip={activeTab === tab.id && !expanded ? shortcutTip("Close tab", "Mod+W") : "Close tab"} onClick={() => onCloseTab(tab.id)}><X size={14} /></button>}
          </div>
        ))}
      </div>
      {overflowing && <TabList workspace={workspace} tabs={tabs} activeTab={activeTab} />}
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
              <button
                key={launcher.id}
                type="button"
                role="menuitem"
                autoFocus={index === 0}
                aria-disabled={launcher.disabled || undefined}
                data-tip={launcher.disabledReason}
                onClick={launcher.disabled ? undefined : () => { workspace.actions.setOpenMenu(null); launcher.open(); }}
              >
                <launcher.icon size={16} aria-hidden="true" />
                <span>{launcher.title}</span>
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
        data-tip={shortcutTip(expanded ? "Restore panel" : "Expand panel", "Mod+Shift+\\")}
        onClick={() => void workspace.actions.setDockExpanded(!expanded)}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <button className="right-dock-hide" type="button" aria-label="Hide right panel" data-tip={shortcutTip("Hide panel", "Mod+\\")} onClick={() => void workspace.actions.setDockOpen(false)}><PanelRightClose size={18} /></button>
    </div>
  );
}
