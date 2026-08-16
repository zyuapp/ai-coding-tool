import type { Project, Task } from "../../domain/task";

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

function ComposeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13.5 5.5H6.8A2.8 2.8 0 0 0 4 8.3v8.9A2.8 2.8 0 0 0 6.8 20h8.9a2.8 2.8 0 0 0 2.8-2.8v-6.7M11 13l1.1-3.2L18.9 3a1.5 1.5 0 0 1 2.1 2.1l-6.8 6.8L11 13Z" />
    </svg>
  );
}

export type ProjectSidebarProps = {
  projects: Project[];
  orderedTasks: Task[];
  recentTasks: Task[];
  currentId: string | null;
  draftProjectId: string | null;
  expandedProjects: Set<string>;
  status: "idle" | "running" | "stopped";
  runningTaskId: string | null;
  projectsOpen: boolean;
  recentsOpen: boolean;
  openMenu: string | null;
  chatSort: "priority" | "updated" | "manual";
  onNewTask: (projectId?: string) => void;
  onOpenFolder: () => void;
  onToggleProject: (projectId: string) => void;
  onSetProjectsOpen: (open: boolean) => void;
  onSetRecentsOpen: (open: boolean) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSetChatSort: (sort: "priority" | "updated" | "manual") => void;
  onSelectTask: (taskId: string) => void;
};

export function ProjectSidebar({
  projects,
  orderedTasks,
  recentTasks,
  currentId,
  draftProjectId,
  expandedProjects,
  status,
  runningTaskId,
  projectsOpen,
  recentsOpen,
  openMenu,
  chatSort,
  onNewTask,
  onOpenFolder,
  onToggleProject,
  onSetProjectsOpen,
  onSetRecentsOpen,
  onSetOpenMenu,
  onSetChatSort,
  onSelectTask,
}: ProjectSidebarProps) {
  return (
    <aside className="sidebar">
      <div className="traffic-space" aria-hidden="true" />
      <div className="brand-row">
        <strong>Threadline</strong>
        <span className="brand-chevron" aria-hidden="true">⌄</span>
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
          <div
            className={`section-menu ${openMenu === "projects" ? "open" : ""}`}
            data-popover-menu
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
            }}
          >
            <button className="menu-trigger" aria-label="Project options" aria-expanded={openMenu === "projects"} onClick={() => onSetOpenMenu(openMenu === "projects" ? null : "projects")}>•••</button>
            {openMenu === "projects" && <div className="project-menu-popover section-menu-popover" role="menu">
              <div className="menu-label">Organize sidebar</div>
              <button className="menu-choice selected" role="menuitemradio" aria-checked="true"><span>✓</span>By project</button>
              <button className="menu-choice" role="menuitemradio" aria-checked="false"><span />In one list</button>
              <div className="menu-label menu-label-spaced">Sort chats by</div>
              {(["priority", "updated", "manual"] as const).map((sort) => (
                <button
                  className={`menu-choice ${chatSort === sort ? "selected" : ""}`}
                  role="menuitemradio"
                  aria-checked={chatSort === sort}
                  key={sort}
                  onClick={() => {
                    onSetChatSort(sort);
                    onSetOpenMenu(null);
                  }}
                ><span>{chatSort === sort ? "✓" : ""}</span>{sort === "updated" ? "Last updated" : `${sort[0].toUpperCase()}${sort.slice(1)}${sort === "manual" ? " order" : ""}`}</button>
              ))}
            </div>
            }
          </div>
          <button className="section-action add-project" onClick={onOpenFolder} aria-label="Add project">＋</button>
        </div>
        {projectsOpen && <nav className="project-list" aria-label="Projects">
          {projects.map((project) => {
            const projectTasks = orderedTasks.filter((task) => task.projectId === project.id);
            const expanded = expandedProjects.has(project.id);
            return (
              <section className="project-group" key={project.id}>
                <div className={`project-row ${draftProjectId === project.id ? "current" : ""}`}>
                  <button className="project-main" onClick={() => onToggleProject(project.id)} title={project.root} aria-expanded={expanded}>
                    <span className="folder-icon"><FolderIcon /></span>
                    <span>{shortFolder(project.root)}</span>
                  </button>
                  <div
                    className={`project-menu ${openMenu === `project:${project.id}` ? "open" : ""}`}
                    data-popover-menu
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
                    }}
                  >
                    <button className="menu-trigger" aria-label={`More options for ${shortFolder(project.root)}`} aria-expanded={openMenu === `project:${project.id}`} onClick={() => onSetOpenMenu(openMenu === `project:${project.id}` ? null : `project:${project.id}`)}>•••</button>
                    {openMenu === `project:${project.id}` && <div className="project-menu-popover" role="menu">
                      <button role="menuitem" onClick={() => {
                        onNewTask(project.id);
                        onSetOpenMenu(null);
                      }}>New task</button>
                      <button role="menuitem" onClick={() => {
                        onToggleProject(project.id);
                        onSetOpenMenu(null);
                      }}>{expanded ? "Collapse" : "Expand"}</button>
                    </div>
                    }
                  </div>
                  <button className="project-new" onClick={() => onNewTask(project.id)} aria-label={`New task in ${shortFolder(project.root)}`}><ComposeIcon /></button>
                </div>
                {expanded && projectTasks.length > 0 && (
                  <div className="project-tasks">
                    {projectTasks.map((task) => (
                      <button
                        key={task.id}
                        className={`project-task-row ${task.id === currentId ? "active" : ""}`}
                        onClick={() => onSelectTask(task.id)}
                        title={task.title}
                      >
                        <span>{task.title}</span>
                        {status === "running" && task.id === runningTaskId && <span className="task-spinner" aria-label="Working" />}
                      </button>
                    ))}
                  </div>
                )}
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
            <button className="menu-trigger" aria-label="Recent chat options" aria-expanded={openMenu === "recents"} onClick={() => onSetOpenMenu(openMenu === "recents" ? null : "recents")}>•••</button>
            {openMenu === "recents" && <div className="project-menu-popover section-menu-popover" role="menu">
              <button role="menuitem" onClick={() => {
                onNewTask();
                onSetOpenMenu(null);
              }}>New chat</button>
            </div>
            }
          </div>
          <button className="section-action recent-new" onClick={() => onNewTask()} aria-label="New chat"><ComposeIcon /></button>
        </div>
        {recentsOpen && <nav className="task-list" aria-label="Project-less tasks">
          {recentTasks.length === 0 ? (
            <p className="sidebar-empty">No chats</p>
          ) : (
            recentTasks.map((task) => (
              <button
                key={task.id}
                className={`task-row ${task.id === currentId ? "active" : ""}`}
                onClick={() => onSelectTask(task.id)}
              >
                <span>{task.title}</span>
                <small>{formatTime(task.updatedAt)}</small>
              </button>
            ))
          )}
        </nav>}
      </div>
    </aside>
  );
}
