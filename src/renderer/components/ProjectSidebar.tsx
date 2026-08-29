import { useLayoutEffect, useMemo, useRef } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { LuPlus as Plus, LuSettings as Settings } from "react-icons/lu";
import { projectName, type Project, type ThreadDropTarget } from "../../domain/project";
import { hasUnreadAttention } from "../../domain/attention";
import type { Thread } from "../../domain/thread";
import type { SidebarMode, SidebarSection, SidebarSections } from "../../domain/sidebar";
import type { ActivitySections } from "../../application/task-order";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { SidebarActivity } from "./SidebarActivity";
import { SidebarHeader, SidebarResizer } from "./SidebarChrome";
import { PROJECT_DRAG, RECENTS_DROPPABLE, SidebarProjects, useShownTasks } from "./SidebarProjects";
import { useTaskRows } from "./SidebarTaskRow";

export type ProjectSidebarProps = {
  open: boolean;
  inactive: boolean;
  projects: Project[];
  orderedTasks: Thread[];
  recentTasks: Thread[];
  currentId: string | null;
  draftProjectId: string | null;
  expandedProjects: Set<string>;
  runningTaskIds: Set<string>;
  /** Threads stopped on an approval only the user can answer. A subset of {@link runningTaskIds}. */
  blockedTaskIds: Set<string>;
  /** Threads holding a side chat with something unseen, which have no row of their own. */
  sideChatAttention: Set<string>;
  schedules: Map<string, AutomationView>;
  worktreeTaskIds: Set<string>;
  /** The checkouts each project has, with the threads in each. A project offers starting one more there. */
  worktreeGroups: WorktreeGroup[];
  /** The same threads ranked by what wants the user, which is what activity mode draws. */
  activityTasks: ActivitySections;
  mode: SidebarMode;
  sections: SidebarSections;
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
  /** The name typed on the row itself. Blank gives the folder its own name back. */
  onRenameProject: (projectId: string, name: string) => void;
  onEditProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onSetMode: (mode: SidebarMode) => void;
  onSetSectionOpen: (section: SidebarSection, open: boolean) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectTask: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
  /** Takes the dot off one thread, and off every thread carrying one. */
  onDismissTask: (taskId: string) => void;
  onDismissAll: () => void;
  onRenameTask: (taskId: string, title: string) => void;
  onMoveTask: (taskId: string, target: ThreadDropTarget) => void;
  /** Copies the thread into a new one beside it, with a checkout of its own when `worktree`. */
  onForkTask: (taskId: string, worktree: boolean) => void;
  onMoveProject: (projectId: string, index: number) => void;
  onOpenSettings: () => void;
};

