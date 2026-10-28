import { useRef, useState } from "react";
import { Draggable, Droppable, type DraggableProvided } from "@hello-pangea/dnd";
import { LuChevronRight as ChevronRight, LuPlus as Plus, LuSquarePen as SquarePen } from "react-icons/lu";
import { folderName, projectName, type Project } from "../../domain/project";
import type { Thread } from "../../domain/thread";
import type { SidebarSection, SidebarSections } from "../../domain/sidebar";
import { worktreeName } from "../../domain/worktree";
import type { WorktreeGroup } from "../../application/workspace-state";
import { PopoverMenu, type MenuEntry, type MenuItem } from "./PopoverMenu";
import { RenameInput, useRenaming, type Renaming } from "./SidebarRename";
import { ShowMore } from "./ShowMore";
import type { ThreadRowRenderer } from "./SidebarThreadRow";
import type { ThreadHost } from "../../application/computers";
import { HostMark } from "./HostMark";

export const RECENTS_DROPPABLE = "recents";
export const PROJECTS_DROPPABLE = "projects";
export const PROJECT_DRAG = "project";
const PROJECT_THREAD_LIMIT = 10;

/** A folder drawn open while its threads show beneath it, which turns into a fold chevron under the pointer or the keyboard. */
function FolderIcon({ open }: { open: boolean }) {
  return (
    <span className="folder-icon">
      <svg className="folder-glyph" viewBox="0 0 24 24" aria-hidden="true">
        {open
        ? <path d="M3 17.6V7.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18h3.3l2 2h4.3c.95 0 1.42 0 1.78.18.32.16.58.42.74.74.18.36.18.83.18 1.78v.3M3 17.6l2.05-6.15c.27-.8.4-1.2.65-1.5.22-.26.5-.46.82-.58.36-.14.78-.14 1.62-.14h11.1c.92 0 1.38 0 1.65.2.24.17.39.44.42.73.03.33-.18.74-.6 1.56l-2.6 5.2c-.33.66-.5 1-.75 1.23-.23.21-.5.37-.8.46-.33.1-.7.1-1.44.1H4.4c-.77 0-1.4-.63-1.4-1.4Z" />
        : <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />}
      </svg>
      <ChevronRight className="folder-fold" size={16} aria-hidden="true" />
    </span>
  );
}

/**
 * Which folders are showing every thread they hold. The sidebar owns this so a folder opened wide
 * stays wide while activity mode is drawn over it.
 */
export function useShownThreads() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  return {
    has: (projectId: string) => expanded.has(projectId),
    toggle: (projectId: string) => setExpanded((shown) => {
      const next = new Set(shown);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    }),
  };
}

export type ShownThreads = ReturnType<typeof useShownThreads>;

/** A folder shows its first ten threads, and enough more to keep the open one in view. */
function visibleCount(projectThreads: Thread[], currentId: string | null, showAll: boolean) {
  if (showAll) return projectThreads.length;
  const current = projectThreads.findIndex((thread) => thread.id === currentId);
  return Math.max(PROJECT_THREAD_LIMIT, current + 1);
}

/** An empty list's way to fill it. */
function StartThread({ recents, onSelect }: { recents?: boolean; onSelect: () => void }) {
  return (
    <button className={`empty-tasks${recents ? " recents-empty" : ""}`} type="button" onClick={onSelect}>
      <SquarePen size={14} aria-hidden="true" />
      Start a thread
    </button>
  );
}

/**
 * Removing a folder archives every thread in it, so one holding threads asks first, with the safe
 * choice where the keyboard lands.
 */
function removeEntry(threadCount: number, onRemove: () => void): MenuItem {
  if (threadCount === 0) return { label: "Remove", danger: true, onSelect: onRemove };
  const threads = threadCount === 1 ? "1 thread" : `${threadCount} threads`;
  return {
    label: "Remove",
    danger: true,
    items: [
      { label: "Keep project" },
      { label: `Remove and archive ${threads}`, danger: true, onSelect: onRemove },
    ],
  };
}

