import { useContext, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LuArrowUpRight as ArrowUpRight, LuChevronLeft as ChevronLeft, LuChevronRight as ChevronRight, LuPlay as Play, LuX as X } from "react-icons/lu";
import type { AppCommand } from "../../contracts/commands";
import type { ThreadModelChoice } from "../../domain/coordination";
import { modelLabel } from "../../domain/agent-engine";
import { projectName } from "../../domain/project";
import { displayShortcut } from "../../domain/shortcuts";
import type { Thread } from "../../domain/thread";
import type { CoordinationApprovalView, CoordinationDecisionView, ElsewhereView, ProposalView } from "../../application/coordination-view";
import type { ApprovalView } from "../../application/thread-run-state";
import { approvalCommand, DecideButton, type DecideBindings } from "./ApprovalCard";
import { CommandButton, useCommandControls } from "./CommandControl";
import { BriefDetails } from "./Coordination";
import { HostMark } from "./HostMark";
import { firstFocusable, placeOf, ReturnFocusContext, useKeyboardPlace } from "../focus";
import { MAC } from "../platform";
import { ConfirmAction, type ConfirmActionProps } from "./SettingRow";
import { shortcutTip } from "./TooltipLayer";
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

/** What the user has chosen or typed on a page, kept under its key while they look at the others. */
type Draft = DecisionDraft | ElsewhereDraft;
type DecisionDraft = { kind: "decision"; choice: string; own: string };
type ElsewhereDraft = { kind: "elsewhere"; picked: string | null; worktree: boolean };

/**
 * What the user pressed on the card: a control the page after it draws again, such as the pager or a
 * suggestion's Start, by which of those it was, or one that settles the page it is on.
 */
type CardPlace = { action: string | null; index: number };

function actionsOf(root: HTMLElement, action: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-action]")].filter((button) => button.dataset.action === action);
}

/** A control that asks once more is remembered by the place it stands in, so its answer counts as pressing it. */
function rememberCardPlace(pressed: HTMLElement, root: HTMLElement): CardPlace {
  const holder = pressed.closest<HTMLElement>("[data-action]");
  const action = holder && root.contains(holder) ? holder.dataset.action ?? null : null;
  return { action, index: action ? actionsOf(root, action).indexOf(holder!) : -1 };
}

/**
 * Where the keyboard goes once what it pressed is gone: to the same control on the page or row that
 * took its place, else to that page itself, so what comes next is read before anything on it is pressed.
 */
function cardFocus({ action, index }: CardPlace, root: HTMLElement): HTMLElement | null | undefined {
  const place = action ? placeOf(actionsOf(root, action), index) : undefined;
  return (place && firstFocusable(place)) ?? root.querySelector<HTMLElement>(".decision-card");
}

/** A command that turns something down for good, sent only once the user confirms it. */
function ConfirmCommand({ command, confirm, ...props }: Omit<ConfirmActionProps, "onConfirm"> & { command: AppCommand }) {
  const controls = useCommandControls();
  if (!props.disabled && !controls.available(command)) return <CommandButton {...props} command={command} />;
  return <ConfirmAction {...props} confirm={confirm} onConfirm={() => controls.dispatch(command)} />;
}

const UNBOUND: DecideBindings = { allow: null, deny: null };

/**
 * Everything waiting on the user from a coordinator and its threads, one page at a time: approvals,
 * each thread asked for on another computer, decisions, then the threads it suggested here.
 */
