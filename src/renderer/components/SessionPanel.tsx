import { LuAlarmClock as AlarmClock, LuChevronDown as ChevronDown, LuFileDiff as FileDiff, LuGitBranch as GitBranch, LuGitMerge as GitMerge, LuGitPullRequest as GitPullRequest, LuGitPullRequestClosed as GitPullRequestClosed, LuGitPullRequestDraft as GitPullRequestDraft } from "react-icons/lu";
import { useRef, type ReactNode } from "react";
import type { ChangedFilesResult } from "../../contracts/ipc";
import type { BackgroundProcess, Subagent, SubagentGroup, SubagentGroups } from "../../domain/run";
import type { PullRequestAnswer, PullRequestRef, PullRequestState } from "../../domain/pull-request";
import type { Workflow } from "../../domain/workflow";
import { BackgroundProcessSection } from "./BackgroundProcessList";
import { BranchMenu, useBranches } from "./BranchMenu";
import { useMessageLinks, WebLink } from "./MarkdownMessage";
import { useDismissibleLayer } from "../focus";
import { orderSubagents, SubagentRow } from "./SubagentList";

export type SessionPanelProps = {
  environment: ChangedFilesResult | null;
  hasProject: boolean;
  /** The checkout the thread works in, which is the one the branch menu reads and moves. */
  workspaceId?: string;
  /** The pull request the checkout's work belongs to, drawn only when there is one to draw. */
  pullRequest: PullRequestAnswer;
  /** Absent until a thread exists; a draft has nowhere to move yet. */
  locationRow?: ReactNode;
  openMenu: string | null;
  subagents: Subagent[];
  /** Which subagent groups are unfolded; this panel reads only its own list. */
  subagentGroups: SubagentGroups;
  backgroundProcesses: BackgroundProcess[];
  workflows: Workflow[];
  automationCount: number;
  onSelect: (id: string) => void;
  onOpenAgents: () => void;
  onOpenAutomations: () => void;
  /** Opens the review, or closes it when it is already the tab in front. */
  onToggleChanges: () => void;
  onOpenWorkflow: (id: string) => void;
  onStopProcess: (processId: string) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSetSubagentGroup: (group: SubagentGroup, open: boolean) => void;
  /** `create` names a branch the repository does not have yet, made at the checkout's HEAD first. */
  onCheckoutBranch: (branch: string, create: boolean) => void;
};

export const BRANCH_MENU = "session:branch";

/** The sidebar carries the few that want reading; the whole roster lives in the Subagents panel. */
const SIDEBAR_LIMIT = 6;

function environmentMessage(environment: ChangedFilesResult | null, hasProject: boolean, workspaceId: string | undefined) {
  if (!hasProject) return "Open a project to inspect Git";
  if (!workspaceId) return "Reopen the project to inspect Git";
  /** A checkout with no answer yet is one still being read; the rows fill in when it answers. */
  if (!environment) return "Reading Git…";
  if (environment.status === "error") return environment.message;
  if (environment.status === "unknown") return "Workspace is no longer registered";
  if (environment.status === "unavailable") return `Workspace is ${environment.reason}`;
  return null;
}

type BranchRowProps = Pick<SessionPanelProps, "workspaceId" | "openMenu" | "onSetOpenMenu" | "onCheckoutBranch"> & { branch: string | null };

/** The branch the checkout is on, and the list that moves it onto another. */
function BranchRow({ branch, workspaceId, openMenu, onSetOpenMenu, onCheckoutBranch }: BranchRowProps) {
  const open = openMenu === BRANCH_MENU;
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [row, menu], () => onSetOpenMenu(null), trigger);
  /** Branches are only worth reading while the list is up; the row itself says where Git already is. */
  const branches = useBranches(workspaceId, open);

  return (
    <div ref={row} className={`session-branch ${open ? "open" : ""}`.trimEnd()} data-popover-menu>
      <button
        ref={trigger}
        className="session-row session-row-action"
        type="button"
        aria-label="Branch"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!workspaceId}
        onClick={() => onSetOpenMenu(open ? null : BRANCH_MENU)}
      >
        <span className="session-row-icon"><GitBranch size={18} /></span>
        <span>Branch</span>
        <ChevronDown size={14} />
        <code title={branch ?? undefined}>{branch ?? "—"}</code>
      </button>
      {open && (
        <BranchMenu
          menuRef={menu}
          anchor={row.current}
          branches={branches}
          selected={branch}
          onPick={(name, create) => {
            onSetOpenMenu(null);
            onCheckoutBranch(name, create);
          }}
        />
      )}
    </div>
  );
}

