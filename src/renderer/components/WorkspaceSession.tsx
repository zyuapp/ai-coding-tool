import type { ReactNode } from "react";
import { MemberPullRequestList, SessionPanel } from "./SessionPanel";
import { MemberWorktreeList } from "./Coordination";
import { SessionLocationMenu } from "./SessionLocationMenu";
import { threadAsking } from "../../application/pull-request-view";
import { pullRequestSettled } from "../../domain/pull-request";
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

/** The session panel: the thread's own environment and the commands its rows dispatch, and a coordinator's checkouts and pull requests below. */
export function WorkspaceSession(props: WorkspaceSessionProps) {
  const { workspace } = props;
  return (
    <ThreadSession {...props}>
      {isCoordinator(workspace.currentThread) && <CoordinatorSections workspace={workspace} />}
    </ThreadSession>
  );
}

function CoordinatorSections({ workspace }: { workspace: Workspace }) {
  const { asking, settled, found } = workspace.memberPullRequests;
  usePullRequestReads(asking, settled, workspace.actions.readMemberPullRequests);
  return (
    <>
      {workspace.memberWorktrees.length > 0 && <MemberWorktreeList
        worktrees={workspace.memberWorktrees}
        onReveal={workspace.activeComputer ? undefined : workspace.actions.revealWorktree}
        onDelete={(root) => workspace.dispatch({ type: "worktree.confirm-delete", root })}
      />}
      {found.length > 0 && <MemberPullRequestList pullRequests={found} />}
    </>
  );
}

function ThreadSession({ workspace, onInspectSubagent, onOpenPanel, onOpenWorkflow, children }: WorkspaceSessionProps & { children?: ReactNode }) {
  /** Threads sharing a checkout share a workspace, so the pull request is read again per thread too. */
  usePullRequestReads(threadAsking(workspace.workspaceId, workspace.environment, workspace.currentThread?.id), pullRequestSettled(workspace.pullRequest), workspace.actions.readPullRequest);

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
    >
      {children}
    </SessionPanel>
  );
}
