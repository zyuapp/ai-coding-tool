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
      orderedTasks={workspace.orderedTasks}
      recentTasks={workspace.recentTasks}
      currentId={workspace.currentTask?.id ?? null}
      draftProjectId={workspace.currentProject?.id ?? null}
      expandedProjects={workspace.expandedProjects}
      runningTaskIds={workspace.runningTaskIds}
      blockedTaskIds={workspace.blockedTaskIds}
      sideChatAttention={workspace.sideChatAttention}
      schedules={workspace.schedules}
      worktreeTaskIds={workspace.worktreeTaskIds}
      worktreeGroups={workspace.worktreeGroups}
      activityTasks={workspace.activityTasks}
      mode={workspace.sidebarMode}
      sections={workspace.sections}
      openMenu={workspace.openMenu}
      settingsOpen={settingsVisible}
      canGoBack={workspace.canGoBack}
      canGoForward={workspace.canGoForward}
      onGoBack={() => void workspace.actions.goBack()}
      onGoForward={() => void workspace.actions.goForward()}
      onNewTask={workspace.actions.newTask}
      onOpenFolder={workspace.actions.openFolder}
      onToggleProject={workspace.actions.toggleProject}
      onRenameProject={(projectId, name) => void workspace.actions.editProject(projectId, { name })}
      onEditProject={workspace.actions.editProjectOpen}
      onRemoveProject={workspace.actions.removeProject}
      onMoveProject={workspace.actions.moveProject}
      onSetMode={workspace.actions.setSidebarMode}
      onSetSectionOpen={workspace.actions.setSectionOpen}
      onSetOpenMenu={workspace.actions.setOpenMenu}
      onSelectTask={workspace.actions.selectTask}
      onArchiveTask={workspace.actions.archiveTask}
      onDismissTask={workspace.actions.dismissTask}
      onDismissAll={workspace.actions.dismissAllTasks}
      onRenameTask={workspace.actions.renameTask}
      onMoveTask={workspace.actions.moveTask}
      onForkTask={workspace.actions.forkTask}
      onOpenSettings={onOpenSettings}
    />
  );
}
