import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject, type WheelEvent } from "react";
import { LuChevronDown as ChevronDown, LuMaximize2 as Maximize2, LuMinimize2 as Minimize2, LuPanelRightClose as PanelRightClose, LuPlus as Plus, LuX as X } from "react-icons/lu";
import { ADD_TAB_MENU, type DockLauncher, type DockTab } from "./dock-registry";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";
import { moveListFocus, useDismissibleLayer } from "../focus";
import { shortcutTip } from "./TooltipLayer";
import { useTypeahead } from "./PopoverMenu";

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

/** Arrows, Home and End walk a menu's items, and typing jumps to the item whose name starts that way. */
function useMenuKeys() {
  const typeahead = useTypeahead();
  return (event: KeyboardEvent<HTMLElement>) => {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    if ((event.key === "Home" || event.key === "End") && rows.length) {
      event.preventDefault();
      rows[event.key === "Home" ? 0 : rows.length - 1]!.focus();
    } else if (!typeahead(event, rows)) moveListFocus(event);
  };
}

/** A mouse wheel turns the strip sideways, so tabs past its edge are reached without a trackpad. */
function scrollTabs(event: WheelEvent<HTMLElement>) {
  if (event.deltaX !== 0 || event.deltaY === 0) return;
  event.currentTarget.scrollLeft += event.deltaY;
}

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The tab's title, followed by what its count and dot stand for. */
function tabTip(tab: DockTab) {
  const status = [tab.badge ? tab.badgeLabel ?? String(tab.badge) : null, tab.unread ? "Waiting for you" : null].filter(Boolean);
  return [tab.title, ...status].join(" · ");
}

type Clipping = { overflowing: boolean; hidden: number };

/** How many tabs sit mostly past the strip's edges. */
function hiddenTabs(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  let hidden = 0;
  for (const tab of element.children) {
    const { left, right } = tab.getBoundingClientRect();
    const middle = (left + right) / 2;
    if (middle < box.left || middle > box.right) hidden += 1;
  }
  return hidden;
}

/** Whether the strip holds more tabs than it can show at once, and how many it has scrolled out of sight. */
function useClipping(strip: RefObject<HTMLElement | null>, count: number) {
  const [clipping, setClipping] = useState<Clipping>({ overflowing: false, hidden: 0 });
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const overflowing = element.scrollWidth > element.clientWidth + 1;
      const hidden = overflowing ? hiddenTabs(element) : 0;
      setClipping((current) => current.overflowing === overflowing && current.hidden === hidden ? current : { overflowing, hidden });
    };
    const scrolled = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    element.addEventListener("scroll", scrolled, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", scrolled);
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [strip, count]);
  return clipping;
}

/** Every open tab in one list, offered once the strip has clipped some of them past its edges. */
function TabList({ workspace, tabs, hidden, activeTab }: { workspace: Workspace; tabs: DockTab[]; hidden: number; activeTab: string }) {
  const open = workspace.openMenu === TABS_MENU;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(open, [root], () => workspace.actions.setOpenMenu(null), trigger);
  const menuKeys = useMenuKeys();
  return (
    <div ref={root} className={`right-dock-add right-dock-overflow ${open ? "open" : ""}`.trimEnd()} data-popover-menu>
      <button
        ref={trigger}
        type="button"
        aria-label={hidden ? `All tabs (${tabs.length}, ${hidden} out of view)` : `All tabs (${tabs.length})`}
        data-tip={open ? undefined : "All tabs"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => workspace.actions.setOpenMenu(open ? null : TABS_MENU)}
      >
        <ChevronDown size={16} />
        {hidden > 0 && <span aria-hidden="true">{hidden}</span>}
      </button>
      {open && (
        <div role="menu" aria-label="Open tabs" onKeyDown={menuKeys}>
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              role="menuitemradio"
              className={tab.unread ? "unread" : undefined}
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
  const { overflowing, hidden } = useClipping(strip, tabs.length);
  const menuKeys = useMenuKeys();
  /** Delete closes the focused tab, as the arrows move between them; a pinned tab stays. */
  const onStripKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Delete" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return moveTabFocus(event);
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.matches('[role="tab"]') ? document.activeElement : null;
    const tab = tabs.find((candidate) => candidate.id === focused?.closest<HTMLElement>("[data-dock-tab]")?.dataset.dockTab);
    if (!tab || tab.pinned) return;
    event.preventDefault();
    onCloseTab(tab.id);
  };
  useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTab]);
  return (
    <div className={`right-dock-tabs ${expanded && !sidebarOpen ? "traffic-inset" : ""}`.trimEnd()}>
      <div ref={strip} role="tablist" aria-label="Right panel tabs" onKeyDown={onStripKey} onWheel={scrollTabs}>
        {/** Marked here as well as on the view, so clicking a tab reports it while the caret is on its button. */}
        {tabs.map((tab, index) => (
          <div
            className={["right-dock-tab", activeTab === tab.id && "active", tab.unread && "unread"].filter(Boolean).join(" ")}
            key={tab.id}
            data-dock-tab={tab.id}
            onAuxClick={tab.pinned ? undefined : (event) => { if (event.button === 1) onCloseTab(tab.id); }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id || (index === 0 && !tabs.some((other) => other.id === activeTab)) ? 0 : -1}
              aria-keyshortcuts={tab.pinned ? undefined : "Delete"}
              data-tip={tabTip(tab)}
              data-tip-overflow={tab.badge || tab.unread ? undefined : true}
              onClick={() => void workspace.actions.selectDockTab(tab.id)}
            >
              <tab.icon size={16} aria-hidden="true" /><span>{tab.title}</span>
              {tab.badge ? <em className={tab.badgeTone} role="img" aria-label={tab.badgeLabel ?? String(tab.badge)}>{tab.badge}</em> : null}
              {tab.unread ? <span className="right-dock-tab-attention" role="img" aria-label="Waiting for you" /> : null}
            </button>
            {!tab.pinned && <button type="button" tabIndex={-1} aria-label={`Close ${tab.title}`} data-tip={activeTab === tab.id && !expanded ? shortcutTip("Close tab", "Mod+W") : "Close tab"} onClick={() => onCloseTab(tab.id)}><X size={14} /></button>}
          </div>
        ))}
      </div>
      {overflowing && <TabList workspace={workspace} tabs={tabs} hidden={hidden} activeTab={activeTab} />}
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
          <div role="menu" onKeyDown={menuKeys}>
            {launchers.map((launcher, index) => (
              <button
                key={launcher.id}
                type="button"
                role="menuitem"
                autoFocus={index === 0}
                aria-disabled={launcher.disabled || undefined}
                data-tip={launcher.disabledReason !== launcher.disabledLabel ? launcher.disabledReason : undefined}
                onClick={launcher.disabled ? undefined : () => { workspace.actions.setOpenMenu(null); launcher.open(); }}
              >
                <launcher.icon size={16} aria-hidden="true" />
                <span>{launcher.title}{launcher.disabledLabel && <small>{launcher.disabledLabel}</small>}</span>
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
        data-tip={shortcutTip(expanded ? "Restore panel" : "Expand panel", "Mod+Shift+\\")}
        onClick={() => void workspace.actions.setDockExpanded(!expanded)}
      >
        {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <button className="right-dock-hide" type="button" aria-label="Hide right panel" data-tip={shortcutTip("Hide panel", "Mod+\\")} onClick={() => void workspace.actions.setDockOpen(false)}><PanelRightClose size={18} /></button>
    </div>
  );
}
