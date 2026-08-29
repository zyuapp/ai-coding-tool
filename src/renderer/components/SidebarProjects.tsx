import { useState } from "react";
import { Draggable, Droppable, type DraggableProvided } from "@hello-pangea/dnd";
import { LuSquarePen as SquarePen } from "react-icons/lu";
import { folderName, projectName, type Project } from "../../domain/project";
import { threadActivityAt, type Thread } from "../../domain/thread";
import type { SidebarSection, SidebarSections } from "../../domain/sidebar";
import { worktreeName } from "../../domain/worktree";
import type { WorktreeGroup } from "../../application/workspace-state";
import { PopoverMenu } from "./PopoverMenu";
import { RenameInput, useRenaming, type Renaming } from "./SidebarRename";
import { ShowMore } from "./ShowMore";
import type { ThreadRowRenderer } from "./SidebarThreadRow";

export const RECENTS_DROPPABLE = "recents";
export const PROJECTS_DROPPABLE = "projects";
export const PROJECT_DRAG = "project";
const PROJECT_THREAD_LIMIT = 10;

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
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

type ProjectRowProps = {
  project: Project;
  index: number;
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
  index,
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
  return (
    <Draggable draggableId={project.id} index={index} disableInteractiveElementBlocking>
      {(dragged: DraggableProvided, snapshot) => (
        <section
          className={`project-group ${snapshot.isDragging ? "is-dragging" : ""}`}
          ref={dragged.innerRef}
          {...dragged.draggableProps}
        >
          {/** The header row is the handle, buttons and all: the library refuses to lift from a
            *  button unless told otherwise, and the row is nothing but buttons. It swallows the
            *  click a drag ends on, so the row keeps its click-to-fold. */}
          <div className={`project-row ${current ? "current" : ""}`} {...dragged.dragHandleProps}>
            {renaming.editing === project.id
              ? <RenameInput
                  inputRef={renaming.input}
                  className="project-rename"
                  label={`Rename ${projectName(project)}`}
                  value={projectName(project)}
                  placeholder={folderName(project.root)}
                  onCommit={(value) => renaming.commit(project.id, value)}
                  onCancel={renaming.cancel}
                />
              : <button
                  className="project-main"
                  onClick={() => onToggleProject(project.id)}
                  onDoubleClick={(event) => renaming.start(project.id, event.currentTarget.closest(".project-row"))}
                  title={project.root}
                  aria-expanded={expanded}
                >
                  <span className="folder-icon"><FolderIcon /></span>
                  <span>{projectName(project)}</span>
                </button>}
            <PopoverMenu
              id={`project:${project.id}`}
              openMenu={openMenu}
              onSetOpenMenu={onSetOpenMenu}
              label={`More options for ${projectName(project)}`}
              className="project-menu"
              items={[
                { label: "New task", onSelect: () => onNewThread(project.id) },
                ...checkouts.map(({ worktree }) => ({
                  label: `New thread in ${worktreeName(worktree)}`,
                  onSelect: () => onNewThread(project.id, worktree.id),
                })),
                { label: "Edit…", onSelect: () => onEditProject(project.id) },
                { label: "Remove", danger: true, onSelect: () => onRemoveProject(project.id) },
              ]}
            />
            <button className="project-new" onClick={() => onNewThread(project.id)} aria-label={`New task in ${projectName(project)}`}><SquarePen size={16} /></button>
          </div>
          {/** A folded folder holds no droppable, so a drag neither unfolds it nor opens a gap where it sits. */}
          {expanded && <Droppable droppableId={project.id} type="task">
            {(provided) => (
              <div className="project-tasks" ref={provided.innerRef} {...provided.droppableProps}>
                {threads.slice(0, shown).map((thread, threadIndex) => renderRow(thread, threadIndex, `project-task-row ${thread.id === currentId ? "active" : ""}`, <span>{thread.title}</span>))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>}
          {expanded && threads.length === 0 && <p className="empty-tasks">No threads yet</p>}
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

export type SidebarProjectsProps = {
  projects: Project[];
  /** The threads each project holds, in the order the folder lists them. */
  threadsByProject: Map<string, Thread[]>;
  checkoutsByProject: Map<string, WorktreeGroup[]>;
  recentThreads: Thread[];
  currentId: string | null;
  draftProjectId: string | null;
  expandedProjects: Set<string>;
  sections: SidebarSections;
  shownThreads: ShownThreads;
  openMenu: string | null;
  formatTime: (value: number) => string;
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

export function SidebarProjects({
  projects,
  threadsByProject,
  checkoutsByProject,
  recentThreads,
  currentId,
  draftProjectId,
  expandedProjects,
  sections,
  shownThreads,
  openMenu,
  formatTime,
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

  return (
    <>
      <div className="section-heading projects-heading">
        <button className="section-toggle" onClick={() => onSetSectionOpen("projects", !sections.projects)} aria-expanded={sections.projects}>
          <span>Projects</span><span className="section-chevron" aria-hidden="true" />
        </button>
        <button className="section-action add-project" onClick={onOpenFolder} aria-label="Add project">＋</button>
      </div>
      {sections.projects && <Droppable droppableId={PROJECTS_DROPPABLE} type={PROJECT_DRAG}>
        {(list) => (
          <nav className="project-list" aria-label="Projects" ref={list.innerRef} {...list.droppableProps}>
            {projects.map((project, projectIndex) => (
              <ProjectRow
                key={project.id}
                project={project}
                index={projectIndex}
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
          </nav>
        )}
      </Droppable>}

      <div className="section-heading recents-heading">
        <button className="section-toggle" onClick={() => onSetSectionOpen("recents", !sections.recents)} aria-expanded={sections.recents}>
          <span>Recents</span><span className="section-chevron" aria-hidden="true" />
        </button>
        <PopoverMenu
          id="recents"
          openMenu={openMenu}
          onSetOpenMenu={onSetOpenMenu}
          label="Recent chat options"
          className="section-menu"
          popoverClassName="section-menu-popover"
          items={[{ label: "New chat", onSelect: () => onNewThread() }]}
        />
        <button className="section-action recent-new" onClick={() => onNewThread()} aria-label="New chat"><SquarePen size={16} /></button>
      </div>
      {sections.recents && <Droppable droppableId={RECENTS_DROPPABLE} type="task">
        {(provided, snapshot) => (
          <nav className="task-list" aria-label="Project-less tasks" ref={provided.innerRef} {...provided.droppableProps}>
            {recentThreads.length === 0 && !snapshot.isDraggingOver && <p className="sidebar-empty">No chats</p>}
            {recentThreads.map((thread, index) => renderRow(thread, index, `task-row ${thread.id === currentId ? "active" : ""}`, <span className="task-row-text">
                <span>{thread.title}</span>
                <small>{formatTime(threadActivityAt(thread))}</small>
              </span>))}
            {provided.placeholder}
          </nav>
        )}
      </Droppable>}
    </>
  );
}