export function NeedsYouCard({ approvals, decisions, suggestions = null, bindings = UNBOUND, onDecide, onAnswer, onSelect }: {
  approvals: CoordinationApprovalView[];
  decisions: CoordinationDecisionView[];
  suggestions?: SuggestionsProps | null;
  /** The keys that answer the approval on screen, where the window's Allow and Deny shortcuts reach it. */
  bindings?: DecideBindings;
  onDecide: (approval: Pick<ApprovalView, "taskId" | "runId" | "approvalId">, allow: boolean) => void;
  onAnswer: (threadId: string, decisionId: string, answer: string) => void;
  onSelect: (threadId: string) => void;
}) {
  const [page, setPage] = useState<Page | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const card = useRef<HTMLDivElement>(null);
  const keepPlace = useKeyboardPlace(card, rememberCardPlace, cardFocus, useContext(ReturnFocusContext));
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
  /** A page's draft replaces what it held, and those of pages already settled are let go. */
  const onDraft = (draft: Draft) => setDrafts((all) => ({
    ...Object.fromEntries(items.flatMap((item) => all[item.key] ? [[item.key, all[item.key]]] : [])),
    [current.key]: draft,
  }));
  const draft = drafts[current.key];
  /** ← and → turn the page as its pager would, except where they move a caret or a choice. */
  const onPagerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const action = event.key === "ArrowLeft" ? "previous" : event.key === "ArrowRight" ? "next" : null;
    if (!action || (event.target instanceof Element && event.target.closest("input, textarea, select"))) return;
    const pager = card.current?.querySelector<HTMLElement>(`[data-action="${action}"]`);
    if (!pager) return;
    event.preventDefault();
    pager.click();
  };
  /** Every page is drawn in the same root, which outlives them, so the keyboard's place is found in it. */
  const held = (form: ReactNode) => <div ref={card} onClickCapture={keepPlace} onKeyDown={onPagerKey}>{form}</div>;
  switch (current.kind) {
    case "approval":
      return held(<ApprovalForm key={current.key} view={current.view} bindings={bindings} position={position} onStep={onStep} onDecide={onDecide} onSelect={onSelect} />);
    case "elsewhere":
      return held(<ElsewhereForm
        key={current.key}
        taskId={current.taskId}
        request={current.request}
        draft={draft?.kind === "elsewhere" ? draft : null}
        position={position}
        onStep={onStep}
        onDraft={onDraft}
      />);
    case "decision":
      return held(<DecisionForm
        key={current.key}
        view={current.view}
        draft={draft?.kind === "decision" ? draft : null}
        position={position}
        onStep={onStep}
        onDraft={onDraft}
        onAnswer={(answer) => onAnswer(current.view.thread.id, current.view.decision.id, answer)}
        onSelect={onSelect}
      />);
    case "suggestions":
      return held(<SuggestionsForm key={current.key} suggestions={current.suggestions} position={position} onStep={onStep} />);
  }
}

/** Ids under which a page names what it is read by: the thread that asks, and what it asks. */
function pageIds(id: string) {
  return { from: `${id}-from`, question: `${id}-question`, context: `${id}-context`, command: `${id}-command` };
}

/** The ids of what a page is read by once focus lands on it, leaving out what it does not draw. */
function describedBy(...ids: Array<string | false | null | undefined>): string {
  return ids.filter(Boolean).join(" ");
}

function NeedsYouHead({ id, thread, position, onStep, onSelect }: { id: string; thread: Thread; position: Pager; onStep: (delta: 1 | -1) => void; onSelect: (threadId: string) => void }) {
  return (
    <div className="decision-head">
      <strong>Needs you</strong>
      <button type="button" id={id} className="decision-from" data-tip="Open thread" onClick={() => onSelect(thread.id)}>{thread.title}<ArrowUpRight className="decision-from-arrow" size={12} aria-hidden="true" /></button>
      <PagerControls position={position} onStep={onStep} />
    </div>
  );
}

function PagerControls({ position, onStep }: { position: Pager; onStep: (delta: 1 | -1) => void }) {
  if (!position) return null;
  return (
    <span className="decision-pager">
      <button type="button" aria-label="Previous" aria-keyshortcuts="ArrowLeft" data-tip={shortcutTip("Previous", "ArrowLeft")} data-action="previous" onClick={() => onStep(-1)}><ChevronLeft size={14} aria-hidden="true" /></button>
      <span className="decision-count">{position.index + 1} of {position.count}</span>
      <button type="button" aria-label="Next" aria-keyshortcuts="ArrowRight" data-tip={shortcutTip("Next", "ArrowRight")} data-action="next" onClick={() => onStep(1)}><ChevronRight size={14} aria-hidden="true" /></button>
    </span>
  );
}

