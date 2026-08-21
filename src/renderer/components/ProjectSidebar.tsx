import { useLayoutEffect, useRef, useState } from "react";
import { DragDropContext, Draggable, Droppable, type DraggableProvided, type DropResult } from "@hello-pangea/dnd";
import { AlarmClock, Archive, ChevronLeft, ChevronRight, FolderSymlink, Settings, SquarePen } from "lucide-react";
import { projectName } from "../../domain/task";
import type { TaskDropTarget } from "../../domain/task";
import type { Project, Task, TaskAttention } from "../../domain/task";
import { worktreeName } from "../../domain/worktree";
import type { WorktreeGroup } from "../../application/workspace-state";
import { ContextMenu, PopoverMenu } from "./PopoverMenu";
import { ShowMore } from "./ShowMore";
import { useDismissibleLayer } from "../focus";

const RECENTS_DROPPABLE = "recents";
/** A checkout's list of threads is its own droppable, so an index means a row in that list alone. */
const WORKTREE_DROPPABLE = "worktree:";
const PROJECTS_DROPPABLE = "projects";
const PROJECT_DRAG = "project";
const PROJECT_TASK_LIMIT = 10;

const ATTENTION_LABELS: Record<TaskAttention, string> = {
  finished: "Finished",
  failed: "Failed",
  approval: "Needs approval",
};

function TaskSpinner() {
  const ref = useRef<HTMLSpanElement>(null);
  // Anchor every spinner to the document timeline so rows that mount later stay in phase. A row that
  // mounts while nothing is drawing it has no animation to anchor yet, so each start is anchored too.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const anchor = () => {
      for (const animation of element.getAnimations()) animation.startTime = 0;
    };
    anchor();
    element.addEventListener("animationstart", anchor);
    return () => element.removeEventListener("animationstart", anchor);
  }, []);
  return <span ref={ref} className="task-spinner" aria-label="Working" />;
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
  );
}

export type ProjectSidebarProps = {
  open: boolean;
  inactive: boolean;
  projects: Project[];
  orderedTasks: Task[];
  recentTasks: Task[];
  currentId: string | null;
  draftProjectId: string | null;
  expandedProjects: Set<string>;
  runningTaskIds: Set<string>;
  automatedTaskIds: Set<string>;
  worktreeTaskIds: Set<string>;
  /** The checkouts threads nest under, with the threads in each. Grouped by project when rendered. */
  worktreeGroups: WorktreeGroup[];
  projectsOpen: boolean;
  recentsOpen: boolean;
  openMenu: string | null;
  settingsOpen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  /** A thread in the project, or in one of its checkouts when `worktreeId` names one. */
  onNewTask: (projectId?: string, worktreeId?: string) => void;
  onOpenFolder: () => void;
  onToggleProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onSetProjectsOpen: (open: boolean) => void;
  onSetRecentsOpen: (open: boolean) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectTask: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
  onRenameTask: (taskId: string, title: string) => void;
  onMoveTask: (taskId: string, target: TaskDropTarget) => void;
  onMoveProject: (projectId: string, index: number) => void;
  onOpenSettings: () => void;
};

