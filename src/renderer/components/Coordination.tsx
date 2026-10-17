import { createContext, memo, useContext, useId, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent } from "react";
import { LuArrowUp as ArrowUp, LuArrowUpRight as ArrowUpRight, LuCheck as Check, LuChevronDown as ChevronDown, LuChevronUp as ChevronUp, LuFolderOpen as FolderOpen, LuFolderSymlink as FolderSymlink, LuRotateCcw as Reopen, LuTrash2 as Trash, LuX as X } from "react-icons/lu";
import { deliveryLabel, MAX_MEMORY_NOTE, MAX_PURPOSE, nextStepOf, OVERVIEW_GROUPS, type MemoryNote, type OverviewFold, type OverviewFolds, type OverviewGroup, type OverviewSection, type ThreadBrief, type ThreadModelChoice } from "../../domain/coordination";
import { engineForModel, modelDelegable, modelsFor, type AgentEngine, type AgentModel, type EngineReadiness } from "../../domain/agent-engine";
import type { AgentEffort } from "../../domain/run";
import type { Thread } from "../../domain/thread";
import { worktreeHue, worktreeName, type Worktree } from "../../domain/worktree";
import { canResolve, overviewGroups, pullRequestLine, type CoordinationApprovalView, type CoordinationDecisionView, type CoordinatedThreadStatus, type CoordinatedThreadView, type CoordinatorMemoryView, type ProposalView } from "../../application/coordination";
import type { ApprovalView } from "../../application/thread-run-state";
import type { WorktreeGroup } from "../../application/workspace-state";
import type { MemberWorktree } from "../../application/member-worktrees";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { CommandButton, CommandGate } from "./CommandControl";
import { EffortMenu, ModelMenu } from "./ComposerSettings";
import { useMessageLinks, WebLink } from "./MarkdownMessage";
import { PULL_REQUEST_ICONS } from "./SessionPanel";
import { MAC } from "../platform";
import "./coordination.css";