/** The threads a coordinator suggested, each started or dismissed on its own row, or all at once. */
function SuggestionsForm({ suggestions, position, onStep }: { suggestions: SuggestionsProps; position: Pager; onStep: (delta: 1 | -1) => void }) {
  const { taskId, threadModel, proposals } = suggestions;
  /**
   * Start all and Dismiss all name the suggestions on screen, so the computer holding them never
   * starts or turns down one this window could not show.
   */
  const shown = proposals.flatMap(({ proposal, starting }) => starting ? [] : [proposal.id]);
  const waiting = shown.length > 0;
  return (
    <section className="decision-card" aria-label="Suggested threads" tabIndex={-1}>
      <div className="decision-head">
        <strong>Suggested threads</strong>
        <PagerControls position={position} onStep={onStep} />
      </div>
      <ul className="decision-body suggestion-list">
        {proposals.map((view) => <SuggestionRow key={view.proposal.id} taskId={taskId} threadModel={threadModel} view={view} />)}
      </ul>
      <div className="decision-foot">
        {position && <button type="button" className="secondary" data-action="later" onClick={() => onStep(1)}>Later</button>}
        <span className="decision-foot-gap" />
        <ConfirmCommand className="secondary" confirm="Dismiss all" command={{ type: "proposal.dismiss", taskId, proposalIds: shown }} disabled={!waiting}>Dismiss all</ConfirmCommand>
        <CommandButton type="button" className="suggestion-start-all" command={{ type: "proposal.start", taskId, proposalIds: shown }} disabled={!waiting}>Start all</CommandButton>
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
        <strong title={proposal.title}>{proposal.title}</strong>
        <small title={proposal.brief?.intent ?? proposal.prompt}>{proposal.brief?.intent ?? proposal.prompt}</small>
        {proposal.error && !starting && <small className="suggestion-error" role="alert">{proposal.error}</small>}
      </span>
      {model && <span className="suggestion-chip">{modelLabel(model)}</span>}
      {worktree && <span className="suggestion-chip">Worktree</span>}
      {!starting && <span className="suggestion-dismiss-slot" data-action="dismiss">
        <ConfirmCommand
          className="suggestion-dismiss"
          aria-label={`Dismiss ${proposal.title}`}
          data-tip="Dismiss"
          confirm="Dismiss"
          command={{ type: "proposal.dismiss", taskId, proposalId: proposal.id }}
        >
          <X size={14} aria-hidden="true" />
        </ConfirmCommand>
      </span>}
      {starting
        ? <span className="suggestion-start task-spinner" role="status" aria-label={`Starting ${proposal.title}`} />
        : <CommandButton type="button" className="suggestion-start" data-action="start" aria-label={`Start ${proposal.title}`} command={{ type: "proposal.start", taskId, proposalId: proposal.id }}>
            <Play size={12} fill="currentColor" aria-hidden="true" />Start
          </CommandButton>}
    </li>
  );
}

/**
 * A thread asked for on another computer, which starts there only once the user allows it, in the
 * folder there they pick and with a worktree of its own if they want one. Allowing it lets this one
 * through and no other. What is picked stays on the card, through paging away and back, until Allow carries it.
 */
function ElsewhereForm({ taskId, request, draft, position, onStep, onDraft }: {
  taskId: string;
  request: ElsewhereRequest;
  draft: ElsewhereDraft | null;
  position: Pager;
  onStep: (delta: 1 | -1) => void;
  onDraft: (draft: ElsewhereDraft) => void;
}) {
  const { proposal, starting, elsewhere } = request;
  const { computer, projects, refusal } = elsewhere;
  const { picked, worktree } = draft ?? { picked: null, worktree: proposal.place.worktree === true };
  /** A folder picked while that computer still holds it, else the one the view settles on, which follows its projects as they arrive. */
  const project = picked !== null && projects.some((item) => item.id === picked) ? picked : elsewhere.project ?? "";
  const root = projects.find((item) => item.id === project)?.root;
  const id = useId();
  const ids = pageIds(id);
  return (
    <section className="decision-card elsewhere-card" aria-label={`Run on ${computer.name}?`} aria-describedby={ids.question} tabIndex={-1}>
      <div className="decision-head">
        <strong className="elsewhere-heading">Run on <HostMark name={computer.name} offline={computer.offline} reconnecting={computer.reconnecting} />?</strong>
        <PagerControls position={position} onStep={onStep} />
      </div>
      <div className="decision-body">
        <p className="decision-question" id={ids.question}>{proposal.title}</p>
        <div className="elsewhere-place">
          {projects.length > 0 && <label className="elsewhere-folder">
            <span>Folder</span>
            <select value={project} aria-describedby={root ? `${id}-root` : undefined} onChange={(event) => onDraft({ kind: "elsewhere", picked: event.currentTarget.value, worktree })}>
              {projects.map((item) => <option key={item.id} value={item.id} title={item.root}>{projectName(item)}</option>)}
            </select>
          </label>}
          <label className="elsewhere-worktree">
            <input type="checkbox" checked={worktree} onChange={(event) => onDraft({ kind: "elsewhere", picked, worktree: event.currentTarget.checked })} />
            New worktree
          </label>
          {root && <small className="elsewhere-root" id={`${id}-root`}>{root}</small>}
        </div>
        {proposal.brief && <BriefDetails brief={proposal.brief} />}
        {refusal
          ? <p className="suggestion-error" id={ids.context} role="status">{refusal}</p>
          : proposal.error && !starting && <p className="suggestion-error" role="alert">{proposal.error}</p>}
      </div>
      <div className="decision-foot">
        {position && <button type="button" className="secondary" data-action="later" onClick={() => onStep(1)}>Later</button>}
        <span className="decision-foot-gap" />
        <ConfirmCommand className="secondary" confirm="Deny" command={{ type: "proposal.dismiss", taskId, proposalId: proposal.id }} disabled={starting}>Deny</ConfirmCommand>
        <CommandButton
          type="button"
          className="decision-allow"
          command={{ type: "proposal.start", taskId, proposalId: proposal.id, place: { project, worktree } }}
          disabled={starting || refusal !== null}
          {...(refusal ? { "aria-describedby": ids.context } : {})}
        >
          {starting ? "Starting…" : "Allow"}
        </CommandButton>
      </div>
    </section>
  );
}

