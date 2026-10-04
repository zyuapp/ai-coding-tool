import { useId, useState } from "react";
import { LuChevronDown as ChevronDown, LuChevronUp as ChevronUp, LuFolderOpen as FolderOpen, LuFolderSymlink as FolderSymlink, LuTrash2 as Trash } from "react-icons/lu";
import { deliveryLabel, OVERVIEW_GROUPS, type OverviewFold, type OverviewFolds, type OverviewGroup, type ThreadBrief } from "../../domain/coordination";
import type { Thread } from "../../domain/thread";
import { worktreeHue, worktreeName, type Worktree } from "../../domain/worktree";
import { overviewGroups, type CoordinationApprovalView, type CoordinationDecisionView, type CoordinatedThreadStatus, type CoordinatedThreadView } from "../../application/coordination";
import type { ApprovalView } from "../../application/thread-run-state";
import type { WorktreeGroup } from "../../application/workspace-state";
import type { MemberWorktree } from "../../application/member-worktrees";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { MAC } from "../platform";
import "./coordination.css";

const STATUS_LABELS: Record<CoordinatedThreadStatus, string> = {
  approval: "Needs approval",
  asking: "Needs you",
  working: "Working",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  finished: "Finished its turn",
  idle: "Idle",
};

export function CoordinationStatusMark({ status }: { status: CoordinatedThreadStatus }) {
  return status === "working"
    ? <span className="task-spinner" aria-hidden="true" />
    : <span className={`coordination-dot ${status}`} aria-hidden="true" />;
}

export function coordinationStatusLine(status: CoordinatedThreadStatus, summary: string | null) {
  return summary ? `${STATUS_LABELS[status]} · ${summary}` : STATUS_LABELS[status];
}

/** How many threads a group shows before it asks to show the rest. */
const OVERVIEW_LIMIT = 5;

const OVERVIEW_LABELS: Record<OverviewGroup, string> = { needs: "Needs you", working: "Working", done: "Done" };

/** A coordinator's threads by what they need from the user, each opening as a tab beside its conversation. */
export function CoordinatorOverview({ members, worktreeGroups, folds, onSetFold, onSelect }: {
  members: CoordinatedThreadView[];
  worktreeGroups: WorktreeGroup[];
  folds: OverviewFolds;
  onSetFold: (group: OverviewGroup, change: { open?: boolean; all?: boolean }) => void;
  onSelect: (threadId: string) => void;
}) {
  if (!members.length) return <p className="session-empty coordination-empty">No threads yet</p>;
  const worktrees = new Map(worktreeGroups.map(({ worktree }) => [worktree.id, worktree]));
  const groups = overviewGroups(members);
  return (
    <div className="coordination-overview" aria-label="Threads under this coordinator">
      {OVERVIEW_GROUPS.map((group) => groups[group].length > 0 && (
        <OverviewSection key={group} group={group} members={groups[group]} fold={folds[group] ?? {}} worktrees={worktrees} onSetFold={onSetFold} onSelect={onSelect} />
      ))}
    </div>
  );
}

/** One group of threads. Done starts folded once it is longer than a group shows. */
function OverviewSection({ group, members, fold, worktrees, onSetFold, onSelect }: {
  group: OverviewGroup;
  members: CoordinatedThreadView[];
  fold: OverviewFold;
  worktrees: Map<string, Worktree>;
  onSetFold: (group: OverviewGroup, change: { open?: boolean; all?: boolean }) => void;
  onSelect: (threadId: string) => void;
}) {
  const open = fold.open ?? (group !== "done" || members.length <= OVERVIEW_LIMIT);
  const label = OVERVIEW_LABELS[group];
  const shown = fold.all ? members : members.slice(0, OVERVIEW_LIMIT);
  return (
    <section className={`coordination-group ${group}`} aria-label={label}>
      <button type="button" className="coordination-group-head" aria-expanded={open} onClick={() => onSetFold(group, { open: !open })}>
        <ChevronDown size={13} aria-hidden="true" />
        <span>{label}</span>
        <span className="coordination-group-count">{members.length}</span>
      </button>
      {open && <div className="subagent-list" aria-live="polite">
        {shown.map(({ thread, status, summary }) => (
          <button
            type="button"
            key={thread.id}
            className={`coordination-row ${status}`}
            aria-label={`Open ${thread.title}`}
            title={thread.title}
            onClick={() => onSelect(thread.id)}
          >
            <span className="coordination-row-mark"><CoordinationStatusMark status={status} /></span>
            <span><strong>{thread.title}</strong><small>{coordinationStatusLine(status, summary)}</small></span>
            <span className="coordination-row-marks">
              {thread.worktreeId && <WorktreeMark worktreeId={thread.worktreeId} worktree={worktrees.get(thread.worktreeId)} />}
              <ThreadEngineIcon engine={thread.engine} className="coordination-row-engine" size={12} />
            </span>
          </button>
        ))}
        {members.length > shown.length && (
          <button type="button" className="coordination-more" onClick={() => onSetFold(group, { all: true })}>Show {members.length - shown.length} more</button>
        )}
      </div>}
    </section>
  );
}

