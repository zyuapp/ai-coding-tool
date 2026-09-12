import { useCallback } from "react";
import { ProjectSidebar } from "./ProjectSidebar";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

/** Everything the sidebar draws and every command its rows dispatch, kept out of the app shell. */
export function Sidebar({ workspace, open, settingsVisible, onOpenSettings }: {
  workspace: ReturnType<typeof useTaskWorkspace>;
  open: boolean;
  settingsVisible: boolean;
  onOpenSettings: () => void;
}) {
  const renameProject = useCallback((projectId: string, name: string) => {
    void workspace.actions.editProject(projectId, { name });
  }, [workspace.actions]);

  return (
    <ProjectSidebar
      open={open}
      inactive={settingsVisible}
      projects={workspace.projects}
      orderedThreads={workspace.orderedThreads}
      recentThreads={workspace.recentThreads}
      currentId={workspace.currentThread?.id ?? null}
      draftProjectId={workspace.currentProject?.id ?? null}
      expandedProjects={workspace.expandedProjects}
      runningThreadIds={workspace.runningThreadIds}
      blockedThreadIds={workspace.blockedThreadIds}
      sideChatAttention={workspace.sideChatAttention}
      schedules={workspace.schedules}
      worktreeThreadIds={workspace.worktreeThreadIds}
      worktreeGroups={workspace.worktreeGroups}
      activityThreads={workspace.activityThreads}
      threadHosts={workspace.threadHosts}
      projectHosts={workspace.projectHosts}
      computerLinks={workspace.computerLinks}
      computerName={workspace.computerName}
      computerFilter={workspace.computerFilter}
      onSetComputerFilter={workspace.actions.setComputerFilter}
      mode={workspace.sidebarMode}
      sections={workspace.sections}
      openMenu={workspace.openMenu}
      settingsOpen={settingsVisible}
      canGoBack={workspace.canGoBack}
      canGoForward={workspace.canGoForward}
      onGoBack={workspace.actions.goBack}
      onGoForward={workspace.actions.goForward}
      onNewThread={workspace.actions.newThread}
      onOpenFolder={workspace.actions.openFolder}
      onToggleProject={workspace.actions.toggleProject}
      onRenameProject={renameProject}
      onEditProject={workspace.actions.editProjectOpen}
      onRemoveProject={workspace.actions.removeProject}
      onMoveProject={workspace.actions.moveProject}
      onSetMode={workspace.actions.setSidebarMode}
      onSetSectionOpen={workspace.actions.setSectionOpen}
      onSetOpenMenu={workspace.actions.setOpenMenu}
      onSelectThread={workspace.actions.selectThread}
      onArchiveThread={workspace.actions.archiveThread}
      onDismissThread={workspace.actions.dismissThread}
      onSnoozeThread={workspace.actions.snoozeThread}
      onDismissAll={workspace.actions.dismissAllThreads}
      onRenameThread={workspace.actions.renameThread}
      onMoveThread={workspace.actions.moveThread}
      onForkThread={workspace.actions.forkThread}
      onSetThreadRole={workspace.actions.setThreadRole}
      onOpenSettings={onOpenSettings}
    />
  );
}
