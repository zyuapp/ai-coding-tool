import { useMemo } from "react";
import { useFloatingSidebar } from "../floating-sidebar";
import { ProjectSidebar } from "./ProjectSidebar";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

/** Everything the sidebar draws and every command its rows dispatch, kept out of the app shell. */
export function Sidebar({ workspace, open, settingsVisible, onOpenSettings }: {
  workspace: ReturnType<typeof useTaskWorkspace>;
  open: boolean;
  settingsVisible: boolean;
  onOpenSettings: () => void;
}) {
  const { threadsByCoordinator, waitingLines, coordinatorsByComputer, notifications, stoppableCoordinatorIds: stoppable, actions } = workspace;
  const sidebarCoordination = useMemo(() => ({ threadsByCoordinator, waitingLines, coordinatorsByComputer, onSetCoordinator: actions.setCoordinator, notifications, onSetMuted: actions.setMuted, stoppable, onStopAll: actions.stopAll }), [threadsByCoordinator, waitingLines, coordinatorsByComputer, notifications, stoppable, actions]);
  useFloatingSidebar(open, actions.setSidebarOpen, workspace.dockOpen && !workspace.dockExpanded && !workspace.zen);

  return (
    <ProjectSidebar
      open={open}
      inactive={settingsVisible}
      projects={workspace.projects}
      currentId={workspace.currentThread?.id ?? null}
      runningThreadIds={workspace.runningThreadIds}
      monitoringThreadIds={workspace.monitoringThreadIds}
      blockedThreadIds={workspace.blockedThreadIds}
      sideChatAttention={workspace.sideChatAttention}
      schedules={workspace.schedules}
      limitPositions={workspace.limitPositions}
      worktreeThreadIds={workspace.worktreeThreadIds}
      worktreeGroups={workspace.worktreeGroups}
      activityThreads={workspace.activityThreads}
      threadHosts={workspace.threadHosts}
      projectHosts={workspace.projectHosts}
      computerLinks={workspace.computerLinks}
      computerName={workspace.computerName}
      computerFilter={workspace.computerFilter}
      onSetComputerFilter={workspace.actions.setComputerFilter}
      activityProject={workspace.activityProject}
      onSetActivityProject={workspace.actions.setActivityProject}
      sections={workspace.sections}
      openMenu={workspace.openMenu}
      settingsOpen={settingsVisible}
      canGoBack={workspace.canGoBack}
      canGoForward={workspace.canGoForward}
      onGoBack={workspace.actions.goBack}
      onGoForward={workspace.actions.goForward}
      onNewThread={workspace.actions.newThread}
      onOpenFolder={workspace.actions.openFolder}
      onSetSectionOpen={workspace.actions.setSectionOpen}
      onSetOpenMenu={workspace.actions.setOpenMenu}
      onSelectThread={workspace.actions.selectThread}
      onArchiveThread={workspace.actions.archiveThread}
      onDismissThread={workspace.actions.dismissThread}
      onSnoozeThread={workspace.actions.snoozeThread}
      onUnsnoozeThread={workspace.actions.unsnoozeThread}
      onDismissAll={workspace.actions.dismissAllThreads}
      onRenameThread={workspace.actions.renameThread}
      onMoveThread={workspace.actions.moveThread}
      onForkThread={workspace.actions.forkThread}
      onSetThreadRole={workspace.actions.setThreadRole}
      sidebarCoordination={sidebarCoordination}
      onOpenSettings={onOpenSettings}
      appUpdate={workspace.appUpdate}
      onDownloadUpdate={workspace.actions.downloadUpdate}
      onInstallUpdate={workspace.actions.installUpdate}
    />
  );
}
