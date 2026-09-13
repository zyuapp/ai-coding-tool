import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { LuPlus as Plus, LuSettings as Settings } from "react-icons/lu";
import type { Project, ThreadDropTarget } from "../../domain/project";
import { hasUnreadAttention } from "../../domain/attention";
import type { Thread } from "../../domain/thread";
import type { SidebarMode, SidebarSection, SidebarSections } from "../../domain/sidebar";
import type { ActivitySections } from "../../application/thread-order";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { SidebarActivity } from "./SidebarActivity";
import { ComputerSwitch, SidebarHeader, SidebarResizer } from "./SidebarChrome";
import type { ThreadHost } from "../../application/computers";
import type { ComputerFilter, ComputerLink } from "../../domain/computers";
import { PROJECT_DRAG, RECENTS_DROPPABLE, SidebarProjects, useShownThreads } from "./SidebarProjects";
import { useThreadRows } from "./SidebarThreadRow";
import type { SnoozeHours } from "../../domain/thread-snooze";
import type { ThreadRole } from "../../domain/thread-role";

export type ProjectSidebarProps = {
  open: boolean;
  inactive: boolean;
  projects: Project[];
  orderedThreads: Thread[];
  recentThreads: Thread[];
  currentId: string | null;
  draftProjectId: string | null;
  expandedProjects: Set<string>;
  runningThreadIds: Set<string>;
  /** Threads stopped on an approval only the user can answer. A subset of {@link runningThreadIds}. */
  blockedThreadIds: Set<string>;
  /** Threads holding a side chat with something unseen, which have no row of their own. */
  sideChatAttention: Set<string>;
  schedules: Map<string, AutomationView>;
  worktreeThreadIds: Set<string>;
  /** The checkouts each project has, with the threads in each. A project offers starting one more there. */
  worktreeGroups: WorktreeGroup[];
  /** The same threads ranked by what wants the user, which is what activity mode draws. */
  activityThreads: ActivitySections;
  /** Which paired computer holds each thread and folder that is not this computer's own. */
  threadHosts: Map<string, ThreadHost>;
  projectHosts: Map<string, ThreadHost>;
  computerLinks: ComputerLink[];
  computerName: string;
  computerFilter: ComputerFilter;
  onSetComputerFilter: (filter: ComputerFilter) => void;
  mode: SidebarMode;
  sections: SidebarSections;
  openMenu: string | null;
  settingsOpen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  /** A thread in the project, or in one of its checkouts when `worktreeId` names one. */
  onNewThread: (projectId?: string, worktreeId?: string) => void;
  onOpenFolder: () => void;
  onToggleProject: (projectId: string) => void;
  /** The name typed on the row itself. Blank gives the folder its own name back. */
  onRenameProject: (projectId: string, name: string) => void;
  onEditProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onSetMode: (mode: SidebarMode) => void;
  onSetSectionOpen: (section: SidebarSection, open: boolean) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string) => void;
  /** Takes the dot off one thread, and off every thread carrying one. */
  onDismissThread: (threadId: string) => void;
  onSnoozeThread: (threadId: string, hours: SnoozeHours) => void;
  onDismissAll: () => void;
  onRenameThread: (threadId: string, title: string) => void;
  onMoveThread: (threadId: string, target: ThreadDropTarget) => void;
  /** Copies the thread into a new one beside it, with a checkout of its own when `worktree`. */
  onForkThread: (threadId: string, worktree: boolean) => void;
  onSetThreadRole: (threadId: string, role: ThreadRole | null) => void;
  onMoveProject: (projectId: string, index: number) => void;
  onOpenSettings: () => void;
};

/**
 * How wide every rail is: the most marks any one thread carries. Reserving a slot no thread fills
 * only pushes the marks away from the titles. Every thread carries its engine mark, which also
 * covers the one slot an action needs.
 */
function railSlotsFor(threads: Thread[], marks: Pick<ProjectSidebarProps, "blockedThreadIds" | "runningThreadIds" | "sideChatAttention" | "worktreeThreadIds" | "schedules">) {
  return threads.reduce((widest, thread) => {
    const status = marks.blockedThreadIds.has(thread.id) || marks.runningThreadIds.has(thread.id) || hasUnreadAttention(thread) || marks.sideChatAttention.has(thread.id);
    return Math.max(widest, 1 + Number(Boolean(thread.role)) + Number(marks.worktreeThreadIds.has(thread.id)) + Number(marks.schedules.has(thread.id)) + Number(status));
  }, 1);
}

/** One context carries both drags; `type` says which list the drop belongs to. */
function dropHandler(onMoveProject: ProjectSidebarProps["onMoveProject"], onMoveThread: ProjectSidebarProps["onMoveThread"]) {
  return ({ draggableId, type, source, destination }: DropResult) => {
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    if (type === PROJECT_DRAG) return onMoveProject(draggableId, destination.index);
    onMoveThread(draggableId, {
      projectId: destination.droppableId === RECENTS_DROPPABLE ? null : destination.droppableId,
      index: destination.index,
    });
  };
}

function groupedBy<T>(items: T[], keyFor: (item: T) => string | undefined): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (key) grouped.get(key)?.push(item) ?? grouped.set(key, [item]);
  }
  return grouped;
}