const STATUS_LABELS: Record<CoordinatedThreadStatus, string> = {
  approval: "Needs approval",
  asking: "Needs you",
  working: "Working",
  resolved: "Resolved",
  blocked: "Blocked",
  failed: "Failed",
  review: "Ready for review",
  done: "Done",
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

const OVERVIEW_LABELS: Record<OverviewGroup, string> = { needs: "Needs you", review: "Ready for review", working: "Working", done: "Done", resolved: "Resolved" };

/** What the Overview's header needs to pick what a coordinator's threads run on, with the same readiness the composer shows. */
export type OverviewHeaderProps = {
  taskId: string;
  threadModel: ThreadModelChoice;
  engineAccess: Record<AgentEngine, EngineReadiness>;
  favoriteModels?: AgentModel[];
  onModelFavorite?: (model: AgentModel, favorite: boolean) => void;
  onSetThreadModel: (model: AgentModel, effort?: AgentEffort) => void;
  onEngineRead: () => void;
  onSignIn: (engine: AgentEngine) => void;
  onOpenEngineSettings?: () => void;
};

/** What the Overview shows of a coordinator's memory, and the edits the user makes to it. */
export type OverviewMemoryProps = CoordinatorMemoryView & {
  taskId: string;
  onSetPurpose: (purpose: string | null) => void;
  onAdd: (text: string) => void;
  onEdit: (noteId: string, text: string) => void;
  onForget: (noteId: string) => void;
};

type FoldChange = (section: OverviewSection, change: { open?: boolean; all?: boolean }) => void;

/** What a thread's row does beside opening it: resolve it once nothing waits on it, or reopen it. */
type RowActions = {
  onSelect: (threadId: string) => void;
  onResolve: (threadId: string) => void;
  onReopen: (threadId: string) => void;
};

/** A coordinator's purpose, what its threads run on, its threads by what they need from the user, then its memory. */
export function CoordinatorOverview({ header, memory, members, worktreeGroups, folds, onSetFold, onSelect, onResolve, onReopen }: RowActions & {
  header: OverviewHeaderProps;
  memory: OverviewMemoryProps;
  members: readonly CoordinatedThreadView[];
  worktreeGroups: WorktreeGroup[];
  folds: OverviewFolds;
  onSetFold: FoldChange;
}) {
  const worktrees = new Map(worktreeGroups.map(({ worktree }) => [worktree.id, worktree]));
  const groups = overviewGroups(members);
  return (
    <div className="coordination-overview" aria-label="Threads under this coordinator">
      <CommandGate command={{ type: "memory.set-purpose", taskId: memory.taskId, purpose: memory.purpose }}>
        <PurposeLine purpose={memory.purpose} onSave={memory.onSetPurpose} />
      </CommandGate>
      <OverviewHeader {...header} />
      {members.length
        ? OVERVIEW_GROUPS.map((group) => groups[group].length > 0 && (
            <ThreadGroup key={group} group={group} members={groups[group]} fold={folds[group] ?? {}} worktrees={worktrees} onSetFold={onSetFold} onSelect={onSelect} onResolve={onResolve} onReopen={onReopen} />
          ))
        : <p className="session-empty coordination-empty">No threads yet</p>}
      <CommandGate command={{ type: "memory.add", taskId: memory.taskId, text: "" }}>
        <MemorySection memory={memory} fold={folds.memory ?? {}} onSetFold={onSetFold} />
      </CommandGate>
    </div>
  );
}

/**
 * Text edited where it is read: a click turns it into a field, Enter or leaving it saves, and Esc
 * puts it back as it was. A `multiline` one wraps as it is read rather than scrolling sideways, and
 * Enter still saves it.
 */
function InlineEdit({ value, label, placeholder, className, maxLength, multiline = false, onSave }: {
  value: string;
  label: string;
  placeholder?: string;
  className: string;
  maxLength: number;
  multiline?: boolean;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /** Set once the edit is saved or put back, so the field leaving the page cannot save it a second time. */
  const settled = useRef(false);
  if (draft === null) {
    return (
      <button type="button" className={className} aria-label={`Edit ${label}`} title={value || undefined} onClick={() => { settled.current = false; setDraft(value); }}>
        {value || <span className="coordination-placeholder">{placeholder}</span>}
      </button>
    );
  }
  const finish = (text: string | null) => {
    if (settled.current) return;
    settled.current = true;
    if (text !== null && text.trim() !== value) onSave(text.trim());
    setDraft(null);
  };
  const field = {
    className: `${className} editing`,
    "aria-label": label,
    value: draft,
    placeholder,
    maxLength,
    autoFocus: true,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (!settled.current) setDraft(event.currentTarget.value); },
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => finish(event.currentTarget.value),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); finish(event.currentTarget.value); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(null); }
    },
  };
  return multiline ? <textarea rows={1} {...field} /> : <input {...field} />;
}

/** What the coordinator is for, in one line. Saving it empty takes it off. */
function PurposeLine({ purpose, onSave }: { purpose: string | null; onSave: (purpose: string | null) => void }) {
  return <InlineEdit value={purpose ?? ""} label="Purpose" placeholder="Add a purpose" className="coordination-purpose" maxLength={MAX_PURPOSE} onSave={(text) => onSave(text || null)} />;
}

/** The notes the coordinator keeps, each edited in place, with a last row that adds one. */
function MemorySection({ memory, fold, onSetFold }: { memory: OverviewMemoryProps; fold: OverviewFold; onSetFold: FoldChange }) {
  const open = fold.open ?? true;
  return (
    <section className="coordination-group coordination-memory" aria-label="Memory">
      <FoldHead label="Memory" count={memory.notes.length} open={open} onToggle={() => onSetFold("memory", { open: !open })} />
      {open && <div className="subagent-list">
        {memory.notes.map((note) => (
          <div key={note.id} className="coordination-note">
            {/** A note emptied while editing is left as it was; Forget is how one goes. */}
            <InlineEdit value={note.text} label="Note" className="coordination-note-text" maxLength={MAX_MEMORY_NOTE} multiline onSave={(text) => { if (text) memory.onEdit(note.id, text); }} />
            <CommandButton
              command={{ type: "memory.forget", taskId: memory.taskId, noteId: note.id }}
              className="coordination-note-forget"
              aria-label="Forget"
              title="Forget"
              onClick={() => memory.onForget(note.id)}
            >
              <X size={12} aria-hidden="true" />
            </CommandButton>
          </div>
        ))}
        <NoteInput notes={memory.notes} onAdd={memory.onAdd} />
      </div>}
    </section>
  );
}

