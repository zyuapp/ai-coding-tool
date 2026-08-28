import { SessionPanel } from "./SessionPanel";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The session panel with the thread's environment and the commands its rows dispatch. */
export function WorkspaceSession({ workspace, onInspectSubagent, onOpenPanel, onOpenWorkflow }: {
  workspace: Workspace;
  onInspectSubagent: (id: string) => void;
  onOpenPanel: (id: string) => void;
  onOpenWorkflow: (id: string) => void;
}) {
  return (
    <SessionPanel
      environment={workspace.environment}
      hasProject={Boolean(workspace.folder)}
      {...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {})}
      {...(workspace.currentTask ? { taskId: workspace.currentTask.id, location: workspace.location } : {})}
      runActive={workspace.runActive}
      openMenu={workspace.openMenu}
      onSetOpenMenu={workspace.actions.setOpenMenu}
      subagents={workspace.subagents}
      subagentGroups={workspace.subagentGroups}
      onSetSubagentGroup={(group, open) => void workspace.actions.setSubagentGroup(group, open)}
      backgroundProcesses={workspace.backgroundProcesses}
      workflows={workspace.workflows}
      automationCount={workspace.automation ? 1 : 0}
      onSelect={(id) => {
        onInspectSubagent(id);
        onOpenPanel("agents");
      }}
      onToggleChanges={workspace.actions.toggleDiff}
      onOpenAgents={() => onOpenPanel("agents")}
      onOpenAutomations={() => onOpenPanel("automation")}
      onOpenWorkflow={onOpenWorkflow}
      onStopProcess={workspace.actions.stopBackgroundProcess}
      onCheckoutBranch={(branch, create) => void workspace.actions.checkoutBranch(branch, create)}
      onNewThread={() => {
        const task = workspace.currentTask;
        if (task) void workspace.actions.newTask(task.projectId, task.worktreeId);
      }}
      onSetWorktree={(worktree) => {
        /** Only work that would otherwise be lost is worth stopping for; a clean worktree just goes. */
        const holding = workspace.environment?.status === "available" ? workspace.environment.files.length : 0;
        const question = worktree
          ? "Give this thread a worktree? It moves into a checkout of its own and works there from now on."
          : holding
            ? `Return this thread to your project checkout? Its ${holding} uncommitted ${holding === 1 ? "change is" : "changes are"} committed first so nothing is lost, then the worktree is removed.`
            : null;
        if (question === null || window.confirm(question)) void workspace.actions.setWorktree(worktree);
      }}
    />
  );
}
