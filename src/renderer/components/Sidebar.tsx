import { ProjectSidebar } from "./ProjectSidebar";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

/** Everything the sidebar draws and every command its rows dispatch, kept out of the app shell. */
export function Sidebar({ workspace, open, settingsVisible, onOpenSettings }: {
  workspace: ReturnType<typeof useTaskWorkspace>;
  open: boolean;
  settingsVisible: boolean;
  onOpenSettings: () => void;
}) {
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
      threadSlots={workspace.threadSlots}
      mode={workspace.sidebarMode}
      sections={workspace.sections}
      openMenu={workspace.openMenu}
      settingsOpen={settingsVisible}
      canGoBack={workspace.canGoBack}
      canGoForward={workspace.canGoForward}
      onGoBack={() => void workspace.actions.goBack()}
      onGoForward={() => void workspace.actions.goForward()}
      onNewThread={workspace.actions.newThread}
      onOpenFolder={workspace.actions.openFolder}
      onToggleProject={workspace.actions.toggleProject}
      onRenameProject={(projectId, name) => void workspace.actions.editProject(projectId, { name })}
      onEditProject={workspace.actions.editProjectOpen}
      onRemoveProject={workspace.actions.removeProject}
      onMoveProject={workspace.actions.moveProject}
      onSetMode={workspace.actions.setSidebarMode}
      onSetSectionOpen={workspace.actions.setSectionOpen}
      onSetOpenMenu={workspace.actions.setOpenMenu}
      onSelectThread={workspace.actions.selectThread}
      onArchiveThread={workspace.actions.archiveThread}
      onDismissThread={workspace.actions.dismissThread}
      onDismissAll={workspace.actions.dismissAllThreads}
      onRenameThread={workspace.actions.renameThread}
      onMoveThread={workspace.actions.moveThread}
      onForkThread={workspace.actions.forkThread}
      onOpenSettings={onOpenSettings}
    />
  );
}
