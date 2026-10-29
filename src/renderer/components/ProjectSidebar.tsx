import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { LuPlus as Plus, LuSearch as Search, LuSquarePen as SquarePen } from "react-icons/lu";
import type { Project, ThreadDropTarget } from "../../domain/project";
import { hasUnreadAttention } from "../../domain/attention";
import { isAgentEngine } from "../../domain/agent-engine";
import type { Thread } from "../../domain/thread";
import type { SidebarMode, SidebarSection, SidebarSections } from "../../domain/sidebar";
import type { ActivitySections } from "../../application/thread-order";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { SidebarActivity } from "./SidebarActivity";
import { SidebarHeader, SidebarResizer } from "./SidebarChrome";
import type { ThreadHost } from "../../application/computers";
import { offlineMessage, type ComputerFilter, type ComputerLink } from "../../domain/computers";
import { PROJECT_DRAG, RECENTS_DROPPABLE, SidebarProjects, useShownThreads } from "./SidebarProjects";
import { useThreadRows, type SidebarCoordination } from "./SidebarThreadRow";
import type { SnoozeHours } from "../../domain/thread-snooze";
import type { ThreadRole } from "../../domain/thread-role";
import type { AppUpdate } from "../../domain/app-update";
import { SidebarFooter } from "./SidebarFooter";
import { shortcutTip } from "./TooltipLayer";
import { displayShortcut } from "../../domain/shortcuts";
import { MAC } from "../platform";
import { CommandButton } from "./CommandControl";
import { roleIcon } from "./ThreadRoleMark";

const NEW_THREAD_TIP = shortcutTip("New thread", "Mod+N");
const SEARCH_TIP = shortcutTip("Search", "Mod+K");
const SEARCH_KEYS = displayShortcut("Mod+K", MAC);

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
  /** Threads not running whose background shell or monitor will wake them. */
  monitoringThreadIds: Set<string>;
  /** Threads stopped on an approval only the user can answer. A subset of {@link runningThreadIds}. */
  blockedThreadIds: Set<string>;
  /** Threads holding a side chat with something unseen, which have no row of their own. */
  sideChatAttention: Set<string>;
  schedules: Map<string, AutomationView>;
  /** Each thread waiting out its usage limit, by its place in line. */
  limitPositions: Map<string, number>;
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
  /** The one project the activity lists are narrowed to, or null for every project. */
  activityProject: string | null;
  onSetActivityProject: (projectId: string | null) => void;
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
  onUnsnoozeThread: (threadId: string) => void;
  /** Takes the dot off every thread in Priority, or only off those in `projectId`. */
  onDismissAll: (projectId: string | null) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onMoveThread: (threadId: string, target: ThreadDropTarget) => void;
  /** Copies the thread into a new one beside it, with a checkout of its own when `worktree`. */
  onForkThread: (threadId: string, worktree: boolean) => void;
  onSetThreadRole: (threadId: string, role: ThreadRole | null) => void;
  sidebarCoordination: SidebarCoordination;
  onMoveProject: (projectId: string, index: number) => void;
  onOpenSettings: () => void;
  appUpdate: AppUpdate;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
};

/**
 * How wide every rail is at rest: the most marks any one drawn thread carries, counted as the row
 * draws them. Reserving a slot no row on screen fills, for a thread in a folded list, only pushes
 * the marks away from the titles. A rail keeps at least one slot for its actions to land on.
 */
function railSlotsFor(threads: Thread[], marks: Pick<ProjectSidebarProps, "blockedThreadIds" | "runningThreadIds" | "monitoringThreadIds" | "sideChatAttention" | "worktreeThreadIds" | "schedules" | "threadHosts">, { threadsByCoordinator, waitingLines }: SidebarCoordination) {
  return threads.reduce((widest, thread) => {
    const members = threadsByCoordinator.get(thread.id) ?? [];
    const coordinationStatus = waitingLines.has(thread.id) || members.some((member) => marks.blockedThreadIds.has(member.id) || marks.runningThreadIds.has(member.id) || hasUnreadAttention(member));
    const status = marks.blockedThreadIds.has(thread.id) || marks.runningThreadIds.has(thread.id) || marks.monitoringThreadIds.has(thread.id) || Boolean(thread.limitPause) || hasUnreadAttention(thread) || marks.sideChatAttention.has(thread.id) || coordinationStatus;
    const drawn = [
      marks.threadHosts.get(thread.id)?.offline === true,
      Boolean(thread.role && roleIcon(thread.role)),
      marks.worktreeThreadIds.has(thread.id),
      marks.schedules.has(thread.id),
      status,
      isAgentEngine(thread.engine),
    ];
    return Math.max(widest, drawn.filter(Boolean).length);
  }, 1);
}

/** The threads the sidebar draws a row for in its mode: those in the lists and folders left open. */
function drawnThreads(mode: SidebarMode, sections: SidebarSections, activityThreads: ActivitySections, threadsByProject: Map<string, Thread[]>, expandedProjects: Set<string>, recentThreads: Thread[]): Thread[] {
  if (mode === "activity") return (["priority", "running", "threads", "snoozed"] as const).flatMap((key) => sections[key] ? activityThreads[key] : []);
  return [
    ...(sections.projects ? [...expandedProjects].flatMap((projectId) => threadsByProject.get(projectId) ?? []) : []),
    ...(sections.recents ? recentThreads : []),
  ];
}