type ProjectRowProps = {
  project: Project;
  /** The paired computer the folder is on, for one that is not this computer's own. */
  host: ThreadHost | undefined;
  index: number;
  /** How many folders the same computer lists, which the menu's Move down stops at. */
  count: number;
  threads: Thread[];
  /** A checkout is somewhere a thread can be started, not a list the sidebar draws. */
  checkouts: WorktreeGroup[];
  expanded: boolean;
  showAll: boolean;
  current: boolean;
  currentId: string | null;
  openMenu: string | null;
  renaming: Renaming;
  renderRow: ThreadRowRenderer;
  onToggleShowAll: () => void;
  onSetOpenMenu: (menu: string | null) => void;
  onNewThread: (projectId?: string, worktreeId?: string) => void;
  onToggleProject: (projectId: string) => void;
  onEditProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
};

function ProjectRow({
  project,
  host,
  index,
  count,
  threads,
  checkouts,
  expanded,
  showAll,
  current,
  currentId,
  openMenu,
  renaming,
  renderRow,
  onToggleShowAll,
  onSetOpenMenu,
  onNewThread,
  onToggleProject,
  onEditProject,
  onRemoveProject,
}: ProjectRowProps) {
  const shown = visibleCount(threads, currentId, showAll);
  const hidden = threads.length - shown;
  const header = useRef<HTMLDivElement>(null);
  const name = projectName(project);
  const menuId = `project:${project.id}`;
  const items: MenuEntry[] = [
    { label: "New thread", onSelect: () => onNewThread(project.id) },
    ...checkouts.map(({ worktree }) => ({
      label: `New thread in ${worktreeName(worktree)}`,
      onSelect: () => onNewThread(project.id, worktree.id),
    })),
    "separator",
    { label: "Rename", shortcut: "F2", onSelect: () => renaming.start(project.id, header.current) },
    { label: "Edit…", onSelect: () => onEditProject(project.id) },
    /** The menu's way to do what dragging the row does, within the folders of the same computer. */
    ...(index > 0 ? [{ label: "Move up", command: { type: "project.move", projectId: project.id, index: index - 1 } } as const] : []),
    ...(index < count - 1 ? [{ label: "Move down", command: { type: "project.move", projectId: project.id, index: index + 1 } } as const] : []),
    "separator",
    removeEntry(threads.length, () => onRemoveProject(project.id)),
  ];
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  return (
    <Draggable draggableId={project.id} index={index} disableInteractiveElementBlocking isDragDisabled={keyboardFocus}>
      {(dragged: DraggableProvided, snapshot) => (
        <section
          className={`project-group ${snapshot.isDragging ? "is-dragging" : ""}`}
          ref={dragged.innerRef}
          {...dragged.draggableProps}
        >
          {/** The folder's own row takes a thread dropped on it, folded or not; a folded one opens no gap for it. */}
          <Droppable droppableId={project.id} type="task">
            {(provided, drop) => (
              <div className={`project-drop${drop.isDraggingOver ? " drop-over" : ""}`} ref={provided.innerRef} {...provided.droppableProps}>
                {/** The header row is the pointer's handle, buttons and all: the library refuses to lift
                  *  from a button unless told otherwise, and the row is nothing but buttons. It swallows
                  *  the click a drag ends on, so the row keeps its click-to-fold. The keyboard moves a
                  *  folder from its menu instead, so Space on a focused button presses it. */}
                <div
                  ref={header}
                  className={`project-row ${current ? "current" : ""}`}
                  {...dragged.dragHandleProps}
                  tabIndex={-1}
                  role={undefined}
                  aria-describedby={undefined}
                  onFocus={(event) => setKeyboardFocus(event.target.matches(":focus-visible"))}
                  onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardFocus(false); }}
                  onPointerDown={() => setKeyboardFocus(false)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (renaming.editing !== project.id) onSetOpenMenu(menuId);
                  }}
                >
                  {renaming.editing === project.id
                    ? <RenameInput
                        inputRef={renaming.input}
                        className="project-rename"
                        label={`Rename ${name}`}
                        value={name}
                        placeholder={folderName(project.root)}
                        onCommit={(value) => renaming.commit(project.id, value)}
                        onCancel={renaming.cancel}
                      />
                    : <button
                        className="project-main"
                        onClick={(event) => { if (event.detail < 2) onToggleProject(project.id); }}
                        onDoubleClick={(event) => {
                          /** The double-click's first click folded the folder; renaming puts it back. */
                          onToggleProject(project.id);
                          renaming.start(project.id, event.currentTarget.closest(".project-row"));
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "F2") return;
                          event.preventDefault();
                          renaming.start(project.id, event.currentTarget.closest(".project-row"));
                        }}
                        data-tip={host ? `${project.root} on ${host.name}${host.offline ? ` (${host.reconnecting ? "reconnecting" : "offline"})` : ""}` : project.root}
                        aria-expanded={expanded}
                      >
                        <FolderIcon open={expanded} />
                        <span>{name}</span>
                        {!expanded && renderRow.folderStatus(threads)}
                      </button>}
                  <PopoverMenu
                    id={menuId}
                    openMenu={openMenu}
                    onSetOpenMenu={onSetOpenMenu}
                    label={`More options for ${name}`}
                    className="project-menu"
                    items={items}
                  />
                  <button className="project-new" type="button" onClick={() => onNewThread(project.id)} aria-label={`New thread in ${name}`} data-tip="New thread"><SquarePen size={16} aria-hidden="true" /></button>
                </div>
                {expanded
                  ? <div className="project-tasks">
                      {threads.slice(0, shown).map((thread, threadIndex) => renderRow(thread, threadIndex, "project"))}
                      {provided.placeholder}
                    </div>
                  : <div hidden>{provided.placeholder}</div>}
              </div>
            )}
          </Droppable>
          {expanded && threads.length === 0 && <StartThread onSelect={() => onNewThread(project.id)} />}
          {expanded && (hidden > 0 || showAll) && (
            <ShowMore
              label={hidden > 0 ? `Show ${hidden} more` : "Show less"}
              expanded={showAll}
              onSelect={onToggleShowAll}
            />
          )}
        </section>
      )}
    </Draggable>
  );
}

