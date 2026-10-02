import { useId, useState } from "react";
import { LuChevronDown as ChevronDown, LuChevronUp as ChevronUp, LuFolderOpen as FolderOpen, LuFolderSymlink as FolderSymlink, LuTrash2 as Trash } from "react-icons/lu";
import { deliveryLabel, type ThreadBrief } from "../../domain/coordination";
import type { Thread } from "../../domain/thread";
import { worktreeHue, worktreeName, type Worktree } from "../../domain/worktree";
import type { CoordinationDecisionView, CoordinatedThreadStatus, CoordinatedThreadView } from "../../application/coordination";
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

/** The threads a coordinator has working under it, each opening as a tab beside its conversation. */
export function CoordinatedThreadList({ members, worktreeGroups, onSelect }: {
  members: CoordinatedThreadView[];
  worktreeGroups: WorktreeGroup[];
  onSelect: (threadId: string) => void;
}) {
  const worktrees = new Map(worktreeGroups.map(({ worktree }) => [worktree.id, worktree]));
  const working = members.filter((member) => member.status === "working").length;
  const waiting = members.filter((member) => member.status === "asking" || member.status === "approval").length;
  return (
    <section className="subagent-section coordination-section" aria-label="Threads under this coordinator">
      <div className="subagent-heading">
        <div className="coordination-heading">Threads</div>
        {waiting > 0 ? <div className="coordination-count waiting">{waiting} waiting on you</div> : working > 0 && <div className="coordination-count">{working} working</div>}
      </div>
      <div className="subagent-list" aria-live="polite">
        {members.map(({ thread, status, summary }) => (
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
      </div>
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

/** Every decision waiting on the user from a coordinator and its threads, answered one at a time. */
export function DecisionCard({ decisions, onAnswer, onSelect }: {
  decisions: CoordinationDecisionView[];
  onAnswer: (threadId: string, decisionId: string, answer: string) => void;
  onSelect: (threadId: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const shown = Math.min(index, decisions.length - 1);
  const current = decisions[shown];
  if (!current) return null;
  return (
    <DecisionForm
      key={current.decision.id}
      view={current}
      position={decisions.length > 1 ? { index: shown, count: decisions.length } : null}
      onStep={(delta) => setIndex((shown + delta + decisions.length) % decisions.length)}
      onAnswer={(answer) => onAnswer(current.thread.id, current.decision.id, answer)}
      onSelect={onSelect}
    />
  );
}

function DecisionForm({ view, position, onStep, onAnswer, onSelect }: {
  view: CoordinationDecisionView;
  position: { index: number; count: number } | null;
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
      <div className="decision-head">
        <strong>Needs you</strong>
        <button type="button" className="decision-from" onClick={() => onSelect(thread.id)}>{thread.title}</button>
        {position && <span className="decision-pager">
          <span>{position.index + 1} of {position.count}</span>
          <button type="button" aria-label="Previous decision" onClick={() => onStep(-1)}><ChevronUp size={14} aria-hidden="true" /></button>
          <button type="button" aria-label="Next decision" onClick={() => onStep(1)}><ChevronDown size={14} aria-hidden="true" /></button>
        </span>}
      </div>
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
