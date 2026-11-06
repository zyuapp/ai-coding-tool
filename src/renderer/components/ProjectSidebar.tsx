import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { LuPlus as Plus, LuSearch as Search, LuSquarePen as SquarePen } from "react-icons/lu";
import type { Project, ThreadDropTarget } from "../../domain/project";
import { hasUnreadAttention } from "../../domain/attention";
import { isAgentEngine } from "../../domain/agent-engine";
import type { Thread } from "../../domain/thread";
import type { SidebarSection, SidebarSections } from "../../domain/sidebar";
import type { ActivitySections } from "../../application/thread-order";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { SidebarActivity } from "./SidebarActivity";
import { SidebarHeader, SidebarResizer } from "./SidebarChrome";
import type { ThreadHost } from "../../application/computers";
import { offlineMessage, type ComputerFilter, type ComputerLink } from "../../domain/computers";
import { useThreadRows, type SidebarCoordination } from "./SidebarThreadRow";
import type { SnoozeHours } from "../../domain/thread-snooze";
import type { ThreadRole } from "../../domain/thread-role";
import type { AppUpdate } from "../../domain/app-update";
import { SidebarFooter } from "./SidebarFooter";
import { shortcutTip } from "./TooltipLayer";
import { CommandButton } from "./CommandControl";
import { roleIcon } from "./ThreadRoleMark";

const NEW_THREAD_TIP = shortcutTip("New thread", "Mod+N");
const SEARCH_TIP = shortcutTip("Search", "Mod+K");

export type ProjectSidebarProps = {
  open: boolean;
  inactive: boolean;
  projects: Project[];
  currentId: string | null;
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
  /** The checkouts each project has, with the threads in each. */
  worktreeGroups: WorktreeGroup[];
  /** The threads ranked by what wants the user, which is what the sidebar draws. */
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
  sections: SidebarSections;
  openMenu: string | null;
  settingsOpen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  onNewThread: () => void;
  onOpenFolder: () => void;
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

/** The threads the sidebar draws a row for: those in the lists left open. */
function drawnThreads(sections: SidebarSections, activityThreads: ActivitySections): Thread[] {
  return (["priority", "running", "threads", "snoozed"] as const).flatMap((key) => sections[key] ? activityThreads[key] : []);
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
      </CommandButton>
    </div>
  );
}

export const ProjectSidebar = memo(function ProjectSidebar({
  open,
  inactive,
  projects,
  currentId,
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
  sections,
  openMenu,
  settingsOpen,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onNewThread,
  onOpenFolder,
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
  onOpenSettings,
  appUpdate,
  onDownloadUpdate,
  onInstallUpdate,
}: ProjectSidebarProps) {
  const selectedComputer = computerLinks.find((link) => link.id === computerFilter);
  const list = useRef<HTMLElement>(null);
  const activityRow = useThreadRows({
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
    () => railSlotsFor(drawnThreads(sections, activityThreads), { blockedThreadIds, runningThreadIds, monitoringThreadIds, sideChatAttention, worktreeThreadIds, schedules, threadHosts }, sidebarCoordination),
    [sections, activityThreads, blockedThreadIds, runningThreadIds, monitoringThreadIds, sideChatAttention, worktreeThreadIds, schedules, threadHosts, sidebarCoordination],
  );

  /** Stepping through threads from the keyboard is blind unless the list follows the one now open. */
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(".task-row.active")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  return (
    <aside
      ref={list}
      className={`sidebar ${open ? "compact-open" : "hidden"}`}
      inert={inactive || !open}
      style={{ "--row-slots": railSlots } as React.CSSProperties}
    >
      <SidebarHeader canGoBack={canGoBack} canGoForward={canGoForward} onGoBack={onGoBack} onGoForward={onGoForward} computerLinks={computerLinks} computerName={computerName} computerFilter={computerFilter} onSetComputerFilter={onSetComputerFilter} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />
      <NewThreadBar onNewThread={onNewThread} />

      <div className="sidebar-scroll">
        {projects.length === 0 && <div className="sidebar-project-empty">
          {selectedComputer && selectedComputer.status !== "connected"
            ? <><p role="alert">{offlineMessage(selectedComputer)}</p><button type="button" className="sidebar-empty-action" onClick={() => onSetComputerFilter("all")}>Show all computers</button></>
            : <><p>{computerFilter === "all" ? "No projects yet" : `${selectedComputer?.name ?? (computerName || "This computer")} has no projects yet`}</p><button type="button" className="sidebar-empty-action" onClick={onOpenFolder}><Plus size={14} aria-hidden="true" />Add project</button></>}
        </div>}
        <SidebarActivity
          activityThreads={activityThreads}
          sections={sections}
          blockedThreadIds={blockedThreadIds}
          threadsByCoordinator={sidebarCoordination.threadsByCoordinator}
          onSetSectionOpen={onSetSectionOpen}
          onDismissAll={() => onDismissAll(activityProject)}
          renderRow={activityRow}
          projectFilter={{ projects, projectHosts, project: activityProject, onSetProject: onSetActivityProject, openMenu, onSetOpenMenu }}
        />
      </div>
      <SidebarFooter settingsOpen={settingsOpen} onOpenSettings={onOpenSettings} update={appUpdate} onDownloadUpdate={onDownloadUpdate} onInstallUpdate={onInstallUpdate} />
      <SidebarResizer />
    </aside>
  );
});
