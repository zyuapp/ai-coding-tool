import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ellipsis, Settings, SquarePen } from "lucide-react";
import type { TaskDropTarget } from "../../application/task-order";
import type { Project, Task, TaskAttention } from "../../domain/task";

const ATTENTION_LABELS: Record<TaskAttention, string> = {
  finished: "Finished",
  failed: "Failed",
  approval: "Needs approval",
};

function shortFolder(folder: string) {
  return folder.split("/").filter(Boolean).at(-1) ?? folder;
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
  projectsOpen: boolean;
  recentsOpen: boolean;
  openMenu: string | null;
  settingsOpen: boolean;
  onNewTask: (projectId?: string) => void;
  onOpenFolder: () => void;
  onToggleProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onSetProjectsOpen: (open: boolean) => void;
  onSetRecentsOpen: (open: boolean) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectTask: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
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
  projectsOpen,
  recentsOpen,
  openMenu,
  settingsOpen,
  onNewTask,
  onOpenFolder,
  onToggleProject,
  onRemoveProject,
  onSetProjectsOpen,
  onSetRecentsOpen,
  onSetOpenMenu,
  onSelectTask,
  onArchiveTask,
  onMoveTask,
  onOpenSettings,
}: ProjectSidebarProps) {
  const [taskMenuPosition, setTaskMenuPosition] = useState({ left: 0, top: 0 });
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  const drag = useRef<{ taskId: string; startY: number } | null>(null);
  const hint = useRef<{ key: string; target: TaskDropTarget } | null>(null);
  const dropped = useRef(false);

  /** Resolves the row or group under the pointer; drop zones are marked with data attributes. */
  function hintAt(taskId: string, clientX: number, clientY: number) {
    const under = document.elementFromPoint(clientX, clientY);
    const row = under?.closest?.("[data-task-id]");
    const overId = row?.getAttribute("data-task-id");
    if (row && overId && overId !== taskId) {
      const box = row.getBoundingClientRect();
      const place = clientY < box.top + box.height / 2 ? "before" : "after";
      return { key: `task:${overId}:${place}`, target: { taskId: overId, place } as TaskDropTarget };
    }
    const group = under?.closest?.("[data-project-drop]");
    const projectId = group?.getAttribute("data-project-drop");
    if (projectId) return { key: `project:${projectId}`, target: { projectId: projectId === "recents" ? null : projectId } as TaskDropTarget };
    return null;
  }

  function endDrag() {
    drag.current = null;
    hint.current = null;
    setDragTaskId(null);
    setDropHint(null);
  }

  useEffect(() => {
    if (!dragTaskId) return;
    const track = (event: PointerEvent) => {
      hint.current = hintAt(dragTaskId, event.clientX, event.clientY);
      setDropHint(hint.current?.key ?? null);
    };
    const drop = () => {
      const target = hint.current?.target;
      endDrag();
      dropped.current = true;
      if (target) onMoveTask(dragTaskId, target);
    };
    window.addEventListener("pointermove", track);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointermove", track);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
    };
  }, [dragTaskId, onMoveTask]);

  function resizeSidebar(target: HTMLElement, clientX: number) {
    const sidebar = target.parentElement;
    if (sidebar) sidebar.style.width = `${Math.min(innerWidth / 2, Math.max(220, clientX - sidebar.getBoundingClientRect().left))}px`;
  }

  const taskRow = (task: Task, className: string, content: React.ReactNode) => (
    <div
      className={`task-entry ${dragTaskId === task.id ? "dragging" : ""} ${dropHint === `task:${task.id}:before` ? "drop-before" : ""} ${dropHint === `task:${task.id}:after` ? "drop-after" : ""}`}
      key={task.id}
      data-task-id={task.id}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { taskId: task.id, startY: event.clientY };
      }}
      onPointerMove={(event) => {
        if (drag.current?.taskId !== task.id || dragTaskId) return;
        if (Math.abs(event.clientY - drag.current.startY) < 5) return;
        setDragTaskId(task.id);
      }}
    >
      <button
        className={className}
        onClick={() => {
          if (dropped.current) {
            dropped.current = false;
            return;
          }
          onSelectTask(task.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          const row = event.currentTarget.getBoundingClientRect();
          const menuHeight = 48;
          setTaskMenuPosition({
            left: Math.max(8, Math.min(row.right - 128, innerWidth - 136)),
            top: row.bottom + menuHeight + 4 <= innerHeight ? row.bottom + 4 : Math.max(8, row.top - menuHeight - 4),
          });
          onSetOpenMenu(`task:${task.id}`);
        }}
        title={task.title}
      >
        {content}
      </button>
      {openMenu === `task:${task.id}` && createPortal(
        <div className="task-context-menu project-menu-popover" data-popover-menu role="menu" style={taskMenuPosition}>
          <button role="menuitem" onClick={() => {
            onArchiveTask(task.id);
            onSetOpenMenu(null);
          }}>Archive</button>
        </div>,
        document.body,
      )}
    </div>
  );

  return (
    <aside className={`sidebar ${compactOpen ? "compact-open" : ""}`} inert={inactive}>
      <div className="traffic-space" aria-hidden="true" />
      <div className="brand-row">
        <strong>Claudex</strong>
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
            return (
              <section className="project-group" key={project.id}>
                <div
                  className={`project-row ${draftProjectId === project.id ? "current" : ""} ${dropHint === `project:${project.id}` ? "drop-into" : ""}`}
                  data-project-drop={project.id}
                >
                  <button className="project-main" onClick={() => onToggleProject(project.id)} title={project.root} aria-expanded={expanded}>
                    <span className="folder-icon"><FolderIcon /></span>
                    <span>{shortFolder(project.root)}</span>
                    {!expanded && attentionCount > 0 && <span className="project-attention-count">{attentionCount}</span>}
                  </button>
                  <div
                    className={`project-menu ${openMenu === `project:${project.id}` ? "open" : ""}`}
                    data-popover-menu
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
                    }}
                  >
                    <button className="menu-trigger" aria-label={`More options for ${shortFolder(project.root)}`} aria-expanded={openMenu === `project:${project.id}`} onClick={() => onSetOpenMenu(openMenu === `project:${project.id}` ? null : `project:${project.id}`)}><Ellipsis size={16} /></button>
                    {openMenu === `project:${project.id}` && <div className="project-menu-popover" role="menu">
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
                  <button className="project-new" onClick={() => onNewTask(project.id)} aria-label={`New task in ${shortFolder(project.root)}`}><SquarePen size={16} /></button>
                </div>
                {expanded && projectTasks.length > 0 && (
                  <div className="project-tasks">
                    {projectTasks.map((task) => taskRow(task, `project-task-row ${task.id === currentId ? "active" : ""}`, <>
                        <span>{task.title}</span>
                        {runningTaskIds.has(task.id)
                          ? <span className="task-spinner" aria-label="Working" />
                          : task.attention && <span className={`task-attention ${task.attention}`} aria-label={ATTENTION_LABELS[task.attention]} />}
                      </>))}
                  </div>
                )}
              </section>
            );
          })}
        </nav>}

        <div className={`section-heading recents-heading ${dropHint === "project:recents" ? "drop-into" : ""}`} data-project-drop="recents">
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
            {openMenu === "recents" && <div className="project-menu-popover section-menu-popover" role="menu">
              <button role="menuitem" onClick={() => {
                onNewTask();
                onSetOpenMenu(null);
              }}>New chat</button>
            </div>
            }
          </div>
          <button className="section-action recent-new" onClick={() => onNewTask()} aria-label="New chat"><SquarePen size={16} /></button>
        </div>
        {recentsOpen && <nav className="task-list" aria-label="Project-less tasks">
          {recentTasks.length === 0 ? (
            <p className="sidebar-empty">No chats</p>
          ) : (
            recentTasks.map((task) => taskRow(task, `task-row ${task.id === currentId ? "active" : ""}`, <>
                <span>{task.title}</span>
                <small>
                  {formatTime(task.updatedAt)}
                  {task.attention && <span className={`task-attention ${task.attention}`} aria-label={ATTENTION_LABELS[task.attention]} />}
                </small>
              </>))
          )}
        </nav>}
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
  );
}