/**
 * The row that adds a note. What was typed stays until the note it sent shows up in memory, so a
 * refused one, as when memory is full, is still there to change once the user has made room.
 */
function NoteInput({ notes, onAdd }: { notes: readonly MemoryNote[]; onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  /** The note last sent, and the notes memory held when it was, so a note it already held does not count as saved. */
  const [sent, setSent] = useState<{ text: string; held: ReadonlySet<string> } | null>(null);
  if (sent && notes.some((note) => note.text === sent.text && !sent.held.has(note.id))) {
    setSent(null);
    if (text.trim() === sent.text) setText("");
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const typed = event.currentTarget.value.trim();
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!typed) return;
      setSent({ text: typed, held: new Set(notes.map((note) => note.id)) });
      onAdd(typed);
    }
    if (event.key === "Escape" && event.currentTarget.value) { event.preventDefault(); event.stopPropagation(); setText(""); }
  };
  return <textarea rows={1} className="coordination-note-add" aria-label="Add a note" placeholder="Add a note" maxLength={MAX_MEMORY_NOTE} value={text} onChange={(event) => setText(event.currentTarget.value)} onKeyDown={onKeyDown} />;
}

/** The head of a section that folds: its label and how many rows it holds. */
function FoldHead({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="coordination-group-head" aria-expanded={open} onClick={onToggle}>
      <ChevronDown size={13} aria-hidden="true" />
      <span>{label}</span>
      <span className="coordination-group-count">{count}</span>
    </button>
  );
}

/** What the coordinator's new threads run on, picked with the composer's own chips. */
export function OverviewHeader({ taskId, threadModel, engineAccess, favoriteModels, onModelFavorite, onSetThreadModel, onEngineRead, onSignIn, onOpenEngineSettings }: OverviewHeaderProps) {
  const { model, effort } = threadModel;
  return (
    <div className="coordination-overview-header">
      <span className="coordination-overview-label">Threads run on</span>
      <CommandGate command={{ type: "coordination.set-thread-model", taskId, model, ...(effort ? { effort } : {}) }}>
        <div className="coordination-thread-model">
          <ModelMenu
            engine={engineForModel(model)}
            engineLocked={false}
            engineAccess={engineAccess}
            model={model}
            models={modelDelegable}
            favoriteModels={favoriteModels}
            onModelFavorite={onModelFavorite}
            onChange={(_engine, next) => onSetThreadModel(next)}
            onOpen={onEngineRead}
            onSignIn={onSignIn}
            {...(onOpenEngineSettings ? { onOpenEngineSettings } : {})}
          />
          {effort && <EffortMenu model={model} effort={effort} heading="How hard should its threads think?" onChange={(next) => onSetThreadModel(model, next)} />}
        </div>
      </CommandGate>
    </div>
  );
}

/** One group of threads. Resolved starts folded, and Done once it is longer than a group shows. */
function ThreadGroup({ group, members, fold, worktrees, onSetFold, ...actions }: RowActions & {
  group: OverviewGroup;
  members: readonly CoordinatedThreadView[];
  fold: OverviewFold;
  worktrees: Map<string, Worktree>;
  onSetFold: FoldChange;
}) {
  const open = fold.open ?? (group === "resolved" ? false : group !== "done" || members.length <= OVERVIEW_LIMIT);
  const label = OVERVIEW_LABELS[group];
  const shown = fold.all ? members : members.slice(0, OVERVIEW_LIMIT);
  return (
    <section className={`coordination-group ${group}`} aria-label={label}>
      <FoldHead label={label} count={members.length} open={open} onToggle={() => onSetFold(group, { open: !open })} />
      {open && <div className="subagent-list" aria-live="polite">
        {shown.map((view) => <ThreadRow key={view.thread.id} view={view} worktrees={worktrees} {...actions} />)}
        {members.length > shown.length && (
          <button type="button" className="coordination-more" onClick={() => onSetFold(group, { all: true })}>Show {members.length - shown.length} more</button>
        )}
      </div>}
    </section>
  );
}

