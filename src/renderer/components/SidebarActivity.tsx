import { useRef, useState } from "react";
import { LuCheckCheck as CheckCheck, LuChevronDown as ChevronDown, LuFolder as Folder } from "react-icons/lu";
import { dismissableThreads } from "../../domain/attention";
import { rankedMatches } from "../../domain/match-rank";
import { projectName, type Project } from "../../domain/project";
import type { SidebarSection, SidebarSections } from "../../domain/sidebar";
import type { ThreadHost } from "../../application/computers";
import type { ActivitySections } from "../../application/thread-order";
import { useDismissibleLayer } from "../focus";
import { MenuList, type MenuEntry } from "./PopoverMenu";
import type { ActivityRowRenderer } from "./SidebarThreadRow";

const PROJECT_MENU = "activity:project";

export type ProjectFilterProps = {
  projects: Project[];
  projectHosts: Map<string, ThreadHost>;
  project: string | null;
  onSetProject: (projectId: string | null) => void;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
};

/** The choices, narrowed by what is typed above them. A query matches a project's name or the computer that holds it. */
function ProjectMenu({ projects, projectHosts, selected, onSetProject, onClose }: Pick<ProjectFilterProps, "projects" | "projectHosts" | "onSetProject"> & { selected: Project | undefined; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const matches = rankedMatches(projects, query, (item) => [projectName(item), projectHosts.get(item.id)?.name]);
  const entries: MenuEntry[] = [
    ...(query.trim() ? [] : [{ label: "All projects", checked: !selected, onSelect: () => onSetProject(null) }, "separator" as const]),
    ...matches.map((item) => ({
      label: projectName(item),
      detail: projectHosts.get(item.id)?.name,
      checked: item.id === selected?.id,
      onSelect: () => onSetProject(item.id),
    })),
  ];
  return <MenuList entries={entries} onClose={onClose} className="activity-filter-menu" search={{ value: query, label: "Search projects", onChange: setQuery }} />;
}

/**
 * Which project's threads the lists below rank: every one, or one. A project on a paired computer
 * names the computer that holds it, the way its rows do.
 */
function ProjectFilter({ projects, projectHosts, project, onSetProject, openMenu, onSetOpenMenu }: ProjectFilterProps) {
  const open = openMenu === PROJECT_MENU;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissibleLayer(open, [root], () => onSetOpenMenu(null), trigger);
  const selected = projects.find((item) => item.id === project);
  return (
    <div ref={root} className="activity-filter" data-popover-menu onBlur={(event) => {
      if (open && !event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
    }}>
      <button
        ref={trigger}
        type="button"
        className={`activity-filter-trigger${selected ? " narrowed" : ""}`}
        aria-label={`Project: ${selected ? projectName(selected) : "All projects"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onSetOpenMenu(open ? null : PROJECT_MENU)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          onSetOpenMenu(PROJECT_MENU);
        }}
      >
        <Folder size={14} aria-hidden="true" />
        <span>{selected ? projectName(selected) : "All projects"}</span>
        {selected && projectHosts.get(selected.id) && <span className="activity-filter-host">{projectHosts.get(selected.id)!.name}</span>}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && <ProjectMenu projects={projects} projectHosts={projectHosts} selected={selected} onSetProject={onSetProject} onClose={() => onSetOpenMenu(null)} />}
    </div>
  );
}

/** The activity mode's lists, top to bottom, with the heading each is drawn under. */
const ACTIVITY_SECTIONS = [
  { key: "priority", label: "Priority" },
  { key: "running", label: "Running" },
  { key: "threads", label: "Threads" },
  { key: "snoozed", label: "Snoozed" },
] as const satisfies ReadonlyArray<{ key: keyof ActivitySections & SidebarSection; label: string }>;

export type SidebarActivityProps = {
  /** The threads ranked by what wants the user, which is what activity mode draws. */
  activityThreads: ActivitySections;
  sections: SidebarSections;
  blockedThreadIds: Set<string>;
  onSetSectionOpen: (section: SidebarSection, open: boolean) => void;
  onDismissAll: () => void;
  renderRow: ActivityRowRenderer;
  /** The projects the lists can be narrowed to, and the one they are. */
  projectFilter: ProjectFilterProps;
};

export function SidebarActivity({ activityThreads, sections, blockedThreadIds, onSetSectionOpen, onDismissAll, renderRow, projectFilter }: SidebarActivityProps) {
  return (
    <>
      {/** One project has nothing to narrow to, unless the lists are narrowed to it already. */}
      {(projectFilter.projects.length > 1 || projectFilter.project !== null) && <ProjectFilter {...projectFilter} />}
      {ACTIVITY_SECTIONS.map(({ key, label }) => {
        const threads = activityThreads[key];
        /** Snoozed only shows while something is in it, so a user who never snoozes never meets it. */
        if (key === "snoozed" && threads.length === 0) return null;
        const dottedCount = key === "priority" ? dismissableThreads(threads).length : 0;
        return (
          <section className="activity-group" key={key}>
            <div className="section-heading activity-heading">
              <button className="section-toggle" onClick={() => onSetSectionOpen(key, !sections[key])} aria-expanded={sections[key]}>
                <span>{label}</span>
                <span className="section-chevron" aria-hidden="true" />
              </button>
              {/** A folded list still says how much it holds, in the slot its action takes when hovered. */}
              {!sections[key] && threads.length > 0 && <span className="section-count">{threads.length}</span>}
              {key === "priority" && dottedCount > 0 && (
                <button className="section-action" onClick={onDismissAll} aria-label="Dismiss all">
                  <CheckCheck size={16} aria-hidden="true" />
                </button>
              )}
            </div>
            {sections[key] && threads.length === 0 && key === "priority" && <p className="sidebar-empty">Nothing waiting</p>}
            {/** Only Priority speaks: a spinner appearing in Running is not news anyone needs read out. */}
            {sections[key] && <nav className="task-list" aria-label={label} aria-live={key === "priority" ? "polite" : undefined}>
              {threads.map((thread) => renderRow(thread, key === "priority" && !blockedThreadIds.has(thread.id) ? "dismiss" : "none", key === "priority"))}
            </nav>}
          </section>
        );
      })}
    </>
  );
}
