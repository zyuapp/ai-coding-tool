import { useRef, type ReactNode } from "react";
import { LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight, LuFolder as Folder, LuInbox as Inbox, LuMonitor as Monitor, LuMonitorOff as MonitorOff } from "react-icons/lu";
import type { ThreadHost } from "../../application/computers";
import { awayStatus, type ComputerFilter, type ComputerLink } from "../../domain/computers";
import { projectName, type Project } from "../../domain/project";
import type { SidebarMode } from "../../domain/sidebar";
import { useDismissibleLayer } from "../focus";
import { MenuList, type MenuEntry, type MenuItem } from "./PopoverMenu";

type FilterSwitchProps = {
  menu: string;
  label: string;
  tip: string;
  icon: ReactNode;
  /** Pressed while the lists below are narrowed. */
  narrowed: boolean;
  offline?: boolean;
  entries: MenuEntry[];
  /** Names the switch, its button and its menu for styling: `name`, `name-trigger`, `name-menu`. */
  name: string;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

/** A header button the size of its neighbours that narrows the lists below to one of its choices. */
function FilterSwitch({ menu, label, tip, icon, narrowed, offline, entries, name, openMenu, onSetOpenMenu }: FilterSwitchProps) {
  const open = openMenu === menu;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(open, [root], () => onSetOpenMenu(null), trigger);
  return (
    <div ref={root} className={`filter-switch ${name}`} data-popover-menu onBlur={(event) => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
    }}>
      <button
        ref={trigger}
        type="button"
        className={`thread-nav-button filter-switch-trigger ${name}-trigger${narrowed ? " active" : ""}${offline ? " offline" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={tip}
        onClick={() => onSetOpenMenu(open ? null : menu)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          onSetOpenMenu(menu);
        }}
      >
        {icon}
      </button>
      {open && <MenuList entries={entries} onClose={() => onSetOpenMenu(null)} className={`filter-switch-menu ${name}-menu`} />}
    </div>
  );
}

type ComputerSwitchProps = {
  links: ComputerLink[];
  /** What this computer calls itself. */
  name: string;
  filter: ComputerFilter;
  onSetFilter: (filter: ComputerFilter) => void;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

/** Which computers' threads the lists below draw: every one, this one, or one paired computer. */
function ComputerSwitch({ links, name, filter, onSetFilter, openMenu, onSetOpenMenu }: ComputerSwitchProps) {
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
  return <FilterSwitch menu="sidebar:computers" label="Computers" tip={tip} icon={<Screen size={15} aria-hidden="true" />} narrowed={narrowed} offline={Boolean(selected.away)} entries={entries} name="computer-switch" openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />;
}

type ProjectSwitchProps = {
  projects: Project[];
  /** Which paired computer holds each project that is not this computer's own. */
  projectHosts: Map<string, ThreadHost>;
  project: string | null;
  onSetProject: (projectId: string | null) => void;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

/** Which project's threads the activity lists rank: every one, or one. A project on a paired computer names it. */
function ProjectSwitch({ projects, projectHosts, project, onSetProject, openMenu, onSetOpenMenu }: ProjectSwitchProps) {
  const selected = projects.find((item) => item.id === project);
  const entries: MenuEntry[] = [
    { label: "All projects", checked: !selected, onSelect: () => onSetProject(null) },
    "separator",
    ...projects.map((item): MenuItem => ({
      label: projectName(item),
      detail: projectHosts.get(item.id)?.name,
      checked: item.id === selected?.id,
      onSelect: () => onSetProject(item.id),
    })),
  ];
  const tip = selected ? `Only ${projectName(selected)}` : "Projects";
  return <FilterSwitch menu="sidebar:projects" label="Projects" tip={tip} icon={<Folder size={15} aria-hidden="true" />} narrowed={Boolean(selected)} entries={entries} name="project-switch" openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />;
}

export type SidebarHeaderProps = {
  mode: SidebarMode;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The paired computers, whose switch the header shows only once there is one. */
  computerLinks: ComputerLink[];
  computerName: string;
  computerFilter: ComputerFilter;
  /** The projects the activity lists can be narrowed to, and the one they are, which only activity mode offers. */
  projects: Project[];
  projectHosts: Map<string, ThreadHost>;
  activityProject: string | null;
  onSetActivityProject: (projectId: string | null) => void;
  openMenu: string | null;
  onSetComputerFilter: (filter: ComputerFilter) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSetMode: (mode: SidebarMode) => void;
  onGoBack: () => void;
  onGoForward: () => void;
};

export function SidebarHeader({ mode, canGoBack, canGoForward, computerLinks, computerName, computerFilter, projects, projectHosts, activityProject, onSetActivityProject, openMenu, onSetComputerFilter, onSetOpenMenu, onSetMode, onGoBack, onGoForward }: SidebarHeaderProps) {
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
        {mode === "activity" && projects.length > 0 && <ProjectSwitch projects={projects} projectHosts={projectHosts} project={activityProject} onSetProject={onSetActivityProject} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />}
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