/** One thread under the coordinator: a button that opens it, and beside it, never inside, what else its row does. */
function ThreadRow({ view: { thread, status, summary }, worktrees, onSelect, onResolve, onReopen }: RowActions & { view: CoordinatedThreadView; worktrees: Map<string, Worktree> }) {
  return (
    <div className={`coordination-item ${status}`}>
      <button
        type="button"
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
      <ResolutionButton taskId={thread.id} title={thread.title} status={status} className="coordination-row-action" onResolve={onResolve} onReopen={onReopen} />
    </div>
  );
}

/**
 * Resolves a thread with nothing left waiting on it, or reopens a resolved one; nothing for a thread
 * that is working or waiting on the user.
 */
export function ResolutionButton({ taskId, title, status, className, size = 13, onResolve, onReopen }: {
  taskId: string;
  title: string;
  status: CoordinatedThreadStatus;
  className: string;
  size?: number;
  onResolve: (taskId: string) => void;
  onReopen: (taskId: string) => void;
}) {
  if (status === "resolved") {
    return (
      <CommandButton command={{ type: "task.reopen", taskId }} className={className} data-action="reopen" aria-label={`Reopen ${title}`} title="Reopen" onClick={() => onReopen(taskId)}>
        <Reopen size={size} aria-hidden="true" />
      </CommandButton>
    );
  }
  if (!canResolve(status)) return null;
  return (
    <CommandButton command={{ type: "task.resolve", taskId }} className={className} data-action="resolve" aria-label={`Resolve ${title}`} title="Resolve" onClick={() => onResolve(taskId)}>
      <Check size={size} aria-hidden="true" />
    </CommandButton>
  );
}

/** What a coordinator's conversation draws its threads' cards from, and what a card does. */
export type ThreadCardsView = {
  cards: ReadonlyMap<string, CoordinatedThreadView>;
  worktrees: ReadonlyMap<string, Worktree>;
  onSelect: (threadId: string) => void;
};

/** Held by the coordinator's own transcript, so only its rows of cards redraw when one of its threads moves. */
export const ThreadCardsContext = createContext<ThreadCardsView | null>(null);

/** The threads a coordinator started together, side by side where they began in its conversation. */
export function ThreadCards({ threadIds }: { threadIds: readonly string[] }) {
  const shown = useContext(ThreadCardsContext);
  const views = shown ? threadIds.flatMap((id) => shown.cards.get(id) ?? []) : [];
  if (!shown || !views.length) return null;
  return (
    <div className="coordination-cards" role="list" aria-label={views.length === 1 ? "Thread started here" : "Threads started here"}>
      {views.map((view) => (
        <ThreadCard
          key={view.thread.id}
          view={view}
          worktree={view.thread.worktreeId ? shown.worktrees.get(view.thread.worktreeId) : undefined}
          onSelect={shown.onSelect}
        />
      ))}
    </div>
  );
}

/**
 * One thread as it stands, in the marks and colours of its Overview row. The card opens the thread,
 * and its next steps sit beside that, never inside it.
 */