export const ProjectSidebar = memo(function ProjectSidebar({
  open,
  inactive,
  projects,
  orderedThreads,
  recentThreads,
  currentId,
  draftProjectId,
  expandedProjects,
  runningThreadIds,
  blockedThreadIds,
  sideChatAttention,
  schedules,
  worktreeThreadIds,
  worktreeGroups,
  activityThreads,
  threadHosts,
  projectHosts,
  computerLinks,
  computerName,
  computerFilter,
  onSetComputerFilter,
  mode,
  sections,
  openMenu,
  settingsOpen,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onNewThread,
  onOpenFolder,
  onToggleProject,
  onRenameProject,
  onEditProject,
  onRemoveProject,
  onSetMode,
  onSetSectionOpen,
  onSetOpenMenu,
  onSelectThread,
  onArchiveThread,
  onDismissThread,
  onSnoozeThread,
  onDismissAll,
  onRenameThread,
  onMoveThread,
  onForkThread,
  onSetThreadRole,
  onMoveProject,
  onOpenSettings,
}: ProjectSidebarProps) {
  const selectedComputer = computerLinks.find((link) => link.id === computerFilter);
  const list = useRef<HTMLElement>(null);
  const shownThreads = useShownThreads();
  let timeFormatter: Intl.DateTimeFormat | undefined;
  const formatTime = (value: number) => (timeFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })).format(value);

  const threadsByProject = useMemo(() => groupedBy(orderedThreads, (thread) => thread.projectId), [orderedThreads]);
  const checkoutsByProject = useMemo(() => groupedBy(worktreeGroups, (group) => group.worktree.projectId), [worktreeGroups]);

  const { threadRow, activityRow } = useThreadRows({
    projects,
    currentId,
    runningThreadIds,
    blockedThreadIds,
    sideChatAttention,
    schedules,
    worktreeThreadIds,
    worktreeGroups,
    threadHosts,
    openMenu,
    formatTime,
    onSetOpenMenu,
    onSelectThread,
    onArchiveThread,
    onDismissThread,
    onSnoozeThread,
    onRenameThread,
    onForkThread,
    onSetThreadRole,
  });

  const railSlots = railSlotsFor([...orderedThreads, ...recentThreads], { blockedThreadIds, runningThreadIds, sideChatAttention, worktreeThreadIds, schedules });

  /** Stepping through threads from the keyboard is blind unless the list follows the one now open. */
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(".task-row.active, .project-task-row.active")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  return (
    <DragDropContext onDragEnd={dropHandler(onMoveProject, onMoveThread)}>
    <aside
      ref={list}
      className={`sidebar ${open ? "compact-open" : "hidden"}`}
      inert={inactive || !open}
      style={{ "--row-slots": railSlots } as React.CSSProperties}
    >
      <SidebarHeader mode={mode} canGoBack={canGoBack} canGoForward={canGoForward} onSetMode={onSetMode} onGoBack={onGoBack} onGoForward={onGoForward} />
      {computerLinks.length > 0 && <ComputerSwitch links={computerLinks} name={computerName} filter={computerFilter} onSetFilter={onSetComputerFilter} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />}
      <button className="new-task-button" onClick={() => onNewThread()} aria-label="New task" data-tip="New task">
        {/** Two copies of one outline: the resting hairline, and the accent that draws over it on hover. */}
        <svg className="new-task-edge" aria-hidden="true" focusable="false">
          <rect className="new-task-edge-rest" pathLength={100} />
          <rect className="new-task-edge-draw" pathLength={100} />
        </svg>
        <Plus className="new-task-icon" size={17} />
      </button>

      <div className="sidebar-scroll">
        {projects.length === 0 && computerFilter !== "all" && <div className="sidebar-project-empty">
          {selectedComputer && selectedComputer.status !== "connected"
            ? <p role="alert">{selectedComputer.error ?? `${selectedComputer.name} is offline.`}</p>
            : <><p>{selectedComputer?.name ?? (computerName || "This computer")} has no projects yet</p><button type="button" onClick={onOpenFolder}>Add project</button></>}
        </div>}
        {mode === "activity" && <SidebarActivity
          activityThreads={activityThreads}
          sections={sections}
          blockedThreadIds={blockedThreadIds}
          onSetSectionOpen={onSetSectionOpen}
          onDismissAll={onDismissAll}
          renderRow={activityRow}
        />}

        {mode === "projects" && <SidebarProjects
          projects={projects}
          computerName={computerName}
          threadsByProject={threadsByProject}
          checkoutsByProject={checkoutsByProject}
          recentThreads={recentThreads}
          currentId={currentId}
          draftProjectId={draftProjectId}
          expandedProjects={expandedProjects}
          projectHosts={projectHosts}
          threadHosts={threadHosts}
          sections={sections}
          shownThreads={shownThreads}
          openMenu={openMenu}
          formatTime={formatTime}
          renderRow={threadRow}
          onSetSectionOpen={onSetSectionOpen}
          onSetOpenMenu={onSetOpenMenu}
          onNewThread={onNewThread}
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
});
