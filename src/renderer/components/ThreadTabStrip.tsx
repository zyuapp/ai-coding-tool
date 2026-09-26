import { useRef, useState } from "react";
import { LuAlarmClock as AlarmClock, LuChevronDown as ChevronDown, LuFileDiff as FileDiff, LuGitBranch as GitBranch, LuGitPullRequest as GitPullRequest, LuScrollText as ScrollText } from "react-icons/lu";
import { BranchMenu, useBranches } from "./BranchMenu";
import { useMessageLinks, WebLink } from "./MarkdownMessage";
import { GITHUB_CLI_URL, PULL_REQUEST_ICONS } from "./SessionPanel";
import { useDismissibleLayer } from "../focus";
import { deliveryLabel, type ThreadBrief } from "../../domain/coordination";
import type { PullRequestAnswer } from "../../domain/pull-request";
import type { ThreadTabView } from "../../application/workspace-state";

export type ThreadTabStripActions = {
  onToggleChanges: () => void;
  onOpenAutomations: () => void;
  onSetBranchMenuOpen: (open: boolean) => void;
  onCheckoutBranch: (branch: string, create: boolean) => void;
};

/** What stands in for the checkout's chips until Git has answered for it. */
function environmentNote(tab: ThreadTabView) {
  if (!tab.folder) return "No project";
  if (!tab.workspaceId) return "Reopen the project to inspect Git";
  const environment = tab.environment;
  if (!environment) return "Reading Git…";
  if (environment.status === "error") return environment.message;
  if (environment.status === "unknown") return "Workspace is no longer registered";
  if (environment.status === "unavailable") return `Workspace is ${environment.reason}`;
  return null;
}

function BranchChip({ branch, workspaceId, open, onSetOpen, onPick }: {
  branch: string;
  workspaceId: string | undefined;
  open: boolean;
  onSetOpen: (open: boolean) => void;
  onPick: (branch: string, create: boolean) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissibleLayer(open, [trigger, menu], () => onSetOpen(false), trigger);
  const branches = useBranches(workspaceId, open);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`thread-tab-chip thread-tab-branch ${open ? "open" : ""}`.trimEnd()}
        aria-label="Branch"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={branch}
        onClick={() => onSetOpen(!open)}
      >
        <GitBranch size={13} aria-hidden="true" />
        <code>{branch}</code>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <BranchMenu
          menuRef={menu}
          anchor={trigger.current}
          branches={branches}
          selected={branch}
          onPick={(name, create) => {
            onSetOpen(false);
            onPick(name, create);
          }}
        />
      )}
    </>
  );
}

function PullRequestChip({ pullRequest }: { pullRequest: PullRequestAnswer }) {
  const links = useMessageLinks();
  if (pullRequest.status === "gh-missing") {
    return (
      <WebLink
        className="thread-tab-chip quiet"
        href={GITHUB_CLI_URL}
        title="Pull requests are read with the GitHub CLI, which is not installed"
        openInApp={links.openUrlInApp && (() => links.openUrlInApp!(GITHUB_CLI_URL))}
      >
        <GitPullRequest size={13} aria-hidden="true" />
        <span>Install gh</span>
      </WebLink>
    );
  }
  if (pullRequest.status !== "found") return null;
  const { url, number, title, state } = pullRequest.pullRequest;
  const Icon = PULL_REQUEST_ICONS[state];
  return (
    <WebLink
      className="thread-tab-chip thread-tab-pull-request"
      data-state={state}
      href={url}
      title={`#${number} ${title}`}
      openInApp={links.openUrlInApp && (() => links.openUrlInApp!(url))}
    >
      <Icon size={13} aria-hidden="true" />
      <span>#{number}</span>
    </WebLink>
  );
}

/** What the coordinator asked of the thread, laid out to be read at a glance. */
function BriefCard({ brief }: { brief: ThreadBrief }) {
  return (
    <section className="thread-tab-brief-card" aria-label="Brief">
      <blockquote>{brief.intent}</blockquote>
      <dl>
        <div><dt>Done when</dt><dd>{brief.doneWhen}</dd></div>
        <div><dt>Delivers</dt><dd>{deliveryLabel(brief.delivers)}</dd></div>
      </dl>
    </section>
  );
}

/**
 * The thread's checkout, pull request and schedule as one line of chips under its header, each doing
 * what the same row in its session panel does, with its brief folded open beneath.
 */
export function ThreadTabStrip({ tab, branchMenuOpen, actions }: { tab: ThreadTabView; branchMenuOpen: boolean; actions: ThreadTabStripActions }) {
  const [briefOpen, setBriefOpen] = useState(false);
  const available = tab.environment?.status === "available" ? tab.environment : null;
  const note = environmentNote(tab);
  const brief = tab.thread.brief;
  const clean = available !== null && available.files.length === 0;
  return (
    <>
      <div className="thread-tab-strip">
        {available && (
          <BranchChip
            branch={available.branch ?? "—"}
            workspaceId={tab.workspaceId}
            open={branchMenuOpen}
            onSetOpen={actions.onSetBranchMenuOpen}
            onPick={actions.onCheckoutBranch}
          />
        )}
        {available && (
          <button
            type="button"
            className={`thread-tab-chip ${clean ? "quiet" : ""}`.trimEnd()}
            aria-label="Review changes"
            title={available.baseline ? `Changes since ${available.baseline}` : "Uncommitted changes"}
            onClick={actions.onToggleChanges}
          >
            <FileDiff size={13} aria-hidden="true" />
            {clean
              ? <span>No changes</span>
              : <span className="change-counts"><strong>+{available.additions}</strong><em>−{available.deletions}</em></span>}
          </button>
        )}
        {note && <span className="thread-tab-note" title={note}>{note}</span>}
        <PullRequestChip pullRequest={tab.pullRequest} />
        <button
          type="button"
          className={`thread-tab-chip ${tab.automation ? "scheduled" : "quiet"}`}
          aria-label="Open Automation panel"
          title={tab.automation ? "Scheduled" : "Automations"}
          onClick={actions.onOpenAutomations}
        >
          <AlarmClock size={13} aria-hidden="true" />
          {tab.automation && <span>Scheduled</span>}
        </button>
        {brief && (
          <button
            type="button"
            className={`thread-tab-chip thread-tab-brief-toggle ${briefOpen ? "open" : ""}`.trimEnd()}
            aria-expanded={briefOpen}
            onClick={() => setBriefOpen(!briefOpen)}
          >
            <ScrollText size={13} aria-hidden="true" />
            <span>Brief</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {brief && briefOpen && <BriefCard brief={brief} />}
    </>
  );
}
