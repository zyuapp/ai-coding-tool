import { useId, useState } from "react";
import { LuChevronDown as ChevronDown, LuChevronUp as ChevronUp } from "react-icons/lu";
import { deliveryLabel, type ThreadBrief } from "../../domain/coordination";
import type { Thread } from "../../domain/thread";
import type { CoordinationDecisionView, CoordinatedThreadStatus, CoordinatedThreadView } from "../../application/coordination";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
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

function StatusMark({ status }: { status: CoordinatedThreadStatus }) {
  return status === "working"
    ? <span className="task-spinner" aria-hidden="true" />
    : <span className={`coordination-dot ${status}`} aria-hidden="true" />;
}

/** The threads a coordinator has working under it, one card each, across the top of its conversation. */
export function CoordinationStrip({ members, onSelect }: { members: CoordinatedThreadView[]; onSelect: (threadId: string) => void }) {
  return (
    <nav className="coordination-strip" aria-label="Threads under this coordinator">
      {members.map(({ thread, status, summary }) => (
        <button type="button" key={thread.id} className={`coordination-card ${status}`} onClick={() => onSelect(thread.id)} title={thread.title}>
          <span className="coordination-card-top">
            <StatusMark status={status} />
            <span className="coordination-card-title">{thread.title}</span>
            <ThreadEngineIcon engine={thread.engine} className="coordination-card-engine" size={12} />
          </span>
          <span className="coordination-card-status">{summary ? `${STATUS_LABELS[status]} · ${summary}` : STATUS_LABELS[status]}</span>
        </button>
      ))}
    </nav>
  );
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
