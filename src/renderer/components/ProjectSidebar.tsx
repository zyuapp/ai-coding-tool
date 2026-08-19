import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DragDropContext, Draggable, Droppable, type DraggableProvided, type DropResult } from "@hello-pangea/dnd";
import { AlarmClock, Archive, ChevronLeft, ChevronRight, Ellipsis, GitBranch, Settings, SquarePen } from "lucide-react";
import { projectName } from "../../domain/task";
import type { TaskDropTarget } from "../../domain/task";
import type { Project, Task, TaskAttention } from "../../domain/task";

const RECENTS_DROPPABLE = "recents";
const PROJECT_TASK_LIMIT = 10;

const ATTENTION_LABELS: Record<TaskAttention, string> = {
  finished: "Finished",
  failed: "Failed",
  approval: "Needs approval",
};

function TaskSpinner() {
  const ref = useRef<HTMLSpanElement>(null);
  // Anchor every spinner to the document timeline so rows that mount later stay in phase.
  useLayoutEffect(() => {
    for (const animation of ref.current?.getAnimations() ?? []) animation.startTime = 0;
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
  compactOpen: boolean;
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
  projectsOpen: boolean;
  recentsOpen: boolean;
  openMenu: string | null;
  settingsOpen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onNewTask: (projectId?: string) => void;
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
  onOpenSettings: () => void;
};

export function ProjectSidebar({
  compactOpen,
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
  onOpenSettings,
}: ProjectSidebarProps) {
  const [taskMenuPosition, setTaskMenuPosition] = useState({ left: 0, top: 0 });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** Every folder accepts drops mid-drag, so a collapsed one is still a place to drop into.
   *  Revealed before capture: a folder measured while `display: none` has no droppable bounds. */
  const [dragging, setDragging] = useState(false);
  const [showAllTasks, setShowAllTasks] = useState<Set<string>>(new Set());

  /** A folder shows its first ten tasks, and enough more to keep the open one in view.
   *  A drag reveals the rest, so every position in the folder is a place to drop into. */
  function visibleCount(projectTasks: Task[], projectId: string) {
    if (dragging || showAllTasks.has(projectId)) return projectTasks.length;
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

  function finishDrag({ draggableId, source, destination }: DropResult) {
    setDragging(false);
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    onMoveTask(draggableId, {
      projectId: destination.droppableId === RECENTS_DROPPABLE ? null : destination.droppableId,
      index: destination.index,
    });
  }

  function commitRename(taskId: string, value: string) {
    setRenamingId(null);
    if (value.trim()) onRenameTask(taskId, value);
  }

  function resizeSidebar(target: HTMLElement, clientX: number) {
    const sidebar = target.parentElement;
    if (sidebar) sidebar.style.width = `${Math.min(innerWidth / 2, Math.max(220, clientX - sidebar.getBoundingClientRect().left))}px`;
  }

  /** Every task row ends in the same trailing group, and its last cell holds both the
   *  status mark and the archive action, so the two share one center. */
  const taskMarks = (task: Task) => (
    <span className="task-row-marks">
      {worktreeTaskIds.has(task.id) && <GitBranch className="task-worktree" size={13} aria-label="Works in a worktree" />}
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
            onDoubleClick={() => setRenamingId(task.id)}
            onContextMenu={(event) => {
              event.preventDefault();
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
                    else if (event.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={(event) => commitRename(task.id, event.currentTarget.value)}
                />
              : <>{content}{taskMarks(task)}</>}
          </div>
          {openMenu === `task:${task.id}` && createPortal(
            <div className="menu-popover context-menu-popover" data-popover-menu role="menu" style={taskMenuPosition}>
              <button role="menuitem" onClick={() => {
                setRenamingId(task.id);
                onSetOpenMenu(null);
              }}>Rename</button>
              <button role="menuitem" onClick={() => {
                onArchiveTask(task.id);
                onSetOpenMenu(null);
              }}>Archive</button>
            </div>,
            document.body,
          )}
        </div>
      )}
    </Draggable>
  );

  return (
    <DragDropContext onBeforeCapture={() => setDragging(true)} onDragEnd={finishDrag}>
    <aside className={`sidebar ${compactOpen ? "compact-open" : ""}`} inert={inactive}>
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
        {projectsOpen && <nav className="project-list" aria-label="Projects">
          {projects.map((project) => {
            const projectTasks = orderedTasks.filter((task) => task.projectId === project.id);
            const expanded = expandedProjects.has(project.id);
            const attentionCount = projectTasks.filter((task) => task.attention).length;
            const shown = visibleCount(projectTasks, project.id);
            const hidden = projectTasks.length - shown;
            return (
              <section className="project-group" key={project.id}>
                <div className={`project-row ${draftProjectId === project.id ? "current" : ""}`}>
                  <button className="project-main" onClick={() => onToggleProject(project.id)} title={project.root} aria-expanded={expanded}>
                    <span className="folder-icon"><FolderIcon /></span>
                    <span>{projectName(project.root)}</span>
                  </button>
                  {!expanded && attentionCount > 0 && <span className="project-attention-count">{attentionCount}</span>}
                  <div
                    className={`project-menu ${openMenu === `project:${project.id}` ? "open" : ""}`}
                    data-popover-menu
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
                    }}
                  >
                    <button className="menu-trigger" aria-label={`More options for ${projectName(project.root)}`} aria-expanded={openMenu === `project:${project.id}`} onClick={() => onSetOpenMenu(openMenu === `project:${project.id}` ? null : `project:${project.id}`)}><Ellipsis size={16} /></button>
                    {openMenu === `project:${project.id}` && <div className="menu-popover" role="menu">
                      <button role="menuitem" onClick={() => {
                        onNewTask(project.id);
                        onSetOpenMenu(null);
                      }}>New task</button>
                      <button role="menuitem" onClick={() => {
                        onToggleProject(project.id);
                        onSetOpenMenu(null);
                      }}>{expanded ? "Collapse" : "Expand"}</button>
                      <button className="danger-menu-item" role="menuitem" onClick={() => onRemoveProject(project.id)}>Remove</button>
                    </div>
                    }
                  </div>
                  <button className="project-new" onClick={() => onNewTask(project.id)} aria-label={`New task in ${projectName(project.root)}`}><SquarePen size={16} /></button>
                </div>
                <Droppable droppableId={project.id} type="task">
                  {(provided) => (
                    <div
                      className={`project-tasks ${expanded || dragging ? "" : "collapsed"}`}
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                    >
                      {projectTasks.slice(0, shown).map((task, index) => taskRow(task, index, `project-task-row ${task.id === currentId ? "active" : ""}`, <span>{task.title}</span>))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
                {expanded && !dragging && (hidden > 0 || showAllTasks.has(project.id)) && <button
                  className="project-show-more"
                  type="button"
                  onClick={() => toggleShowAll(project.id)}
                  aria-expanded={showAllTasks.has(project.id)}
                >{hidden > 0 ? `Show ${hidden} more` : "Show less"}</button>}
              </section>
            );
          })}
        </nav>}

        <div className="section-heading recents-heading">
          <button className="section-toggle" onClick={() => onSetRecentsOpen(!recentsOpen)} aria-expanded={recentsOpen}>
            <span>Recents</span><span className="section-chevron" aria-hidden="true" />
          </button>
          <div
            className={`section-menu ${openMenu === "recents" ? "open" : ""}`}
            data-popover-menu
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
            }}
          >
            <button className="menu-trigger" aria-label="Recent chat options" aria-expanded={openMenu === "recents"} onClick={() => onSetOpenMenu(openMenu === "recents" ? null : "recents")}><Ellipsis size={16} /></button>
            {openMenu === "recents" && <div className="menu-popover section-menu-popover" role="menu">
              <button role="menuitem" onClick={() => {
                onNewTask();
                onSetOpenMenu(null);
              }}>New chat</button>
            </div>
            }
          </div>
          <button className="section-action recent-new" onClick={() => onNewTask()} aria-label="New chat"><SquarePen size={16} /></button>
        </div>
        <Droppable droppableId={RECENTS_DROPPABLE} type="task">
          {(provided, snapshot) => (
            <nav
              className={`task-list ${recentsOpen || dragging ? "" : "collapsed"}`}
              aria-label="Project-less tasks"
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              {recentTasks.length === 0 && !snapshot.isDraggingOver && <p className="sidebar-empty">No chats</p>}
              {recentTasks.map((task, index) => taskRow(task, index, `task-row ${task.id === currentId ? "active" : ""}`, <span className="task-row-text">
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