/**
 * The folders each computer holds, in the order the list gives them: this computer's first, then
 * each paired computer's together. Each computer has its own drag list and project indices.
 */
function computerGroups(projects: Project[], projectHosts: Map<string, ThreadHost>) {
  const groups: Array<{ host: ThreadHost | undefined; projects: Project[] }> = [];
  projects.forEach((project) => {
    const host = projectHosts.get(project.id);
    const last = groups.at(-1);
    if (last && last.host?.id === host?.id) last.projects.push(project);
    else groups.push({ host, projects: [project] });
  });
  return groups;
}

export type SidebarProjectsProps = {
  projects: Project[];
  /** What this computer calls itself, which heads its own folders once a paired computer's are listed too. */
  computerName: string;
  /** The threads each project holds, in the order the folder lists them. */
  threadsByProject: Map<string, Thread[]>;
  checkoutsByProject: Map<string, WorktreeGroup[]>;
  recentThreads: Thread[];
  currentId: string | null;
  draftProjectId: string | null;
  expandedProjects: Set<string>;
  projectHosts: Map<string, ThreadHost>;
  sections: SidebarSections;
  shownThreads: ShownThreads;
  openMenu: string | null;
  renderRow: ThreadRowRenderer;
  onSetSectionOpen: (section: SidebarSection, open: boolean) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onNewThread: (projectId?: string, worktreeId?: string) => void;
  onOpenFolder: () => void;
  onToggleProject: (projectId: string) => void;
  /** The name typed on the row itself. Blank gives the folder its own name back. */
  onRenameProject: (projectId: string, name: string) => void;
  onEditProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
};

/** A computer's name over its folders. The header's computer switch is what narrows the lists to one. */
function ComputerHeading({ host, name }: { host: ThreadHost | undefined; name: string }) {
  return (
    <div className="computer-heading" aria-hidden="true">
      <HostMark name={name} offline={host?.offline} reconnecting={host?.reconnecting} />
      {host?.offline && <span className="computer-heading-status">{host.reconnecting ? "Reconnecting" : "Offline"}</span>}
    </div>
  );
}