/** A tool call a thread under the coordinator is waiting to run. */
function ApprovalForm({ view, bindings, position, onStep, onDecide, onSelect }: {
  view: CoordinationApprovalView;
  bindings: DecideBindings;
  position: Pager;
  onStep: (delta: 1 | -1) => void;
  onDecide: (approval: Pick<ApprovalView, "taskId" | "runId" | "approvalId">, allow: boolean) => void;
  onSelect: (threadId: string) => void;
}) {
  const { thread, approval } = view;
  const command = approvalCommand(approval.input);
  const ids = pageIds(useId());
  return (
    <section className="decision-card" aria-label="Approval waiting on you" aria-describedby={describedBy(ids.from, ids.question, approval.description && ids.context, command && ids.command)} tabIndex={-1}>
      <NeedsYouHead id={ids.from} thread={thread} position={position} onStep={onStep} onSelect={onSelect} />
      <div className="decision-body">
        <p className="decision-question" id={ids.question}>{approval.title}</p>
        {approval.description && <p className="decision-context" id={ids.context}>{approval.description}</p>}
        {command
          ? <pre className="decision-command" id={ids.command}>{command}</pre>
          : <details className="decision-tool"><summary>{approval.toolName}</summary><pre>{JSON.stringify(approval.input, null, 2)}</pre></details>}
      </div>
      <div className="decision-foot">
        {position && <button type="button" className="secondary" data-action="later" onClick={() => onStep(1)}>Later</button>}
        <span className="decision-foot-gap" />
        <DecideButton label="Deny" binding={bindings.deny} secondary onDecide={() => onDecide(approval, false)} />
        <DecideButton label="Allow once" binding={bindings.allow} onDecide={() => onDecide(approval, true)} />
      </div>
    </section>
  );
}

/** A question a thread under the coordinator asked, whose answer stays on the card through paging away and back. */
function DecisionForm({ view, draft, position, onStep, onDraft, onAnswer, onSelect }: {
  view: CoordinationDecisionView;
  draft: DecisionDraft | null;
  position: Pager;
  onStep: (delta: 1 | -1) => void;
  onDraft: (draft: DecisionDraft) => void;
  onAnswer: (answer: string) => void;
  onSelect: (threadId: string) => void;
}) {
  const id = useId();
  const ids = pageIds(id);
  const { thread, decision } = view;
  const { choice, own } = draft ?? { choice: decision.options.find((option) => option.recommended)?.label ?? "", own: "" };
  const answer = own.trim() || choice;
  return (
    <form className="decision-card" aria-label="Decision waiting on you" aria-describedby={describedBy(ids.from, ids.question, decision.context && ids.context)} tabIndex={-1} onSubmit={(event) => {
      event.preventDefault();
      if (answer) onAnswer(answer);
    }}>
      <NeedsYouHead id={ids.from} thread={thread} position={position} onStep={onStep} onSelect={onSelect} />
      <div className="decision-body">
        <p className="decision-question" id={ids.question}>{decision.question}</p>
        {decision.context && <p className="decision-context" id={ids.context}>{decision.context}</p>}
        {decision.options.length > 0 && <div className={`decision-options${own.trim() ? " overridden" : ""}`} role="radiogroup" aria-labelledby={ids.question}>
          {decision.options.map((option) => (
            <label className="decision-option" key={option.label}>
              <input type="radio" name={id} value={option.label} checked={!own.trim() && choice === option.label} onChange={() => onDraft({ kind: "decision", choice: option.label, own: "" })} />
              <span>
                <span className="decision-option-label">{option.label}{option.recommended && <span className="decision-recommended">Recommended</span>}</span>
                {option.description && <span className="decision-option-description">{option.description}</span>}
              </span>
            </label>
          ))}
        </div>}
      </div>
      <div className="decision-foot">
        <label className="decision-own">
          <span>{decision.options.length ? "Or your own answer" : "Your answer"}</span>
          <input value={own} placeholder="Type your answer…" onChange={(event) => onDraft({ kind: "decision", choice, own: event.currentTarget.value })} />
        </label>
        {position && <button type="button" className="secondary" data-action="later" onClick={() => onStep(1)}>Later</button>}
        <button type="submit" disabled={!answer}>Decide<kbd aria-hidden="true">{displayShortcut("Enter", MAC)}</kbd></button>
      </div>
    </form>
  );
}
