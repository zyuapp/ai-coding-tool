import { AlarmClock, ChevronDown, FileDiff, FolderSymlink, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, House } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangedFilesResult } from "../../contracts/ipc";
import type { ThreadLocation } from "../../application/workspace-state";
import type { BackgroundProcess, Subagent } from "../../domain/run";
import type { PullRequestRef, PullRequestState } from "../../domain/pull-request";
import type { Workflow } from "../../domain/workflow";
import { BackgroundProcessSection } from "./BackgroundProcessList";
import { BranchMenu, useBranches } from "./BranchMenu";
import { useMessageLinks, WebLink } from "./MarkdownMessage";
import { PopoverMenu } from "./PopoverMenu";
import { useDismissibleLayer } from "../focus";
import { orderSubagents, SubagentRow } from "./SubagentList";

export type SessionPanelProps = {
  environment: ChangedFilesResult | null;
  hasProject: boolean;
  /** The checkout the thread works in, which is the one the branch menu reads and moves. */
  workspaceId?: string;
  /** Threads sharing a checkout share a workspace, so the pull request is read again per thread too. */
  taskId?: string;
  /** Absent until a thread exists; a draft has nowhere to move yet. */
  location?: ThreadLocation;
  runActive: boolean;
  openMenu: string | null;
  subagents: Subagent[];
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
  onSetWorktree: (worktree: boolean) => void;
  /** `create` names a branch the repository does not have yet, made at the checkout's HEAD first. */
  onCheckoutBranch: (branch: string, create: boolean) => void;
};

export const LOCATION_MENU = "session:location";
export const BRANCH_MENU = "session:branch";

/** The sidebar carries the few that want reading; the whole roster lives in the Subagents panel. */
const SIDEBAR_LIMIT = 6;

function environmentMessage(environment: ChangedFilesResult | null, hasProject: boolean) {
  if (!hasProject) return "Open a project to inspect Git";
  if (!environment) return "Reopen the project to inspect Git";
  if (environment.status === "error") return environment.message;
  if (environment.status === "unknown") return "Workspace is no longer registered";
  if (environment.status === "unavailable") return `Workspace is ${environment.reason}`;
  return null;
}

type LocationRowProps = Required<Pick<SessionPanelProps, "location">>
  & Pick<SessionPanelProps, "runActive" | "openMenu" | "onSetOpenMenu" | "onSetWorktree">;

/** What the row says, and what its menu offers, for each place a thread can be. */
function locationLabel(location: ThreadLocation) {
  if (location.kind === "creating") return { text: "Creating worktree…", title: "A checkout of its own is being made" };
  if (location.kind === "worktree") return { text: "Worktree", title: location.worktree.root };
  return { text: "Local", title: "Runs in your project checkout" };
}