export function SidebarProjects({
  projects,
  computerName,
  threadsByProject,
  checkoutsByProject,
  recentThreads,
  currentId,
  draftProjectId,
  expandedProjects,
  projectHosts,
  sections,
  shownThreads,
  openMenu,
  renderRow,
  onSetSectionOpen,
  onSetOpenMenu,
  onNewThread,
  onOpenFolder,
  onToggleProject,
  onRenameProject,
  onEditProject,
  onRemoveProject,
}: SidebarProjectsProps) {
  const projectNames = useRenaming(onRenameProject);
  /** Headings only once a paired computer's folders sit beside this computer's own. */
  const showComputers = projects.some((project) => projectHosts.has(project.id));
  const localName = computerName || "This computer";

  return (
    <>
      <div className={`section-heading projects-heading${projects.length === 0 ? " empty" : ""}`}>
        <button className="section-toggle" type="button" onClick={() => onSetSectionOpen("projects", !sections.projects)} aria-expanded={sections.projects}>
          <span>Projects</span>
          {!sections.projects && projects.length > 0 && <span className="section-count">{projects.length}</span>}
          <span className="section-chevron" aria-hidden="true" />
        </button>
        <button className="section-action add-project" type="button" onClick={onOpenFolder} aria-label="Add project" data-tip="Add project"><Plus size={16} aria-hidden="true" /></button>
      </div>
      {sections.projects && <nav className="project-list" aria-label="Projects">
        {computerGroups(projects, projectHosts).map(({ host, projects: held }) => (
          <Droppable key={host?.id ?? "local"} droppableId={`${PROJECTS_DROPPABLE}:${host?.id ?? "this"}`} type={`${PROJECT_DRAG}:${host?.id ?? "this"}`}>
            {(list) => <div className="computer-group" role={showComputers ? "group" : undefined} aria-label={showComputers ? host?.name ?? localName : undefined} ref={list.innerRef} {...list.droppableProps}>
              {showComputers && <ComputerHeading host={host} name={host?.name ?? localName} />}
              {held.map((project, offset) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  host={host}
                  index={offset}
                  count={held.length}
                  threads={threadsByProject.get(project.id) ?? []}
                  checkouts={checkoutsByProject.get(project.id) ?? []}
                  expanded={expandedProjects.has(project.id)}
                  showAll={shownThreads.has(project.id)}
                  current={draftProjectId === project.id}
                  currentId={currentId}
                  openMenu={openMenu}
                  renaming={projectNames}
                  renderRow={renderRow}
                  onToggleShowAll={() => shownThreads.toggle(project.id)}
                  onSetOpenMenu={onSetOpenMenu}
                  onNewThread={onNewThread}
                  onToggleProject={onToggleProject}
                  onEditProject={onEditProject}
                  onRemoveProject={onRemoveProject}
                />
              ))}
              {list.placeholder}
            </div>}
          </Droppable>
        ))}
      </nav>}

      <div className="section-heading recents-heading">
        <button className="section-toggle" type="button" onClick={() => onSetSectionOpen("recents", !sections.recents)} aria-expanded={sections.recents}>
          <span>Recents</span>
          {!sections.recents && recentThreads.length > 0 && <span className="section-count">{recentThreads.length}</span>}
          <span className="section-chevron" aria-hidden="true" />
        </button>
      </div>
      {sections.recents && <Droppable droppableId={RECENTS_DROPPABLE} type="task">
        {(provided, snapshot) => (
          <nav className="task-list recents-list" aria-label="Project-less tasks" ref={provided.innerRef} {...provided.droppableProps}>
            {recentThreads.length === 0 && !snapshot.isDraggingOver && <StartThread recents onSelect={() => onNewThread()} />}
            {recentThreads.map((thread, index) => renderRow(thread, index, "recent"))}
            {provided.placeholder}
          </nav>
        )}
      </Droppable>}
    </>
  );
}
