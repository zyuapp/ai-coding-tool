import { useId, useRef, useState } from "react";
import { LuAlarmClock as AlarmClock, LuChevronDown as ChevronDown, LuFileDiff as FileDiff, LuGitBranch as GitBranch, LuGitPullRequest as GitPullRequest, LuScrollText as ScrollText } from "react-icons/lu";
import { BranchMenu, useBranches } from "./BranchMenu";
import { CommandButton } from "./CommandControl";
import { useMessageLinks, WebLink } from "./MarkdownMessage";
import { GITHUB_CLI_URL, PULL_REQUEST_ICONS } from "./SessionPanel";
import { useDismissibleLayer } from "../focus";
import { deliveryLabel, type ThreadBrief } from "../../domain/coordination";
import type { PullRequestAnswer, PullRequestState } from "../../domain/pull-request";
import type { ThreadTabView } from "../../application/workspace-state";

export type ThreadTabStripActions = {
  onToggleChanges: () => void;
  onOpenAutomations: () => void;
  onSetBranchMenuOpen: (open: boolean) => void;
  onCheckoutBranch: (branch: string, create: boolean) => void;
};

const PULL_REQUEST_STATES: Record<PullRequestState, string> = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed" };

/** What stands in for the checkout's chips until Git has answered for it; `failed` when Git refused. */
function environmentNote(tab: ThreadTabView): { text: string; failed?: boolean; reading?: boolean } | null {
  if (!tab.folder) return { text: "No project" };
  if (!tab.workspaceId) return { text: "Reopen the project to inspect Git" };
  const environment = tab.environment;
  if (!environment) return { text: "Reading Git…", reading: true };
  if (environment.status === "error") return { text: environment.message, failed: true };
  if (environment.status === "unknown") return { text: "Workspace is no longer registered" };
  if (environment.status === "unavailable") return { text: `Workspace is ${environment.reason}` };
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
        aria-label={`Branch ${branch}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tip={branch}
        data-tip-overflow
        onClick={() => onSetOpen(!open)}
      >
        <GitBranch size={14} aria-hidden="true" />
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
        title=""
        data-tip="Pull requests are read with the GitHub CLI, which is not installed"
        openInApp={links.openUrlInApp && (() => links.openUrlInApp!(GITHUB_CLI_URL))}
      >
        <GitPullRequest size={14} aria-hidden="true" />
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
      title=""
      data-tip={title}
      openInApp={links.openUrlInApp && (() => links.openUrlInApp!(url))}
    >
      <Icon size={14} aria-hidden="true" />
      <span>#{number} · {PULL_REQUEST_STATES[state]}</span>
    </WebLink>
  );
}

/** What the coordinator asked of the thread, laid out to be read at a glance. */
function BriefCard({ id, brief }: { id: string; brief: ThreadBrief }) {
  return (
    <section id={id} className="thread-tab-brief-card" aria-label="Brief">
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
  const briefId = useId();
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
            aria-label={clean ? "Review changes, none" : `Review changes, +${available.additions} −${available.deletions}`}
            data-tip={available.baseline ? `Changes since ${available.baseline}` : "Uncommitted changes"}
            onClick={actions.onToggleChanges}
          >
            <FileDiff size={14} aria-hidden="true" />
            {clean
              ? <span>No changes</span>
              : <span className="change-counts"><strong>+{available.additions}</strong><em>−{available.deletions}</em></span>}
          </button>
        )}
        {note && (note.failed
          ? <span className="thread-tab-note failed" role="alert">
              <span data-tip={note.text} data-tip-overflow>{note.text}</span>
              <CommandButton type="button" className="thread-tab-retry" command={{ type: "view.refresh-environment" }}>Retry</CommandButton>
            </span>
          : <span className="thread-tab-note" role={note.reading ? "status" : undefined}><span className={note.reading ? "text-sweep" : undefined}>{note.text}</span></span>)}
        <PullRequestChip pullRequest={tab.pullRequest} />
        <button
          type="button"
          className={`thread-tab-chip ${tab.automation ? "scheduled" : "quiet"}`}
          aria-label="Open Automation panel"
          data-tip={tab.automation ? "Scheduled" : "Automations"}
          onClick={actions.onOpenAutomations}
        >
          <AlarmClock size={14} aria-hidden="true" />
          {tab.automation && <span>Scheduled</span>}
        </button>
        {brief && (
          <button
            type="button"
            className={`thread-tab-chip thread-tab-brief-toggle ${briefOpen ? "open" : ""}`.trimEnd()}
            aria-expanded={briefOpen}
            aria-controls={briefOpen ? briefId : undefined}
            onClick={() => setBriefOpen(!briefOpen)}
          >
            <ScrollText size={14} aria-hidden="true" />
            <span>Brief</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {brief && briefOpen && <BriefCard id={briefId} brief={brief} />}
    </>
  );
}