const ThreadCard = memo(function ThreadCard({ view, worktree, onSelect }: {
  view: CoordinatedThreadView;
  worktree: Worktree | undefined;
  onSelect: (threadId: string) => void;
}) {
  const links = useMessageLinks();
  const { thread, status, summary, pullRequest, steps } = view;
  /** A thread ready for review is summed up by its pull request, which the card shows on its own. */
  const line = coordinationStatusLine(status, pullRequest && status === "review" ? null : summary);
  const Icon = pullRequest ? PULL_REQUEST_ICONS[pullRequest.state] : null;
  return (
    <div className={`coordination-card ${status}`} role="listitem">
      <button type="button" className="coordination-card-open" aria-label={`Open ${thread.title}`} title={thread.title} onClick={() => onSelect(thread.id)}>
        <span className="coordination-card-head">
          <span className="coordination-row-mark"><CoordinationStatusMark status={status} /></span>
          <strong>{thread.title}</strong>
          <span className="coordination-row-marks">
            {thread.worktreeId && <WorktreeMark worktreeId={thread.worktreeId} worktree={worktree} />}
            <ThreadEngineIcon engine={thread.engine} className="coordination-row-engine" size={12} />
          </span>
        </span>
        <small className={status === "working" ? "text-sweep" : undefined} title={line}>{line}</small>
        {pullRequest && Icon && (
          <span className="coordination-card-pull-request" data-state={pullRequest.state}>
            <Icon size={11} aria-hidden="true" />
            {pullRequestLine(pullRequest)}
          </span>
        )}
      </button>
      {(steps.length > 0 || pullRequest) && (
        <div className="coordination-card-steps">
          {steps.map((step) => (
            <CommandButton key={step} type="button" className="coordination-card-step" command={{ type: "coordination.next-step", taskId: thread.id, step }}>
              {nextStepOf(step).label}
            </CommandButton>
          ))}
          {pullRequest && (
            <WebLink
              className="coordination-card-step"
              href={pullRequest.url}
              title={`#${pullRequest.number} ${pullRequest.title}`}
              openInApp={links.openUrlInApp && (() => links.openUrlInApp!(pullRequest.url))}
            >
              Review PR
              <ArrowUpRight size={12} aria-hidden="true" />
            </WebLink>
          )}
        </div>
      )}
    </div>
  );
});

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

/** The threads a coordinator suggested, with what its threads run on so a suggestion naming another model can say so. */
export type SuggestionsProps = {
  taskId: string;
  threadModel: ThreadModelChoice | null;
  proposals: readonly ProposalView[];
};

/** One page of the card. Every kind of thing that waits on the user is a page of its own. */
type NeedsYouItem =
  | { kind: "approval"; view: CoordinationApprovalView }
  | { kind: "decision"; view: CoordinationDecisionView }
  | { kind: "suggestions"; suggestions: SuggestionsProps };

type Pager = { index: number; count: number } | null;

/**
 * Everything waiting on the user from a coordinator and its threads, one page at a time: approvals,
 * decisions, then the threads it suggested.
 */
export function NeedsYouCard({ approvals, decisions, suggestions = null, onDecide, onAnswer, onSelect }: {
  approvals: CoordinationApprovalView[];
  decisions: CoordinationDecisionView[];
  suggestions?: SuggestionsProps | null;
  onDecide: (approval: Pick<ApprovalView, "taskId" | "runId" | "approvalId">, allow: boolean) => void;
  onAnswer: (threadId: string, decisionId: string, answer: string) => void;
  onSelect: (threadId: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const items: NeedsYouItem[] = [
    ...approvals.map((view) => ({ kind: "approval" as const, view })),
    ...decisions.map((view) => ({ kind: "decision" as const, view })),
    ...(suggestions?.proposals.length ? [{ kind: "suggestions" as const, suggestions }] : []),
  ];
  const shown = Math.min(index, items.length - 1);
  const current = items[shown];
  if (!current) return null;
  const position = items.length > 1 ? { index: shown, count: items.length } : null;
  const onStep = (delta: 1 | -1) => setIndex((shown + delta + items.length) % items.length);
  switch (current.kind) {
    case "approval":
      return <ApprovalForm key={current.view.approval.approvalId} view={current.view} position={position} onStep={onStep} onDecide={onDecide} onSelect={onSelect} />;
    case "decision":
      return <DecisionForm
        key={current.view.decision.id}
        view={current.view}
        position={position}
        onStep={onStep}
        onAnswer={(answer) => onAnswer(current.view.thread.id, current.view.decision.id, answer)}
        onSelect={onSelect}
      />;
    case "suggestions":
      return <SuggestionsForm suggestions={current.suggestions} position={position} onStep={onStep} />;
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

function modelName(model: AgentModel): string {
  return modelsFor(engineForModel(model)).find((spec) => spec.id === model)?.label ?? model;
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
        <small title={proposal.brief.intent}>{proposal.brief.intent}</small>
        {proposal.error && !starting && <small className="suggestion-error" role="alert">{proposal.error}</small>}
      </span>
      {model && <span className="suggestion-chip">{modelName(model)}</span>}
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