/** The checkouts a coordinator's threads work in. New threads start there only through the coordinator, so the list only reveals and deletes. */
export function MemberWorktreeList({ worktrees, onReveal, onDelete }: {
  worktrees: MemberWorktree[];
  /** Absent for a paired computer's checkouts, which cannot be revealed here. */
  onReveal?: (root: string) => void;
  onDelete: (root: string) => void;
}) {
  return (
    <section className="subagent-section coordination-section coordination-worktrees" aria-label="Worktrees these threads work in">
      <div className="subagent-heading"><div className="coordination-heading">Worktrees</div></div>
      <div className="subagent-list">
        {worktrees.map((worktree) => {
          const by = worktree.threads.map((thread) => thread.title).join(", ");
          const detail = worktree.deleting ? "Deleting…" : worktree.branch ? `${worktree.branch} · ${by}` : by;
          return (
            <div key={worktree.id} className="coordination-row coordination-worktree" title={`${worktree.root}\n${by}`}>
              <span className={`coordination-row-mark worktree-mark hue-${worktreeHue(worktree.id)}`}><FolderSymlink size={12} aria-hidden="true" /></span>
              <span><strong>{worktree.name}</strong><small className={worktree.deleting ? "text-sweep" : undefined}>{detail}</small></span>
              <span className="coordination-worktree-actions">
                {onReveal && <button type="button" aria-label={`Reveal ${worktree.name}`} title={MAC ? "Reveal in Finder" : "Show in file manager"} disabled={worktree.deleting} onClick={() => onReveal(worktree.root)}>
                  <FolderOpen size={12} />
                </button>}
                <button
                  type="button"
                  className="danger"
                  aria-label={`Delete ${worktree.name}`}
                  title={worktree.busy ? "Wait for its threads to finish before deleting" : "Delete worktree…"}
                  disabled={worktree.busy || worktree.deleting}
                  onClick={() => onDelete(worktree.root)}
                >
                  <Trash size={12} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The same mark a thread's sidebar row carries, in its checkout's colour. */
function WorktreeMark({ worktreeId, worktree }: { worktreeId: string; worktree: Worktree | undefined }) {
  return <FolderSymlink className={`task-worktree worktree-mark hue-${worktreeHue(worktreeId)}`} size={12} aria-label={`Works in ${worktree ? worktreeName(worktree) : "a worktree"}`} />;
}

/** A thread's place under its coordinator: who it works for, what it was asked, and whether the user owes it an answer. */
export function CoordinationBar({ lead, brief, asking, onSelect }: { lead: Thread | null; brief: ThreadBrief | null; asking: boolean; onSelect: (threadId: string) => void }) {
  return (
    <div className={`coordination-bar ${asking ? "asking" : ""}`}>
      {lead && <div className="coordination-bar-line">
        <span className="coordination-bar-lead">Works under <button type="button" onClick={() => onSelect(lead.id)}>{lead.title}</button></span>
        {asking && <>
          <span className="coordination-bar-asking">A decision is waiting on you</span>
          <button type="button" className="coordination-bar-answer" onClick={() => onSelect(lead.id)}>Answer</button>
        </>}
      </div>}
      {brief && (
        <details className="coordination-brief">
          <summary>Brief</summary>
          <dl>
            <dt>Your words</dt><dd className="coordination-brief-intent">{brief.intent}</dd>
            <dt>Done when</dt><dd>{brief.doneWhen}</dd>
            <dt>Delivers</dt><dd>{deliveryLabel(brief.delivers)}</dd>
          </dl>
        </details>
      )}
    </div>
  );
}

type NeedsYouItem =
  | { kind: "approval"; view: CoordinationApprovalView }
  | { kind: "decision"; view: CoordinationDecisionView };

type Pager = { index: number; count: number } | null;

/** Every approval and decision waiting on the user from a coordinator's threads, answered one at a time. */
export function NeedsYouCard({ approvals, decisions, onDecide, onAnswer, onSelect }: {
  approvals: CoordinationApprovalView[];
  decisions: CoordinationDecisionView[];
  onDecide: (approval: Pick<ApprovalView, "taskId" | "runId" | "approvalId">, allow: boolean) => void;
  onAnswer: (threadId: string, decisionId: string, answer: string) => void;
  onSelect: (threadId: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const items: NeedsYouItem[] = [
    ...approvals.map((view) => ({ kind: "approval" as const, view })),
    ...decisions.map((view) => ({ kind: "decision" as const, view })),
  ];
  const shown = Math.min(index, items.length - 1);
  const current = items[shown];
  if (!current) return null;
  const position = items.length > 1 ? { index: shown, count: items.length } : null;
  const onStep = (delta: 1 | -1) => setIndex((shown + delta + items.length) % items.length);
  return current.kind === "approval"
    ? <ApprovalForm key={current.view.approval.approvalId} view={current.view} position={position} onStep={onStep} onDecide={onDecide} onSelect={onSelect} />
    : <DecisionForm
        key={current.view.decision.id}
        view={current.view}
        position={position}
        onStep={onStep}
        onAnswer={(answer) => onAnswer(current.view.thread.id, current.view.decision.id, answer)}
        onSelect={onSelect}
      />;
}

function NeedsYouHead({ thread, position, onStep, onSelect }: { thread: Thread; position: Pager; onStep: (delta: 1 | -1) => void; onSelect: (threadId: string) => void }) {
  return (
    <div className="decision-head">
      <strong>Needs you</strong>
      <button type="button" className="decision-from" onClick={() => onSelect(thread.id)}>{thread.title}</button>
      {position && <span className="decision-pager">
        <span>{position.index + 1} of {position.count}</span>
        <button type="button" aria-label="Previous" onClick={() => onStep(-1)}><ChevronUp size={14} aria-hidden="true" /></button>
        <button type="button" aria-label="Next" onClick={() => onStep(1)}><ChevronDown size={14} aria-hidden="true" /></button>
      </span>}
    </div>
  );
}

/** A tool call a thread under the coordinator is waiting to run. */
function ApprovalForm({ view, position, onStep, onDecide, onSelect }: {
  view: CoordinationApprovalView;
  position: Pager;
  onStep: (delta: 1 | -1) => void;
  onDecide: (approval: Pick<ApprovalView, "taskId" | "runId" | "approvalId">, allow: boolean) => void;
  onSelect: (threadId: string) => void;
}) {
  const { thread, approval } = view;
  const command = typeof approval.input.command === "string" ? approval.input.command : null;
  return (
    <section className="decision-card" aria-label="Approval waiting on you">
      <NeedsYouHead thread={thread} position={position} onStep={onStep} onSelect={onSelect} />
      <div className="decision-body">
        <p className="decision-question">{approval.title}</p>
        {approval.description && <p className="decision-context">{approval.description}</p>}
        {command
          ? <pre className="decision-command">{command}</pre>
          : <details className="decision-tool"><summary>{approval.toolName}</summary><pre>{JSON.stringify(approval.input, null, 2)}</pre></details>}
      </div>
      <div className="decision-foot">
        {position && <button type="button" className="secondary" onClick={() => onStep(1)}>Later</button>}
        <span className="decision-foot-gap" />
        <button type="button" className="secondary" onClick={() => onDecide(approval, false)}>Deny</button>
        <button type="button" onClick={() => onDecide(approval, true)}>Allow</button>
      </div>
    </section>
  );
}

function DecisionForm({ view, position, onStep, onAnswer, onSelect }: {
  view: CoordinationDecisionView;
  position: Pager;
  onStep: (delta: 1 | -1) => void;
  onAnswer: (answer: string) => void;
  onSelect: (threadId: string) => void;
}) {
  const id = useId();
  const { thread, decision } = view;
  const [choice, setChoice] = useState(() => decision.options.find((option) => option.recommended)?.label ?? "");
  const [own, setOwn] = useState("");
  const answer = own.trim() || choice;
  return (
    <form className="decision-card" aria-label="Decision waiting on you" onSubmit={(event) => {
      event.preventDefault();
      if (answer) onAnswer(answer);
    }}>
      <NeedsYouHead thread={thread} position={position} onStep={onStep} onSelect={onSelect} />
      <div className="decision-body">
        <p className="decision-question" id={id}>{decision.question}</p>
        {decision.context && <p className="decision-context">{decision.context}</p>}
        {decision.options.length > 0 && <div className="decision-options" role="radiogroup" aria-labelledby={id}>
          {decision.options.map((option) => (
            <label className="decision-option" key={option.label}>
              <input type="radio" name={id} value={option.label} checked={!own.trim() && choice === option.label} onChange={() => { setChoice(option.label); setOwn(""); }} />
              <span>
                <span className="decision-option-label">{option.label}{option.recommended && <span className="decision-recommended">Recommended</span>}</span>
                {option.description && <span className="decision-option-description">{option.description}</span>}
              </span>
            </label>
          ))}
        </div>}
      </div>
      <div className="decision-foot">
        <input
          value={own}
          placeholder={decision.options.length ? "Or answer in your own words" : "Your answer"}
          aria-label="Your own answer"
          onChange={(event) => setOwn(event.currentTarget.value)}
        />
        {position && <button type="button" className="secondary" onClick={() => onStep(1)}>Later</button>}
        <button type="submit" disabled={!answer}>Decide</button>
      </div>
    </form>
  );
}
