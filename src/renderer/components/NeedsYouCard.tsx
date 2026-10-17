import { useId, useState } from "react";
import { LuArrowUp as ArrowUp, LuChevronDown as ChevronDown, LuChevronUp as ChevronUp, LuX as X } from "react-icons/lu";
import type { ThreadModelChoice } from "../../domain/coordination";
import { modelLabel } from "../../domain/agent-engine";
import { projectName } from "../../domain/project";
import type { Thread } from "../../domain/thread";
import type { CoordinationApprovalView, CoordinationDecisionView, ElsewhereView, ProposalView } from "../../application/coordination-view";
import type { ApprovalView } from "../../application/thread-run-state";
import { CommandButton } from "./CommandControl";
import { BriefDetails } from "./Coordination";
import { HostMark } from "./HostMark";
import "./coordination.css";

/**
 * The threads a coordinator suggested, and those it asked for on other computers, with what its
 * threads run on so a suggestion naming another model can say so.
 */
export type SuggestionsProps = {
  taskId: string;
  threadModel: ThreadModelChoice | null;
  proposals: readonly ProposalView[];
};

/** A thread asked for on another computer, with where it would run. */
type ElsewhereRequest = ProposalView & { elsewhere: ElsewhereView };

/** One page of the card, under a key of its own. Every kind of thing that waits on the user is a page of its own. */
type NeedsYouItem = { key: string } & (
  | { kind: "approval"; view: CoordinationApprovalView }
  | { kind: "elsewhere"; taskId: string; request: ElsewhereRequest }
  | { kind: "decision"; view: CoordinationDecisionView }
  | { kind: "suggestions"; suggestions: SuggestionsProps }
);

type Pager = { index: number; count: number } | null;

/** The page on screen, and where it sat, which is where the card goes on once that page is settled. */
type Page = { key: string; index: number };

/**
 * Everything waiting on the user from a coordinator and its threads, one page at a time: approvals,
 * each thread asked for on another computer, decisions, then the threads it suggested here.
 */
