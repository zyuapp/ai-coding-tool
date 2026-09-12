import { SessionPanel } from "./SessionPanel";
import { SessionLocationMenu } from "./SessionLocationMenu";
import { branchOf } from "../../application/pull-request-view";
import { usePullRequestReads } from "../task-workspace/pull-request-reads";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The session panel with the thread's environment and the commands its rows dispatch. */
export function WorkspaceSession({ workspace, onInspectSubagent, onOpenPanel, onOpenWorkflow }: {
  workspace: Workspace;
  onInspectSubagent: (id: string) => void;
  onOpenPanel: (id: string) => void;
  onOpenWorkflow: (id: string) => void;
}) {
  /** Threads sharing a checkout share a workspace, so the pull request is read again per thread too. */
  usePullRequestReads(workspace.workspaceId, branchOf(workspace.environment), workspace.currentThread?.id, workspace.pullRequest, workspace.actions.readPullRequest);

  return (
    <SessionPanel
      environment={workspace.environment}
      hasProject={Boolean(workspace.folder)}
      {...(workspace.workspaceId ? { workspaceId: workspace.workspaceId } : {})}
      pullRequest={workspace.pullRequest}
      locationRow={workspace.worktreeMenu && <SessionLocationMenu view={workspace.worktreeMenu} openMenu={workspace.openMenu} dispatch={workspace.dispatch} />}
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
    />
  );
}
