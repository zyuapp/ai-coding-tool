import { useLayoutEffect, useRef, useState } from "react";
import { LuArrowDownWideNarrow as RankIcon, LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight, LuMonitor as Monitor, LuMonitorOff as MonitorOff } from "react-icons/lu";
import { awayStatus, type ComputerFilter, type ComputerLink } from "../../domain/computers";
import type { SidebarMode } from "../../domain/sidebar";
import { useDismissibleLayer } from "../focus";
import { MenuList, type MenuItem } from "./PopoverMenu";
import { shortcutTip } from "./TooltipLayer";

const BACK_TIP = shortcutTip("Back", "Mod+[");
const FORWARD_TIP = shortcutTip("Forward", "Mod+]");

type ComputerSwitchProps = {
  links: ComputerLink[];
  /** What this computer calls itself. */
  name: string;
  filter: ComputerFilter;
  onSetFilter: (filter: ComputerFilter) => void;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

const COMPUTER_MENU = "sidebar:computers";

/**
 * Which computers' threads the lists below draw: every one, this one, or one paired computer. A
 * header button the size of its neighbours, pressed while the lists are narrowed to one computer.
 */
function ComputerSwitch({ links, name, filter, onSetFilter, openMenu, onSetOpenMenu }: ComputerSwitchProps) {
  const open = openMenu === COMPUTER_MENU;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(open, [root], () => onSetOpenMenu(null), trigger);
  /** A computer that is not connected says whether it is being dialled again or waiting to be. */
  const choices: Array<{ filter: ComputerFilter; label: string; away?: string }> = [
    { filter: "all", label: "All" },
    { filter: "this", label: name || "This computer" },
    ...links.map((link) => ({ filter: link.id, label: link.name, ...(link.status !== "connected" ? { away: awayStatus(link.status) } : {}) })),
  ];
  const selected = choices.find((choice) => choice.filter === filter) ?? choices[0]!;
  const narrowed = selected.filter !== "all";
  const Screen = selected.away ? MonitorOff : Monitor;
  const tip = !narrowed ? "Computers" : selected.filter === "this" ? `Only ${name || "this computer"}` : `Only ${selected.label}${selected.away ? ` (${selected.away})` : ""}`;
  const entries: MenuItem[] = choices.map((choice) => ({
    label: choice.label,
    checked: filter === choice.filter,
    className: choice.away ? "offline" : undefined,
    title: choice.away ? `${choice.label} is ${choice.away}` : undefined,
    onSelect: () => onSetFilter(choice.filter),
  }));
  return (
    <div ref={root} className="computer-switch" data-popover-menu onBlur={(event) => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
    }}>
      <button
        ref={trigger}
        type="button"
        className={`thread-nav-button computer-switch-trigger${narrowed ? " active" : ""}${selected.away ? " offline" : ""}`}
        aria-label="Computers"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={tip}
        onClick={() => onSetOpenMenu(open ? null : COMPUTER_MENU)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          onSetOpenMenu(COMPUTER_MENU);
        }}
      >
        <Screen size={16} aria-hidden="true" />
        {narrowed && <span className="computer-switch-name">{selected.label}</span>}
      </button>
      {open && <MenuList entries={entries} onClose={() => onSetOpenMenu(null)} className="computer-switch-menu" />}
    </div>
  );
}

export type SidebarHeaderProps = {
  mode: SidebarMode;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The paired computers, whose switch the header shows only once there is one. */
  computerLinks: ComputerLink[];
  computerName: string;
  computerFilter: ComputerFilter;
  openMenu: string | null;
  onSetComputerFilter: (filter: ComputerFilter) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSetMode: (mode: SidebarMode) => void;
  onGoBack: () => void;
  onGoForward: () => void;
};

export function SidebarHeader({ mode, canGoBack, canGoForward, computerLinks, computerName, computerFilter, openMenu, onSetComputerFilter, onSetOpenMenu, onSetMode, onGoBack, onGoForward }: SidebarHeaderProps) {
  return (
    <div className="traffic-space">
      <div className="sidebar-modes">
        {/** One switch, not a pair: pressed ranks the threads, released puts them back under their folders. */}
        <button
          className={`thread-nav-button ${mode === "activity" ? "active" : ""}`}
          type="button"
          aria-label="Rank threads by activity"
          aria-pressed={mode === "activity"}
          data-tip={mode === "activity" ? "Group by project" : "Rank by activity"}
          onClick={() => onSetMode(mode === "activity" ? "projects" : "activity")}
        >
          <RankIcon size={16} aria-hidden="true" />
        </button>
        {computerLinks.length > 0 && <ComputerSwitch links={computerLinks} name={computerName} filter={computerFilter} onSetFilter={onSetComputerFilter} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />}
      </div>
      <div className="thread-nav">
        <button className="thread-nav-button" type="button" aria-label="Go back" data-tip={BACK_TIP} disabled={!canGoBack} onClick={onGoBack}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button className="thread-nav-button" type="button" aria-label="Go forward" data-tip={FORWARD_TIP} disabled={!canGoForward} onClick={onGoForward}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const MIN_SIDEBAR_WIDTH = 220;

/** Sets the sidebar's width from where its right edge should be, and returns the width it took. */
function resizeSidebar(target: HTMLElement, clientX: number) {
  const sidebar = target.parentElement;
  if (!sidebar) return null;
  const width = Math.round(Math.min(innerWidth / 2, Math.max(MIN_SIDEBAR_WIDTH, clientX - sidebar.getBoundingClientRect().left)));
  /** The width is a custom property because the hidden state slides the sidebar out by that same width. */
  sidebar.style.setProperty("--sidebar-width", `${width}px`);
  return width;
}

function sidebarWidth(target: HTMLElement) {
  const width = target.parentElement?.getBoundingClientRect().width;
  return width ? Math.round(width) : null;
}

function resetSidebar(target: HTMLElement) {
  target.parentElement?.style.removeProperty("--sidebar-width");
  return sidebarWidth(target);
}

/**
 * The edge the sidebar is dragged wider by, which the arrow keys nudge ten pixels at a time, Home
 * and End take to its narrowest and widest, and a double-click or Enter puts back.
 */
export function SidebarResizer() {
  const edge = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (edge.current) setWidth(sidebarWidth(edge.current));
  }, []);
  const resizeTo = (target: HTMLElement, clientX: number) => {
    const next = resizeSidebar(target, clientX);
    if (next !== null) setWidth(next);
  };
  return (
    <div
      ref={edge}
      className="sidebar-resizer"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={Math.round(innerWidth / 2)}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      data-tip="Drag to resize · Double-click to reset"
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onDoubleClick={(event) => setWidth(resetSidebar(event.currentTarget))}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeTo(event.currentTarget, event.clientX);
      }}
      onKeyDown={(event) => {
        const target = event.currentTarget;
        const sidebar = target.parentElement;
        if (!sidebar) return;
        const left = sidebar.getBoundingClientRect().left;
        const right = sidebar.getBoundingClientRect().right;
        if (event.key === "Enter") setWidth(resetSidebar(target));
        else if (event.key === "Home") resizeTo(target, left);
        else if (event.key === "End") resizeTo(target, left + innerWidth);
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") resizeTo(target, right + (event.key === "ArrowLeft" ? -10 : 10));
        else return;
        event.preventDefault();
      }}
    />
  );
}