/** One context carries both drags; `type` says which list the drop belongs to. */
function dropHandler(onMoveProject: ProjectSidebarProps["onMoveProject"], onMoveThread: ProjectSidebarProps["onMoveThread"]) {
  return ({ draggableId, type, source, destination }: DropResult) => {
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    if (type.startsWith(`${PROJECT_DRAG}:`)) {
      if (destination.droppableId === source.droppableId) onMoveProject(draggableId, destination.index);
      return;
    }
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

/** Each folder's threads, short of those drawn beneath a coordinator instead, and each folder's checkouts. */
function useProjectGroups(orderedThreads: Thread[], worktreeGroups: WorktreeGroup[], threadsByCoordinator: Map<string, Thread[]>) {
  const threadsByProject = useMemo(() => {
    const members = new Set([...threadsByCoordinator.values()].flat().map((thread) => thread.id));
    return groupedBy(members.size ? orderedThreads.filter((thread) => !members.has(thread.id)) : orderedThreads, (thread) => thread.projectId);
  }, [orderedThreads, threadsByCoordinator]);
  const checkoutsByProject = useMemo(() => groupedBy(worktreeGroups, (group) => group.worktree.projectId), [worktreeGroups]);
  return { threadsByProject, checkoutsByProject };
}

function NewThreadBar({ onNewThread }: { onNewThread: () => void }) {
  return (
    <div className="new-task-bar">
      <button className="new-task-button" type="button" onClick={() => onNewThread()} data-tip={NEW_THREAD_TIP}>
        <SquarePen size={14} aria-hidden="true" />
        <span className="new-task-label">New thread</span>
      </button>
      <CommandButton command={{ type: "view.jump-open" }} className="sidebar-search" type="button" aria-label="Search threads and settings" data-tip={SEARCH_TIP}>
        <Search size={14} aria-hidden="true" />
        <kbd aria-hidden="true">{SEARCH_KEYS}</kbd>
      </CommandButton>
    </div>
  );
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
  monitoringThreadIds,
  blockedThreadIds,
  sideChatAttention,
  schedules, limitPositions,
  worktreeThreadIds,
  worktreeGroups,
  activityThreads,
  threadHosts,
  projectHosts,
  computerLinks, computerName,
  computerFilter, onSetComputerFilter,
  activityProject, onSetActivityProject,
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
  onSnoozeThread, onUnsnoozeThread,
  onDismissAll,
  onRenameThread,
  onMoveThread,
  onForkThread,
  onSetThreadRole,
  sidebarCoordination,
  onMoveProject,
  onOpenSettings,
  appUpdate,
  onDownloadUpdate,
  onInstallUpdate,
}: ProjectSidebarProps) {
  const selectedComputer = computerLinks.find((link) => link.id === computerFilter);
  const list = useRef<HTMLElement>(null);
  const shownThreads = useShownThreads();

  const { threadsByProject, checkoutsByProject } = useProjectGroups(orderedThreads, worktreeGroups, sidebarCoordination.threadsByCoordinator);

  const { threadRow, activityRow } = useThreadRows({
    projects,
    currentId,
    runningThreadIds,
    monitoringThreadIds,
    blockedThreadIds,
    sideChatAttention,
    schedules, limitPositions,
    worktreeThreadIds,
    worktreeGroups,
    threadHosts, projectHosts,
    openMenu,
    onSetOpenMenu,
    onSelectThread,
    onArchiveThread,
    onDismissThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onRenameThread, onMoveThread,
    onForkThread,
    onSetThreadRole,
    sidebarCoordination,
  });

  const railSlots = useMemo(
    () => railSlotsFor(drawnThreads(mode, sections, activityThreads, threadsByProject, expandedProjects, recentThreads), { blockedThreadIds, runningThreadIds, monitoringThreadIds, sideChatAttention, worktreeThreadIds, schedules, threadHosts }, sidebarCoordination),
    [mode, sections, activityThreads, threadsByProject, expandedProjects, recentThreads, blockedThreadIds, runningThreadIds, monitoringThreadIds, sideChatAttention, worktreeThreadIds, schedules, threadHosts, sidebarCoordination],
  );

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
      <SidebarHeader mode={mode} canGoBack={canGoBack} canGoForward={canGoForward} onSetMode={onSetMode} onGoBack={onGoBack} onGoForward={onGoForward} computerLinks={computerLinks} computerName={computerName} computerFilter={computerFilter} onSetComputerFilter={onSetComputerFilter} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />
      <NewThreadBar onNewThread={onNewThread} />

      <div className="sidebar-scroll">
        {projects.length === 0 && <div className="sidebar-project-empty">
          {selectedComputer && selectedComputer.status !== "connected"
            ? <><p role="alert">{offlineMessage(selectedComputer)}</p><button type="button" className="sidebar-empty-action" onClick={() => onSetComputerFilter("all")}>Show all computers</button></>
            : <><p>{computerFilter === "all" ? "No projects yet" : `${selectedComputer?.name ?? (computerName || "This computer")} has no projects yet`}</p><button type="button" className="sidebar-empty-action" onClick={onOpenFolder}><Plus size={14} aria-hidden="true" />Add project</button></>}
        </div>}
        {mode === "activity" && <SidebarActivity
          activityThreads={activityThreads}
          sections={sections}
          blockedThreadIds={blockedThreadIds}
          threadsByCoordinator={sidebarCoordination.threadsByCoordinator}
          onSetSectionOpen={onSetSectionOpen}
          onDismissAll={() => onDismissAll(activityProject)}
          renderRow={activityRow}
          projectFilter={{ projects, projectHosts, project: activityProject, onSetProject: onSetActivityProject, openMenu, onSetOpenMenu }}
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
          sections={sections}
          shownThreads={shownThreads}
          openMenu={openMenu}
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
      <SidebarFooter settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} update={appUpdate} onDownloadUpdate={onDownloadUpdate} onInstallUpdate={onInstallUpdate} />
      <SidebarResizer />
    </aside>
    </DragDropContext>
  );
});
