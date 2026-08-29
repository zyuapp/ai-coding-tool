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
      {...(workspace.currentThread ? { threadId: workspace.currentThread.id, location: workspace.location } : {})}
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
        const thread = workspace.currentThread;
        if (thread) void workspace.actions.newThread(thread.projectId, thread.worktreeId);
      }}
      onSetWorktree={workspace.actions.moveWorktree}
    />
  );
}
