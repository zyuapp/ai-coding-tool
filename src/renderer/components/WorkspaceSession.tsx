import { CoordinatorPanel, SessionPanel } from "./SessionPanel";
import { SessionLocationMenu } from "./SessionLocationMenu";
import { branchOf } from "../../application/pull-request-view";
import { isCoordinator } from "../../domain/coordination";
import { usePullRequestReads } from "../task-workspace/pull-request-reads";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

type Workspace = ReturnType<typeof useTaskWorkspace>;

type WorkspaceSessionProps = {
  workspace: Workspace;
  onInspectSubagent: (id: string) => void;
  onOpenPanel: (id: string) => void;
  onOpenWorkflow: (id: string) => void;
};

/** The session panel: a coordinator's threads, or the thread's own environment and the commands its rows dispatch. */
export function WorkspaceSession(props: WorkspaceSessionProps) {
  const { workspace } = props;
  if (isCoordinator(workspace.currentThread)) {
    return <CoordinatorPanel members={workspace.coordination.members} onOpenThread={workspace.actions.selectThread} />;
  }
  return <ThreadSession {...props} />;
}

function ThreadSession({ workspace, onInspectSubagent, onOpenPanel, onOpenWorkflow }: WorkspaceSessionProps) {
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
      onToggleChanges={() => void workspace.actions.toggleDiff()}
      onOpenAgents={() => onOpenPanel("agents")}
      onOpenAutomations={() => onOpenPanel("automation")}
      onOpenWorkflow={onOpenWorkflow}
      onStopProcess={workspace.actions.stopBackgroundProcess}
      onCheckoutBranch={(branch, create) => void workspace.actions.checkoutBranch(branch, create)}
    />
  );
}