export function NeedsYouCard({ approvals, decisions, suggestions = null, onDecide, onAnswer, onSelect }: {
  approvals: CoordinationApprovalView[];
  decisions: CoordinationDecisionView[];
  suggestions?: SuggestionsProps | null;
  onDecide: (approval: Pick<ApprovalView, "taskId" | "runId" | "approvalId">, allow: boolean) => void;
  onAnswer: (threadId: string, decisionId: string, answer: string) => void;
  onSelect: (threadId: string) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const proposals = suggestions?.proposals ?? [];
  const here = proposals.filter((view) => !view.elsewhere);
  const items: NeedsYouItem[] = [
    ...approvals.map((view) => ({ key: `approval:${view.approval.taskId}:${view.approval.approvalId}`, kind: "approval" as const, view })),
    ...(suggestions ? proposals.flatMap((view) => view.elsewhere ? [{ key: `elsewhere:${view.proposal.id}`, kind: "elsewhere" as const, taskId: suggestions.taskId, request: view as ElsewhereRequest }] : []) : []),
    ...decisions.map((view) => ({ key: `decision:${view.thread.id}:${view.decision.id}`, kind: "decision" as const, view })),
    ...(suggestions && here.length ? [{ key: "suggestions", kind: "suggestions" as const, suggestions: { ...suggestions, proposals: here } }] : []),
  ];
  /** The page stays on what the user is looking at as others arrive ahead of it, and moves on to what takes its place once it is settled. */
  const found = page ? items.findIndex((item) => item.key === page.key) : -1;
  const shown = found >= 0 ? found : Math.min(page?.index ?? 0, items.length - 1);
  const current = items[shown];
  if (current && (current.key !== page?.key || shown !== page.index)) setPage({ key: current.key, index: shown });
  if (!current) return null;
  const position = items.length > 1 ? { index: shown, count: items.length } : null;
  const onStep = (delta: 1 | -1) => {
    const next = (shown + delta + items.length) % items.length;
    setPage({ key: items[next]!.key, index: next });
  };
  switch (current.kind) {
    case "approval":
      return <ApprovalForm key={current.key} view={current.view} position={position} onStep={onStep} onDecide={onDecide} onSelect={onSelect} />;
    case "elsewhere":
      return <ElsewhereForm key={current.key} taskId={current.taskId} request={current.request} position={position} onStep={onStep} />;
    case "decision":
      return <DecisionForm
        key={current.key}
        view={current.view}
        position={position}
        onStep={onStep}
        onAnswer={(answer) => onAnswer(current.view.thread.id, current.view.decision.id, answer)}
        onSelect={onSelect}
      />;
    case "suggestions":
      return <SuggestionsForm key={current.key} suggestions={current.suggestions} position={position} onStep={onStep} />;
  }
}

function NeedsYouHead({ thread, position, onStep, onSelect }: { thread: Thread; position: Pager; onStep: (delta: 1 | -1) => void; onSelect: (threadId: string) => void }) {
  return (
    <div className="decision-head">
      <strong>Needs you</strong>
      <button type="button" className="decision-from" onClick={() => onSelect(thread.id)}>{thread.title}</button>
      <PagerControls position={position} onStep={onStep} />
    </div>
  );
}

function PagerControls({ position, onStep }: { position: Pager; onStep: (delta: 1 | -1) => void }) {
  if (!position) return null;
  return (
    <span className="decision-pager">
      <span>{position.index + 1} of {position.count}</span>
      <button type="button" aria-label="Previous" onClick={() => onStep(-1)}><ChevronUp size={14} aria-hidden="true" /></button>
      <button type="button" aria-label="Next" onClick={() => onStep(1)}><ChevronDown size={14} aria-hidden="true" /></button>
    </span>
  );
}

/** The threads a coordinator suggested, each started or dismissed on its own row, or all at once. */
function SuggestionsForm({ suggestions, position, onStep }: { suggestions: SuggestionsProps; position: Pager; onStep: (delta: 1 | -1) => void }) {
  const { taskId, threadModel, proposals } = suggestions;
  const waiting = proposals.some(({ starting }) => !starting);
  return (
    <section className="decision-card" aria-label="Suggested threads">
      <div className="decision-head">
        <strong>Suggested threads</strong>
        <PagerControls position={position} onStep={onStep} />
      </div>
      <ul className="decision-body suggestion-list">
        {proposals.map((view) => <SuggestionRow key={view.proposal.id} taskId={taskId} threadModel={threadModel} view={view} />)}
      </ul>
      <div className="decision-foot">
        {position && <button type="button" className="secondary" onClick={() => onStep(1)}>Later</button>}
        <span className="decision-foot-gap" />
        <CommandButton type="button" className="secondary" command={{ type: "proposal.dismiss", taskId }} disabled={!waiting}>Dismiss all</CommandButton>
        <CommandButton type="button" command={{ type: "proposal.start", taskId }} disabled={!waiting}>Start all</CommandButton>
      </div>
    </section>
  );
}

/** One suggestion: what it is for, and anything about where or on what it runs that differs from the rest. */
function SuggestionRow({ taskId, threadModel, view }: { taskId: string; threadModel: ThreadModelChoice | null; view: ProposalView }) {
  const { proposal, starting } = view;
  const model = proposal.model && proposal.model !== threadModel?.model ? proposal.model : null;
  const worktree = proposal.place.worktree === true || proposal.place.worktreeId !== undefined;
  return (
    <li className={`suggestion-row${starting ? " starting" : ""}`}>
      <span className="suggestion-text">
        <strong>{proposal.title}</strong>
        <small title={proposal.brief?.intent ?? proposal.prompt}>{proposal.brief?.intent ?? proposal.prompt}</small>
        {proposal.error && !starting && <small className="suggestion-error" role="alert">{proposal.error}</small>}
      </span>
      {model && <span className="suggestion-chip">{modelLabel(model)}</span>}
      {worktree && <span className="suggestion-chip">Worktree</span>}
      {!starting && <CommandButton
        type="button"
        className="suggestion-dismiss"
        aria-label={`Dismiss ${proposal.title}`}
        title="Dismiss"
        command={{ type: "proposal.dismiss", taskId, proposalId: proposal.id }}
      >
        <X size={12} aria-hidden="true" />
      </CommandButton>}
      {starting
        ? <span className="suggestion-start task-spinner" role="status" aria-label={`Starting ${proposal.title}`} />
        : <CommandButton type="button" className="suggestion-start" aria-label={`Start ${proposal.title}`} title="Start" command={{ type: "proposal.start", taskId, proposalId: proposal.id }}>
            <ArrowUp size={14} aria-hidden="true" />
          </CommandButton>}
    </li>
  );
}

/**
 * A thread asked for on another computer, which starts there only once the user allows it, in the
 * folder there they pick and with a worktree of its own if they want one. Allowing it lets this one
 * through and no other. What is picked is only typed here until Allow carries it.
 */
function ElsewhereForm({ taskId, request, position, onStep }: { taskId: string; request: ElsewhereRequest; position: Pager; onStep: (delta: 1 | -1) => void }) {
  const { proposal, starting, elsewhere } = request;
  const { computer, projects, refusal } = elsewhere;
  const [picked, setPicked] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(proposal.place.worktree === true);
  /** A folder picked while that computer still holds it, else the one the view settles on, which follows its projects as they arrive. */
  const project = picked !== null && projects.some((item) => item.id === picked) ? picked : elsewhere.project ?? "";
  return (
    <section className="decision-card elsewhere-card" aria-label={`Run on ${computer.name}?`}>
      <div className="decision-head">
        <strong className="elsewhere-heading">Run on <HostMark name={computer.name} offline={computer.offline} reconnecting={computer.reconnecting} />?</strong>
        <PagerControls position={position} onStep={onStep} />
      </div>
      <div className="decision-body">
        <p className="decision-question">{proposal.title}</p>
        <div className="elsewhere-place">
          {projects.length > 0 && <label className="elsewhere-folder">
            <span>Folder</span>
            <select value={project} onChange={(event) => setPicked(event.currentTarget.value)}>
              {projects.map((item) => <option key={item.id} value={item.id} title={item.root}>{projectName(item)}</option>)}
            </select>
          </label>}
          <label className="elsewhere-worktree">
            <input type="checkbox" checked={worktree} onChange={(event) => setWorktree(event.currentTarget.checked)} />
            New worktree
          </label>
        </div>
        {proposal.brief && <BriefDetails brief={proposal.brief} />}
        {refusal
          ? <p className="suggestion-error" role="status">{refusal}</p>
          : proposal.error && !starting && <p className="suggestion-error" role="alert">{proposal.error}</p>}
      </div>
      <div className="decision-foot">
        {position && <button type="button" className="secondary" onClick={() => onStep(1)}>Later</button>}
        <span className="decision-foot-gap" />
        <CommandButton type="button" className="secondary" command={{ type: "proposal.dismiss", taskId, proposalId: proposal.id }} disabled={starting}>Deny</CommandButton>
        <CommandButton
          type="button"
          command={{ type: "proposal.start", taskId, proposalId: proposal.id, place: { project, worktree } }}
          disabled={starting || refusal !== null}
          title={refusal ?? undefined}
        >
          {starting ? "Starting…" : "Allow"}
        </CommandButton>
      </div>
    </section>
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