/** One entry: it says where the thread works, and its menu carries the only move it has. */
function LocationRow({ location, runActive, openMenu, onSetOpenMenu, onSetWorktree }: LocationRowProps) {
  const inWorktree = location.kind === "worktree";
  const creating = location.kind === "creating";
  const { text, title } = locationLabel(location);

  return (
    <div className="session-location">
      <PopoverMenu
        id={LOCATION_MENU}
        openMenu={openMenu}
        onSetOpenMenu={onSetOpenMenu}
        label="Thread options"
        className="session-row session-location-row"
        popoverClassName="session-menu-popover"
        items={[{
          label: inWorktree ? "Return to local" : "Hand off to worktree",
          disabled: runActive || creating,
          onSelect: () => onSetWorktree(!inWorktree),
        }]}
      >
        <span className="session-row-icon">{inWorktree || creating ? <FolderSymlink size={18} /> : <House size={18} />}</span>
        <span title={title}>{text}</span>
        {creating && <span className="activity-dots" aria-hidden="true"><i /><i /><i /></span>}
      </PopoverMenu>
    </div>
  );
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

/**
 * How often an unsettled pull request is asked about again. A merge happens on GitHub and leaves no
 * trace on this machine, so nothing local can announce it and only asking finds out.
 */
const PULL_REQUEST_POLL_MS = 60_000;

/** States nothing local or remote will move again, past which asking is only cost. A reopen is caught on focus. */
const SETTLED: readonly PullRequestState[] = ["merged", "closed"];

/**
 * The pull request the checkout's work belongs to, read again whenever the checkout, the branch it is
 * on, or the thread reading it changes, whenever the window comes back, and on a slow poll until it
 * settles. Every way of not having one answers null, so a miss and a failure look the same.
 *
 * Only the panel on screen has a row to draw, so only it asks: the poll lives and dies with the mount
 * rather than in the main process, and a hidden window asks nothing at all.
 */
function usePullRequest(workspaceId: string | undefined, branch: string | null, taskId: string | undefined) {
  const [pullRequest, setPullRequest] = useState<PullRequestRef | null>(null);
  const asked = useRef(0);
  const settled = pullRequest !== null && SETTLED.includes(pullRequest.state);

  /** Answers to questions asked before the latest one are dropped, whichever order they arrive in. */
  const refresh = useCallback(() => {
    if (!workspaceId) return;
    const generation = ++asked.current;
    void window.desktop.pullRequest(workspaceId)
      .then((found) => { if (generation === asked.current) setPullRequest(found); })
      .catch(() => {});
  }, [workspaceId]);

  /** Only another checkout or another branch can have a different answer, so only those blank the row. */
  useEffect(() => {
    asked.current++;
    setPullRequest(null);
  }, [workspaceId, branch]);

  useEffect(() => {
    refresh();
    const back = () => { if (document.visibilityState !== "hidden") refresh(); };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [refresh, branch, taskId]);

  /** A hidden window has nothing to show for an answer, and gets one on the way back instead. */
  useEffect(() => {
    if (settled) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, PULL_REQUEST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, branch, taskId, settled]);

  return pullRequest;
}

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

export function SessionPanel({ environment, hasProject, workspaceId, taskId, location, runActive, openMenu, subagents, backgroundProcesses, workflows, automationCount, onSelect, onOpenAgents, onOpenAutomations, onOpenWorkflow, onSetOpenMenu, onSetWorktree, onCheckoutBranch, onStopProcess, onToggleChanges }: SessionPanelProps) {
  const available = environment?.status === "available" ? environment : null;
  const working = subagents.filter((subagent) => subagent.status === "working").length;
  const shown = orderSubagents(subagents).slice(0, SIDEBAR_LIMIT);
  const pullRequest = usePullRequest(workspaceId, available?.branch ?? null, taskId);

  return (
    <aside className="session-panel" aria-label="Session panel">
      <div className="session-card">
        <h2 className="session-title">Session</h2>
            <div className="session-environment">
              {location && hasProject && <LocationRow location={location} runActive={runActive} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onSetWorktree={onSetWorktree} />}
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
              {pullRequest && <PullRequestRow pullRequest={pullRequest} />}
              {environmentMessage(environment, hasProject) && <p className="session-note">{environmentMessage(environment, hasProject)}</p>}
              <button className="session-row session-row-action" type="button" onClick={onOpenAutomations} aria-label="Open Automation panel">
                <span className="session-row-icon"><AlarmClock size={18} /></span>
                <span>Automations</span>
                <span className="session-count">{automationCount}</span>
              </button>
            </div>

            <div className="subagent-section">
              <div className="subagent-heading">
                <span>Subagents</span>
                {working > 0 && <span>{working} working</span>}
              </div>
              {subagents.length === 0 ? (
                <p className="session-empty">No subagents this session</p>
              ) : (
                <div className="subagent-list" aria-live="polite">
                  {shown.map((subagent) => <SubagentRow key={subagent.id} subagent={subagent} onSelect={onSelect} />)}
                  {subagents.length > shown.length && (
                    <button className="subagent-view-all" type="button" onClick={onOpenAgents}>View All</button>
                  )}
                </div>
              )}
            </div>

            <BackgroundProcessSection processes={backgroundProcesses} workflows={workflows} onOpenWorkflow={onOpenWorkflow} onStop={onStopProcess} />
      </div>
    </aside>
  );
}
