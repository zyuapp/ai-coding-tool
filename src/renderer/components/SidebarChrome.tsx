import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LuArrowDownWideNarrow as RankIcon, LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight, LuFolder as Folder, LuMonitor as Monitor, LuMonitorOff as MonitorOff } from "react-icons/lu";
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
  /** Computers out of reach while the lists draw from more than the one picked, which the trigger flags. */
  const away = narrowed ? [] : choices.filter((choice) => choice.away);
  const awayTip = away.map((choice) => `${choice.label} ${choice.away}`).join(" · ");
  const tip = !narrowed ? ["Computers", awayTip].filter(Boolean).join(" · ") : selected.filter === "this" ? `Only ${name || "this computer"}` : `Only ${selected.label}${selected.away ? ` (${selected.away})` : ""}`;
  const entries: MenuItem[] = choices.map((choice) => ({
    label: choice.label,
    checked: filter === choice.filter,
    className: choice.away ? "offline" : undefined,
    detail: choice.away && `${choice.away[0]!.toUpperCase()}${choice.away.slice(1)}`,
    onSelect: () => onSetFilter(choice.filter),
  }));
  return (
    <div ref={root} className="computer-switch" data-popover-menu onBlur={(event) => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
    }}>
      <button
        ref={trigger}
        type="button"
        className={`thread-nav-button computer-switch-trigger${narrowed ? " active" : ""}${selected.away ? " offline" : ""}${away.length ? " some-away" : ""}`}
        aria-label={away.length ? `Computers, ${away.length} offline` : "Computers"}
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

const SIDEBAR_MODES = [
  { value: "projects", label: "Group by project", tip: "Group by project", Icon: Folder },
  { value: "activity", label: "Rank threads by activity", tip: "Rank by activity", Icon: RankIcon },
] as const satisfies ReadonlyArray<{ value: SidebarMode; label: string; tip: string; Icon: unknown }>;

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
        {/** Both ways of drawing the lists side by side, the one in effect filled. */}
        <div className="sidebar-mode-switch" role="group" aria-label="Sidebar view">
          {SIDEBAR_MODES.map(({ value, label, tip, Icon }) => (
            <button
              key={value}
              className={`sidebar-mode${mode === value ? " active" : ""}`}
              type="button"
              aria-label={label}
              aria-pressed={mode === value}
              data-tip={tip}
              onClick={() => { if (mode !== value) onSetMode(value); }}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
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
/** How far one arrow press moves the edge, and one with Shift held. */
const KEY_STEP = 10;
const SHIFT_KEY_STEP = 50;

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
 * The edge the sidebar is dragged wider by, which the arrow keys nudge ten pixels at a time, fifty
 * with Shift, Home and End take to its narrowest and widest, and a double-click or Enter puts back.
 */
export function SidebarResizer() {
  const edge = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [widest, setWidest] = useState(() => Math.round(innerWidth / 2));
  useLayoutEffect(() => {
    if (edge.current) setWidth(sidebarWidth(edge.current));
  }, []);
  /** The window narrowing caps the sidebar at half of it, so what the edge reports follows. */
  useEffect(() => {
    const measure = () => {
      setWidest(Math.round(innerWidth / 2));
      if (edge.current) setWidth(sidebarWidth(edge.current));
    };
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
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
      aria-valuemax={widest}
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
        const { left, right } = sidebar.getBoundingClientRect();
        const step = event.shiftKey ? SHIFT_KEY_STEP : KEY_STEP;
        if (event.key === "Enter") setWidth(resetSidebar(target));
        else if (event.key === "Home") resizeTo(target, left);
        else if (event.key === "End") resizeTo(target, left + innerWidth);
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") resizeTo(target, right + (event.key === "ArrowLeft" ? -step : step));
        else return;
        event.preventDefault();
      }}
    />
  );
}