export function ProjectSidebar({
  open,
  inactive,
  projects,
  orderedTasks,
  recentTasks,
  currentId,
  draftProjectId,
  expandedProjects,
  runningTaskIds,
  automatedTaskIds,
  worktreeTaskIds,
  worktreeGroups,
  projectsOpen,
  recentsOpen,
  openMenu,
  settingsOpen,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onNewTask,
  onOpenFolder,
  onToggleProject,
  onRemoveProject,
  onSetProjectsOpen,
  onSetRecentsOpen,
  onSetOpenMenu,
  onSelectTask,
  onArchiveTask,
  onRenameTask,
  onMoveTask,
  onMoveProject,
  onOpenSettings,
}: ProjectSidebarProps) {
  const [taskMenuPosition, setTaskMenuPosition] = useState({ left: 0, top: 0 });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const taskReturn = useRef<HTMLElement>(null);
  useDismissibleLayer(renamingId !== null, [renameInput], () => renameInput.current?.blur(), taskReturn);
  /** A folded row becomes a thin drop strip for the length of a thread drag, so a collapsed folder is
   *  a place to drop into without unfolding. Set before capture: a `display: none` droppable has no
   *  bounds for the library to measure. A folder drag takes no threads, so it leaves the folding alone. */
  const [dragging, setDragging] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState<Set<string>>(new Set());

  /** A folder shows its first ten tasks, and enough more to keep the open one in view. */
  function visibleCount(projectTasks: Task[], projectId: string) {
    if (showAllTasks.has(projectId)) return projectTasks.length;
    const current = projectTasks.findIndex((task) => task.id === currentId);
    return Math.max(PROJECT_TASK_LIMIT, current + 1);
  }

  function toggleShowAll(projectId: string) {
    setShowAllTasks((shown) => {
      const next = new Set(shown);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });
  }

  /** One context carries both drags; `type` says which list the drop belongs to. */
  function finishDrag({ draggableId, type, source, destination }: DropResult) {
    setDragging(false);
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    if (type === PROJECT_DRAG) return onMoveProject(draggableId, destination.index);
    /** A checkout places the threads working in it, so a drag only ever reorders one within its own. */
    const worktreeId = destination.droppableId.startsWith(WORKTREE_DROPPABLE)
      ? destination.droppableId.slice(WORKTREE_DROPPABLE.length)
      : undefined;
    if (source.droppableId !== destination.droppableId && (worktreeId || source.droppableId.startsWith(WORKTREE_DROPPABLE))) return;
    const project = worktreeId
      ? worktreeGroups.find((group) => group.worktree.id === worktreeId)?.worktree.projectId ?? null
      : destination.droppableId === RECENTS_DROPPABLE ? null : destination.droppableId;
    onMoveTask(draggableId, {
      projectId: project,
      ...(worktreeId ? { worktreeId } : {}),
      index: destination.index,
    });
  }

  function commitRename(taskId: string, value: string) {
    setRenamingId(null);
    if (value.trim()) onRenameTask(taskId, value);
  }

  function startRename(taskId: string, row?: HTMLElement | null) {
    if (row) taskReturn.current = row;
    setRenamingId(taskId);
  }

  function resizeSidebar(target: HTMLElement, clientX: number) {
    const sidebar = target.parentElement;
    /** The width is a custom property because the hidden state slides the sidebar out by that same width. */
    if (sidebar) sidebar.style.setProperty("--sidebar-width", `${Math.min(innerWidth / 2, Math.max(220, clientX - sidebar.getBoundingClientRect().left))}px`);
  }

  /** Every task row ends in the same trailing group, and its last cell holds both the
   *  status mark and the archive action, so the two share one center. */
  const taskMarks = (task: Task) => (
    <span className="task-row-marks">
      {worktreeTaskIds.has(task.id) && <FolderSymlink className="task-worktree" size={13} aria-label="Works in a worktree" />}
      {automatedTaskIds.has(task.id) && <AlarmClock className="task-automation" size={13} aria-label="Runs on a schedule" />}
      <span className="row-slot">
        {runningTaskIds.has(task.id)
          ? <TaskSpinner />
          : task.attention && <span className={`task-attention ${task.attention}`} aria-label={ATTENTION_LABELS[task.attention]} />}
        <button
          className="task-archive"
          type="button"
          aria-label={`Archive ${task.title}`}
          onClick={(event) => {
            event.stopPropagation();
            onArchiveTask(task.id);
          }}
        >
          <Archive size={13} aria-hidden="true" />
        </button>
      </span>
    </span>
  );

  const taskRow = (task: Task, index: number, className: string, content: React.ReactNode) => (
    <Draggable draggableId={task.id} index={index} key={task.id}>
      {(provided: DraggableProvided, snapshot) => (
        <div
          className={`task-entry ${snapshot.isDragging ? "is-dragging" : ""}`}
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSelectTask(task.id);
          }}
        >
          <div
            className={className}
            onClick={() => onSelectTask(task.id)}
            onDoubleClick={(event) => startRename(task.id, event.currentTarget.closest(".task-entry"))}
            onContextMenu={(event) => {
              event.preventDefault();
              taskReturn.current = event.currentTarget.closest(".task-entry");
              const row = event.currentTarget.getBoundingClientRect();
              const menuHeight = 80;
              setTaskMenuPosition({
                left: Math.max(8, Math.min(row.right - 128, innerWidth - 136)),
                top: row.bottom + menuHeight + 4 <= innerHeight ? row.bottom + 4 : Math.max(8, row.top - menuHeight - 4),
              });
              onSetOpenMenu(`task:${task.id}`);
            }}
            title={task.title}
          >
            {renamingId === task.id
              ? <input
                  ref={renameInput}
                  className="task-rename"
                  aria-label={`Rename ${task.title}`}
                  autoFocus
                  defaultValue={task.title}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  /** The row selects on Enter and dragging claims the arrow and space keys. */
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") commitRename(task.id, event.currentTarget.value);
                    else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                  onBlur={(event) => commitRename(task.id, event.currentTarget.value)}
                />
              : <>{content}{taskMarks(task)}</>}
          </div>
          {openMenu === `task:${task.id}` && <ContextMenu
            position={taskMenuPosition}
            returnFocus={taskReturn}
            onSetOpenMenu={onSetOpenMenu}
            items={[
              { label: "Rename", onSelect: () => startRename(task.id) },
              { label: "Archive", onSelect: () => onArchiveTask(task.id) },
            ]}
          />}
        </div>
      )}
    </Draggable>
  );

  return (
    <DragDropContext
      onBeforeCapture={({ draggableId }) => setDragging(!projects.some((project) => project.id === draggableId))}
      onDragEnd={finishDrag}
    >
    <aside className={`sidebar ${open ? "compact-open" : "hidden"}`} inert={inactive || !open}>
      <div className="traffic-space">
        <div className="thread-nav">
          <button className="thread-nav-button" type="button" aria-label="Go back" disabled={!canGoBack} onClick={onGoBack}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button className="thread-nav-button" type="button" aria-label="Go forward" disabled={!canGoForward} onClick={onGoForward}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <button className="new-task-button" onClick={() => onNewTask()}>
        <span className="new-task-icon" aria-hidden="true">＋</span>
        <span>New task</span>
      </button>

      <div className="sidebar-scroll">
        <div className="section-heading projects-heading">
          <button className="section-toggle" onClick={() => onSetProjectsOpen(!projectsOpen)} aria-expanded={projectsOpen}>
            <span>Projects</span><span className="section-chevron" aria-hidden="true" />
          </button>
          <button className="section-action add-project" onClick={onOpenFolder} aria-label="Add project">＋</button>
        </div>
        {projectsOpen && <Droppable droppableId={PROJECTS_DROPPABLE} type={PROJECT_DRAG}>
          {(list) => (
            <nav className="project-list" aria-label="Projects" ref={list.innerRef} {...list.droppableProps}>
              {projects.map((project, projectIndex) => {
                const projectTasks = orderedTasks.filter((task) => task.projectId === project.id);
                /** A checkout's threads nest under it; the rest are the project's own list. */
                const checkouts = worktreeGroups.filter((group) => group.worktree.projectId === project.id);
                const loose = projectTasks.filter((task) => !task.worktreeId);
                const expanded = expandedProjects.has(project.id);
                const attentionCount = projectTasks.filter((task) => task.attention).length;
                const shown = visibleCount(loose, project.id);
                const hidden = loose.length - shown;
                return (
                  <Draggable draggableId={project.id} index={projectIndex} key={project.id} disableInteractiveElementBlocking>
                    {(dragged: DraggableProvided, snapshot) => (
                      <section
                        className={`project-group ${snapshot.isDragging ? "is-dragging" : ""}`}
                        ref={dragged.innerRef}
                        {...dragged.draggableProps}
                      >
                        {/** The header row is the handle, buttons and all: the library refuses to lift from a
                          *  button unless told otherwise, and the row is nothing but buttons. It swallows the
                          *  click a drag ends on, so the row keeps its click-to-fold. */}
                        <div className={`project-row ${draftProjectId === project.id ? "current" : ""}`} {...dragged.dragHandleProps}>
                          <button className="project-main" onClick={() => onToggleProject(project.id)} title={project.root} aria-expanded={expanded}>
                            <span className="folder-icon"><FolderIcon /></span>
                            <span>{projectName(project.root)}</span>
                          </button>
                          {!expanded && attentionCount > 0 && <span className="project-attention-count">{attentionCount}</span>}
                          <PopoverMenu
                            id={`project:${project.id}`}
                            openMenu={openMenu}
                            onSetOpenMenu={onSetOpenMenu}
                            label={`More options for ${projectName(project.root)}`}
                            className="project-menu"
                            items={[
                              { label: "New task", onSelect: () => onNewTask(project.id) },
                              { label: expanded ? "Collapse" : "Expand", onSelect: () => onToggleProject(project.id) },
                              { label: "Remove", danger: true, onSelect: () => onRemoveProject(project.id) },
                            ]}
                          />
                          <button className="project-new" onClick={() => onNewTask(project.id)} aria-label={`New task in ${projectName(project.root)}`}><SquarePen size={16} /></button>
                        </div>
                        {expanded && checkouts.map(({ worktree, tasks }) => (
                          <div className="worktree-group" key={worktree.id}>
                            <div className="worktree-row">
                              <span className="worktree-row-icon"><FolderSymlink size={13} aria-hidden="true" /></span>
                              <span className="worktree-row-name" title={worktree.root}>{worktreeName(worktree)}</span>
                              <PopoverMenu
                                id={`worktree:${worktree.id}`}
                                openMenu={openMenu}
                                onSetOpenMenu={onSetOpenMenu}
                                label={`More options for ${worktreeName(worktree)}`}
                                className="worktree-menu"
                                items={[{ label: "New thread here", onSelect: () => onNewTask(project.id, worktree.id) }]}
                              />
                              <button
                                className="worktree-new"
                                type="button"
                                onClick={() => onNewTask(project.id, worktree.id)}
                                aria-label={`New thread in ${worktreeName(worktree)}`}
                              >
                                <SquarePen size={14} />
                              </button>
                            </div>
                            <Droppable droppableId={`${WORKTREE_DROPPABLE}${worktree.id}`} type="task">
                              {(provided) => (
                                <div className="worktree-tasks" ref={provided.innerRef} {...provided.droppableProps}>
                                  {tasks.map((task, index) => taskRow(task, index, `project-task-row worktree-task-row ${task.id === currentId ? "active" : ""}`, <span>{task.title}</span>))}
                                  {provided.placeholder}
                                </div>
                              )}
                            </Droppable>
                          </div>
                        ))}
                        <Droppable droppableId={project.id} type="task">
                          {(provided) => (
                            <div
                              className={`project-tasks ${expanded ? "" : dragging ? "drop-strip" : "collapsed"}`}
                              ref={provided.innerRef}
                              {...provided.droppableProps}
                            >
                              {expanded && loose.slice(0, shown).map((task, index) => taskRow(task, index, `project-task-row ${task.id === currentId ? "active" : ""}`, <span>{task.title}</span>))}
                              {provided.placeholder}
                            </div>
                          )}
                        </Droppable>
                        {expanded && (hidden > 0 || showAllTasks.has(project.id)) && (
                          <ShowMore
                            label={hidden > 0 ? `Show ${hidden} more` : "Show less"}
                            expanded={showAllTasks.has(project.id)}
                            onSelect={() => toggleShowAll(project.id)}
                          />
                        )}
                      </section>
                    )}
                  </Draggable>
                );
              })}
              {list.placeholder}
            </nav>
          )}
        </Droppable>}

        <div className="section-heading recents-heading">
          <button className="section-toggle" onClick={() => onSetRecentsOpen(!recentsOpen)} aria-expanded={recentsOpen}>
            <span>Recents</span><span className="section-chevron" aria-hidden="true" />
          </button>
          <PopoverMenu
            id="recents"
            openMenu={openMenu}
            onSetOpenMenu={onSetOpenMenu}
            label="Recent chat options"
            className="section-menu"
            popoverClassName="section-menu-popover"
            items={[{ label: "New chat", onSelect: () => onNewTask() }]}
          />
          <button className="section-action recent-new" onClick={() => onNewTask()} aria-label="New chat"><SquarePen size={16} /></button>
        </div>
        <Droppable droppableId={RECENTS_DROPPABLE} type="task">
          {(provided, snapshot) => (
            <nav
              className={`task-list ${recentsOpen ? "" : dragging ? "drop-strip" : "collapsed"}`}
              aria-label="Project-less tasks"
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              {recentsOpen && recentTasks.length === 0 && !snapshot.isDraggingOver && <p className="sidebar-empty">No chats</p>}
              {recentsOpen && recentTasks.map((task, index) => taskRow(task, index, `task-row ${task.id === currentId ? "active" : ""}`, <span className="task-row-text">
                  <span>{task.title}</span>
                  <small>{formatTime(task.updatedAt)}</small>
                </span>))}
              {provided.placeholder}
            </nav>
          )}
        </Droppable>
      </div>
      <button className={`sidebar-settings ${settingsOpen ? "active" : ""}`} type="button" aria-pressed={settingsOpen} onClick={onOpenSettings}>
        <Settings size={17} aria-hidden="true" />
        <span>Settings</span>
      </button>
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
    </aside>
    </DragDropContext>
  );
}