/** Which icon says the state, so the row is not read by its colour alone. */
const PULL_REQUEST_ICONS: Record<PullRequestState, typeof GitPullRequest> = {
  draft: GitPullRequestDraft,
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

const GITHUB_CLI_URL = "https://cli.github.com";

/** Drawn only when there is a pull request: a row saying there is none would be worth less than the space. */
function PullRequestRow({ pullRequest }: { pullRequest: PullRequestRef }) {
  const links = useMessageLinks();
  const Icon = PULL_REQUEST_ICONS[pullRequest.state];

  return (
    <WebLink
      className="session-row session-row-action session-pull-request"
      href={pullRequest.url}
      title={`#${pullRequest.number} ${pullRequest.title}`}
      openInApp={links.openUrlInApp && (() => links.openUrlInApp!(pullRequest.url))}
    >
      <span className="session-row-icon" data-state={pullRequest.state}><Icon size={18} /></span>
      <span>Pull request</span>
      <code>#{pullRequest.number}</code>
    </WebLink>
  );
}

/**
 * Drawn when the checkout lives on GitHub but `gh` is not installed, so a row that never appears
 * reads as something to install rather than as a checkout with no pull request.
 */
function InstallGitHubCliRow() {
  const links = useMessageLinks();

  return (
    <WebLink
      className="session-row session-row-action session-pull-request"
      href={GITHUB_CLI_URL}
      title="Pull requests are read with the GitHub CLI, which is not installed"
      openInApp={links.openUrlInApp && (() => links.openUrlInApp!(GITHUB_CLI_URL))}
    >
      <span className="session-row-icon session-row-icon-quiet"><GitPullRequest size={18} /></span>
      <span>Install gh for pull requests</span>
    </WebLink>
  );
}

export function SessionPanel({ environment, hasProject, workspaceId, pullRequest, locationRow, openMenu, subagents, subagentGroups, backgroundProcesses, workflows, automationCount, onSelect, onOpenAgents, onOpenAutomations, onOpenWorkflow, onSetOpenMenu, onSetSubagentGroup, onCheckoutBranch, onStopProcess, onToggleChanges }: SessionPanelProps) {
  const available = environment?.status === "available" ? environment : null;
  const message = environmentMessage(environment, hasProject, workspaceId);
  const working = subagents.filter((subagent) => subagent.status === "working").length;
  const shown = orderSubagents(subagents).slice(0, SIDEBAR_LIMIT);

  return (
    <aside className="session-panel" aria-label="Session panel">
      <div className="session-card">
        <div className="session-environment">
          {locationRow}
          <button
            className="session-row session-row-action"
            type="button"
            aria-label="Review changes"
            disabled={!hasProject}
            onClick={onToggleChanges}
          >
            <span className="session-row-icon"><FileDiff size={18} /></span>
            <span>Changes</span>
            {available && (
              <span className="change-counts" title={available.baseline ? `Since ${available.baseline}` : "Uncommitted work"}>
                <strong>+{available.additions}</strong><em>−{available.deletions}</em>
              </span>
            )}
          </button>
          <BranchRow
            branch={available?.branch ?? null}
            {...(workspaceId ? { workspaceId } : {})}
            openMenu={openMenu}
            onSetOpenMenu={onSetOpenMenu}
            onCheckoutBranch={onCheckoutBranch}
          />
          {pullRequest.status === "found" && <PullRequestRow pullRequest={pullRequest.pullRequest} />}
          {pullRequest.status === "gh-missing" && <InstallGitHubCliRow />}
          {message && <p className="session-note">{message}</p>}
          <button className="session-row session-row-action" type="button" onClick={onOpenAutomations} aria-label="Open Automation panel">
            <span className="session-row-icon"><AlarmClock size={18} /></span>
            <span>Automations</span>
            <span className="session-count">{automationCount}</span>
          </button>
        </div>

            {subagents.length > 0 && (
              <div className="subagent-section">
                <div className="subagent-heading">
                  <button className="section-toggle" type="button" aria-expanded={subagentGroups.sidebar} onClick={() => onSetSubagentGroup("sidebar", !subagentGroups.sidebar)}>
                    <span>Subagents</span>
                    <span className="section-chevron" aria-hidden="true" />
                  </button>
                  {working > 0 && <span>{working} working</span>}
                </div>
                {subagentGroups.sidebar && (
                  <div className="subagent-list" aria-live="polite">
                    {shown.map((subagent) => <SubagentRow key={subagent.id} subagent={subagent} onSelect={onSelect} />)}
                    {subagents.length > shown.length && (
                      <button className="subagent-view-all" type="button" onClick={onOpenAgents}>View All</button>
                    )}
                  </div>
                )}
              </div>
            )}

            <BackgroundProcessSection processes={backgroundProcesses} workflows={workflows} onOpenWorkflow={onOpenWorkflow} onStop={onStopProcess} />
      </div>
    </aside>
  );
}
