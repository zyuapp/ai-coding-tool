import { useRef } from "react";
import { LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight, LuInbox as Inbox, LuMonitor as Monitor, LuMonitorOff as MonitorOff } from "react-icons/lu";
import type { ComputerFilter, ComputerLink } from "../../domain/computers";
import type { SidebarMode } from "../../domain/sidebar";
import { useDismissibleLayer } from "../focus";
import { MenuList, type MenuItem } from "./PopoverMenu";

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
  const choices: Array<{ filter: ComputerFilter; label: string; offline?: boolean }> = [
    { filter: "all", label: "All" },
    { filter: "this", label: name || "This computer" },
    ...links.map((link) => ({ filter: link.id, label: link.name, offline: link.status !== "connected" })),
  ];
  const selected = choices.find((choice) => choice.filter === filter) ?? choices[0]!;
  const narrowed = selected.filter !== "all";
  const Screen = selected.offline ? MonitorOff : Monitor;
  const tip = !narrowed ? "Computers" : selected.filter === "this" ? `Only ${name || "this computer"}` : `Only ${selected.label}${selected.offline ? " (offline)" : ""}`;
  const entries: MenuItem[] = choices.map((choice) => ({
    label: choice.label,
    checked: filter === choice.filter,
    className: choice.offline ? "offline" : undefined,
    title: choice.offline ? `${choice.label} is offline` : undefined,
    onSelect: () => onSetFilter(choice.filter),
  }));
  return (
    <div ref={root} className="computer-switch" data-popover-menu onBlur={(event) => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
    }}>
      <button
        ref={trigger}
        type="button"
        className={`thread-nav-button computer-switch-trigger${narrowed ? " active" : ""}${selected.offline ? " offline" : ""}`}
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
        <Screen size={15} aria-hidden="true" />
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
          onClick={() => onSetMode(mode === "activity" ? "projects" : "activity")}
        >
          <Inbox size={15} aria-hidden="true" />
        </button>
        {computerLinks.length > 0 && <ComputerSwitch links={computerLinks} name={computerName} filter={computerFilter} onSetFilter={onSetComputerFilter} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />}
      </div>
      <div className="thread-nav">
        <button className="thread-nav-button" type="button" aria-label="Go back" disabled={!canGoBack} onClick={onGoBack}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <button className="thread-nav-button" type="button" aria-label="Go forward" disabled={!canGoForward} onClick={onGoForward}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function resizeSidebar(target: HTMLElement, clientX: number) {
  const sidebar = target.parentElement;
  /** The width is a custom property because the hidden state slides the sidebar out by that same width. */
  if (sidebar) sidebar.style.setProperty("--sidebar-width", `${Math.min(innerWidth / 2, Math.max(220, clientX - sidebar.getBoundingClientRect().left))}px`);
}

/** The edge the sidebar is dragged wider by, which the arrow keys nudge ten pixels at a time. */
export function SidebarResizer() {
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeSidebar(event.currentTarget, event.clientX);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const sidebar = event.currentTarget.parentElement;
        if (sidebar) resizeSidebar(event.currentTarget, sidebar.getBoundingClientRect().right + (event.key === "ArrowLeft" ? -10 : 10));
      }}
    />
  );
}
