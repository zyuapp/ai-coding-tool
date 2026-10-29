import { useCallback, useRef, useState } from "react";
import { LuChevronDown as ChevronDown, LuX as X } from "react-icons/lu";
import { rankedMatches } from "../../domain/match-rank";
import { projectName, type Project } from "../../domain/project";
import type { SidebarMode } from "../../domain/sidebar";
import type { ThreadHost } from "../../application/computers";
import { awayStatus, type ComputerFilter, type ComputerLink } from "../../domain/computers";
import { useDismissibleLayer } from "../focus";
import { AnchoredMenuList, type MenuEntry } from "./PopoverMenu";

const SCOPE_MENU = "sidebar:scope";

const VIEWS = [
  { value: "activity", label: "Activity" },
  { value: "projects", label: "Projects" },
] as const satisfies ReadonlyArray<{ value: SidebarMode; label: string }>;

export type SidebarScopeProps = {
  mode: SidebarMode;
  onSetMode: (mode: SidebarMode) => void;
  projects: Project[];
  projectHosts: Map<string, ThreadHost>;
  /** The one project the activity lists are narrowed to, or null for every project. */
  project: string | null;
  onSetProject: (projectId: string | null) => void;
  /** The paired computers, which the menu lists only once there is one. */
  computerLinks: ComputerLink[];
  /** What this computer calls itself. */
  computerName: string;
  computerFilter: ComputerFilter;
  onSetComputerFilter: (filter: ComputerFilter) => void;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

type ComputerChoice = { filter: ComputerFilter; label: string; away?: string };

/** A computer that is not connected says whether it is being dialled again or waiting to be. */
function computerChoices(links: ComputerLink[], name: string): ComputerChoice[] {
  return [
    { filter: "all", label: "All computers" },
    { filter: "this", label: name || "This computer" },
    ...links.map((link) => ({ filter: link.id, label: link.name, ...(link.status !== "connected" ? { away: awayStatus(link.status) } : {}) })),
  ];
}

/**
 * What the lists show, named as their heading: the view, then the project or computer they are
 * narrowed to. Its menu picks all three; a typed query narrows it to matching projects, by project
 * or computer name.
 */
export function SidebarScope({ mode, onSetMode, projects, projectHosts, project, onSetProject, computerLinks, computerName, computerFilter, onSetComputerFilter, openMenu, onSetOpenMenu }: SidebarScopeProps) {
  const open = openMenu === SCOPE_MENU;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  /** The trigger as state, so a menu already open on the first render still finds its anchor. */
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const anchorRef = useCallback((element: HTMLButtonElement | null) => {
    trigger.current = element;
    setAnchor(element);
  }, []);
  const [query, setQuery] = useState("");
  const close = () => {
    onSetOpenMenu(null);
    setQuery("");
  };
  useDismissibleLayer(open, [root, menu], close, trigger);

  const computers = computerLinks.length ? computerChoices(computerLinks, computerName) : [];
  const computer = computers.find((choice) => choice.filter === computerFilter);
  const narrowedComputer = computer && computer.filter !== "all" ? computer : undefined;
  /** One project has nothing to narrow to, unless the lists are narrowed to it already. */
  const projectChoices = mode === "activity" && (projects.length > 1 || project !== null);
  const selected = mode === "activity" ? projects.find((item) => item.id === project) : undefined;
  const host = selected && projectHosts.get(selected.id)?.name;
  const scope = selected ? projectName(selected) : narrowedComputer?.label ?? (projectChoices ? "All projects" : null);
  /** Computers out of reach while the lists draw from more than the one picked, which the trigger flags. */
  const away = narrowedComputer ? [] : computers.filter((choice) => choice.away);
  const view = VIEWS.find((item) => item.value === mode)!;
  const tip = narrowedComputer?.away ? `${narrowedComputer.label} ${narrowedComputer.away}` : away.map((choice) => `${choice.label} ${choice.away}`).join(" · ") || undefined;

  const typed = query.trim();
  const projectEntries: MenuEntry[] = projectChoices
    ? rankedMatches(projects, query, (item) => [projectName(item), projectHosts.get(item.id)?.name]).map((item) => ({
      label: projectName(item),
      detail: projectHosts.get(item.id)?.name,
      checked: item.id === selected?.id,
      onSelect: () => onSetProject(item.id),
    }))
    : [];
  const entries: MenuEntry[] = typed ? projectEntries : [
    ...VIEWS.map(({ value, label }) => ({ label, checked: mode === value, onSelect: () => { if (mode !== value) onSetMode(value); } })),
    ...(computers.length ? ["separator" as const, ...computers.map((choice) => ({
      label: choice.label,
      checked: computerFilter === choice.filter,
      className: choice.away ? "offline" : undefined,
      detail: choice.away && `${choice.away[0]!.toUpperCase()}${choice.away.slice(1)}`,
      onSelect: () => onSetComputerFilter(choice.filter),
    }))] : []),
    ...(projectChoices ? ["separator" as const, { label: "All projects", checked: !selected, onSelect: () => onSetProject(null) }, ...projectEntries] : []),
  ];

  return (
    <div ref={root} className="sidebar-scope" data-popover-menu onBlur={(event) => {
      if (open && !event.currentTarget.contains(event.relatedTarget) && !menu.current?.contains(event.relatedTarget)) close();
    }}>
      <button
        ref={anchorRef}
        type="button"
        className={`sidebar-scope-trigger${selected || narrowedComputer ? " narrowed" : ""}${narrowedComputer?.away ? " offline" : ""}${away.length ? " some-away" : ""}`}
        aria-label={[`Sidebar: ${view.label}`, scope, host, away.length ? `${away.length} offline` : null].filter(Boolean).join(", ")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={tip}
        onClick={() => open ? close() : onSetOpenMenu(SCOPE_MENU)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          onSetOpenMenu(SCOPE_MENU);
        }}
      >
        <span className="sidebar-scope-view">{view.label}</span>
        {scope && <span className="sidebar-scope-name">{scope}</span>}
        {host && <span className="sidebar-scope-host">{host}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {(selected || narrowedComputer) && (
        <button className="sidebar-scope-clear" type="button" aria-label={selected ? "Show all projects" : "Show all computers"} data-tip={selected ? "All projects" : "All computers"} onClick={() => {
          if (selected) onSetProject(null);
          else onSetComputerFilter("all");
          trigger.current?.focus();
        }}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
      {open && anchor && <AnchoredMenuList
        entries={entries}
        onClose={close}
        className="sidebar-scope-menu"
        anchor={anchor}
        menuRef={menu}
        align="start"
        search={projectChoices ? { value: query, label: "Search projects", onChange: setQuery } : undefined}
      />}
    </div>
  );
}