function groupedBy<T>(items: T[], keyFor: (item: T) => string | undefined): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (key) grouped.get(key)?.push(item) ?? grouped.set(key, [item]);
  }
  return grouped;
}

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
  blockedTaskIds,
  sideChatAttention,
  schedules,
  worktreeTaskIds,
  worktreeGroups,
  activityTasks,
  mode,
  sections,
  openMenu,
  settingsOpen,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onNewTask,
  onOpenFolder,
  onToggleProject,
  onRenameProject,
  onEditProject,
  onRemoveProject,
  onSetMode,
  onSetSectionOpen,
  onSetOpenMenu,
  onSelectTask,
  onArchiveTask,
  onDismissTask,
  onDismissAll,
  onRenameTask,
  onMoveTask,
  onForkTask,
  onMoveProject,
  onOpenSettings,
}: ProjectSidebarProps) {
  const list = useRef<HTMLElement>(null);
  const shownTasks = useShownTasks();
  let timeFormatter: Intl.DateTimeFormat | undefined;
  const formatTime = (value: number) => (timeFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })).format(value);

  const tasksByProject = useMemo(() => groupedBy(orderedTasks, (task) => task.projectId), [orderedTasks]);
  const checkoutsByProject = useMemo(() => groupedBy(worktreeGroups, (group) => group.worktree.projectId), [worktreeGroups]);

  const { taskRow, activityRow } = useTaskRows({
    projects,
    currentId,
    runningTaskIds,
    blockedTaskIds,
    sideChatAttention,
    schedules,
    worktreeTaskIds,
    worktreeGroups,
    openMenu,
    formatTime,
    onSetOpenMenu,
    onSelectTask,
    onArchiveTask,
    onDismissTask,
    onRenameTask,
    onForkTask,
  });

  /**
   * How wide every rail is: the most marks any one thread carries. Reserving a slot no thread fills
   * only pushes the marks away from the titles.
   */
  const railSlots = [...orderedTasks, ...recentTasks].reduce((widest, task) => Math.max(widest, markCount(task)), 1);

  /** Every thread carries its engine mark, which also covers the one slot an action needs. */
  function markCount(task: Thread) {
    const status = blockedTaskIds.has(task.id) || runningTaskIds.has(task.id) || hasUnreadAttention(task) || sideChatAttention.has(task.id);
    return 1 + Number(worktreeTaskIds.has(task.id)) + Number(schedules.has(task.id)) + Number(status);
  }

  /** Stepping through threads from the keyboard is blind unless the list follows the one now open. */
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(".task-row.active, .project-task-row.active")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  /** One context carries both drags; `type` says which list the drop belongs to. */
  function finishDrag({ draggableId, type, source, destination }: DropResult) {
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    if (type === PROJECT_DRAG) return onMoveProject(draggableId, destination.index);
    onMoveTask(draggableId, {
      projectId: destination.droppableId === RECENTS_DROPPABLE ? null : destination.droppableId,
      index: destination.index,
    });
  }

  return (
    <DragDropContext onDragEnd={finishDrag}>
    <aside
      ref={list}
      className={`sidebar ${open ? "compact-open" : "hidden"}`}
      inert={inactive || !open}
      style={{ "--row-slots": railSlots } as React.CSSProperties}
    >
      <SidebarHeader mode={mode} canGoBack={canGoBack} canGoForward={canGoForward} onSetMode={onSetMode} onGoBack={onGoBack} onGoForward={onGoForward} />
      <button className="new-task-button" onClick={() => onNewTask()} aria-label="New task" data-tip="New task">
        {/** Two copies of one outline: the resting hairline, and the accent that draws over it on hover. */}
        <svg className="new-task-edge" aria-hidden="true" focusable="false">
          <rect className="new-task-edge-rest" pathLength={100} />
          <rect className="new-task-edge-draw" pathLength={100} />
        </svg>
        <Plus className="new-task-icon" size={17} />
      </button>

      <div className="sidebar-scroll">
        {mode === "activity" && <SidebarActivity
          activityTasks={activityTasks}
          sections={sections}
          blockedTaskIds={blockedTaskIds}
          onSetSectionOpen={onSetSectionOpen}
          onDismissAll={onDismissAll}
          renderRow={activityRow}
        />}

        {mode === "projects" && <SidebarProjects
          projects={projects}
          tasksByProject={tasksByProject}
          checkoutsByProject={checkoutsByProject}
          recentTasks={recentTasks}
          currentId={currentId}
          draftProjectId={draftProjectId}
          expandedProjects={expandedProjects}
          sections={sections}
          shownTasks={shownTasks}
          openMenu={openMenu}
          formatTime={formatTime}
          renderRow={taskRow}
          onSetSectionOpen={onSetSectionOpen}
          onSetOpenMenu={onSetOpenMenu}
          onNewTask={onNewTask}
          onOpenFolder={onOpenFolder}
          onToggleProject={onToggleProject}
          onRenameProject={onRenameProject}
          onEditProject={onEditProject}
          onRemoveProject={onRemoveProject}
        />}
      </div>
      <button className={`sidebar-settings ${settingsOpen ? "active" : ""}`} type="button" aria-pressed={settingsOpen} onClick={onOpenSettings}>
        <Settings size={17} aria-hidden="true" />
        <span>Settings</span>
      </button>
      <SidebarResizer />
    </aside>
    </DragDropContext>
  );
}
