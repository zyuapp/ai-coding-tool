import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { LuArrowUpRight as ArrowUpRight, LuCheck as Check, LuChevronDown as ChevronDown, LuCircleCheck as Resolved, LuFolderOpen as FolderOpen, LuFolderSymlink as FolderSymlink, LuPencil as Pencil, LuTrash2 as Trash, LuUndo2 as Reopen, LuX as X } from "react-icons/lu";
import { deliveryLabel, MAX_MEMORY_NOTE, MAX_MEMORY_NOTES, MAX_PURPOSE, nextStepOf, OVERVIEW_GROUPS, type MemoryNote, type OverviewFold, type OverviewFolds, type OverviewGroup, type OverviewSection, type ThreadBrief, type ThreadModelChoice } from "../../domain/coordination";
import { modelDelegable, modelEngine, modelLabel, type AgentEngine, type AgentModel, type EngineReadiness } from "../../domain/agent-engine";
import type { AgentEffort } from "../../domain/run";
import { worktreeHue, worktreeName, type Worktree } from "../../domain/worktree";
import type { PullRequestState } from "../../domain/pull-request";
import type { Thread } from "../../domain/thread";
import { canResolve, pullRequestLine, type CoordinatedThreadStatus } from "../../application/coordination";
import { overviewGroups, type CoordinationUsage, type CoordinatedThreadView, type CoordinationView, type CoordinatorMemoryView } from "../../application/coordination-view";
import type { ThreadHost } from "../../application/computers";
import type { MemberWorktree } from "../../application/member-worktrees";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { CommandButton, CommandGate, useCommandControls } from "./CommandControl";
import { compactTokens } from "./ContextUsageMeter";
import { ModelMenu } from "./ComposerSettings";
import { HostMark } from "./HostMark";
import { useMessageLinks, WebLink } from "./MarkdownMessage";
import { PULL_REQUEST_ICONS } from "./SessionPanel";
import { MAC } from "../platform";
import { ConfirmAction } from "./SettingRow";
import { REMOTE_UNSUPPORTED } from "../../contracts/computer-capabilities";
import { placeOf, useKeyboardPlace } from "../focus";
import "./coordination.css";

const STATUS_LABELS: Record<CoordinatedThreadStatus, string> = {
  approval: "Needs approval",
  asking: "Needs you",
  working: "Working",
  resolved: "Resolved",
  blocked: "Blocked",
  failed: "Failed",
  "needs-work": "Needs work",
  review: "Ready for review",
  done: "Done",
  idle: "Idle",
};

/** A thread working as a computer out of reach last said spins no more, since nothing says it still is. */
export function CoordinationStatusMark({ status, lastHeard = false }: { status: CoordinatedThreadStatus; lastHeard?: boolean }) {
  return status === "working" && !lastHeard
    ? <span className="task-spinner" aria-hidden="true" />
    : <span className={`coordination-dot ${status}`} aria-hidden="true" />;
}

export function coordinationStatusLine(status: CoordinatedThreadStatus, summary: string | null, lastHeard = false) {
  const label = lastHeard ? `${STATUS_LABELS[status]} when last heard` : STATUS_LABELS[status];
  return summary ? `${label} · ${summary}` : label;
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
};

type FoldChange = (section: OverviewSection, change: { open?: boolean; all?: boolean }) => void;

/** What a thread's row does when it is opened; resolving and reopening it are commands of their own. */
type RowActions = {
  onSelect: (threadId: string) => void;
};

/** A coordinator's purpose, what its threads run on, its threads by what they need from the user, its memory, then what it all spent. */
export function CoordinatorOverview({ header, memory, members, usage, worktrees, folds, onSetFold, stoppable, onSelect }: RowActions & {
  header: OverviewHeaderProps;
  memory: OverviewMemoryProps;
  members: readonly CoordinatedThreadView[];
  /** Null until the coordinator or a thread under it has spent anything. */
  usage: CoordinationUsage | null;
  /** Held while no checkout changes, so a row whose thread did not move draws nothing anew. */
  worktrees: ReadonlyMap<string, Worktree>;
  folds: OverviewFolds;
  onSetFold: FoldChange;
  /** Whether Stop all has anything under the coordinator to stop. */
  stoppable: boolean;
}) {
  const groups = useMemo(() => overviewGroups(members), [members]);
  const overview = useRef<HTMLDivElement>(null);
  const keepPlace = useKeyboardPlace(overview, rememberOverviewPlace, (place, root) => overviewFocus(place, root, groups));
  return (
    <div ref={overview} className="coordination-overview" role="region" aria-label="Threads under this coordinator" onClickCapture={keepPlace}>
      <CommandGate command={{ type: "memory.set-purpose", taskId: memory.taskId, purpose: memory.purpose }}>
        <PurposeLine purpose={memory.purpose} onSave={memory.onSetPurpose} />
      </CommandGate>
      <OverviewHeader {...header} />
      {members.length
        ? OVERVIEW_GROUPS.map((group) => groups[group].length > 0 && (
            <ThreadGroup key={group} group={group} members={groups[group]} fold={folds[group] ?? {}} worktrees={worktrees} onSetFold={onSetFold} onSelect={onSelect}
              {...(group === "working" ? { action: <StopAllButton taskId={header.taskId} stoppable={stoppable} /> } : {})} />
          ))
        : <p className="session-empty coordination-empty">No threads yet</p>}
      <CommandGate command={{ type: "memory.add", taskId: memory.taskId, text: "" }}>
        <MemorySection memory={memory} fold={folds.memory ?? {}} onSetFold={onSetFold} />
      </CommandGate>
      {usage && <UsageSection usage={usage} fold={folds.usage ?? {}} onSetFold={onSetFold} onSelect={onSelect} />}
    </div>
  );
}

/**
 * What the user last pressed in the Overview that takes itself off the page: a row's Resolve or
 * Reopen, a Show more, Stop all once nothing under it works, or a note's Forget.
 */
type OverviewPlace =
  | { kind: "row"; threadId: string; section: string; index: number }
  | { kind: "more"; section: string; index: number }
  | { kind: "less"; section: string }
  | { kind: "stop"; index: number }
  | { kind: "note"; index: number };

/** The buttons a section's rows open with, in the order they are drawn. */
function sectionRows(section: Element | null | undefined): HTMLElement[] {
  return section ? [...section.querySelectorAll<HTMLElement>(".coordination-row, .coordination-usage-thread")] : [];
}

/** The fold buttons that head the Overview's groups of threads, in the order they are drawn. */
function groupHeads(root: HTMLElement): HTMLElement[] {
  return OVERVIEW_GROUPS.flatMap((group) => root.querySelector<HTMLElement>(`[data-section="${group}"] .coordination-group-head`) ?? []);
}

function rememberOverviewPlace(pressed: HTMLElement, root: HTMLElement): OverviewPlace | null {
  if (pressed.matches(".coordination-note-actions > .danger")) return { kind: "note", index: [...root.querySelectorAll(".coordination-note-actions")].indexOf(pressed.parentElement!) };
  const section = pressed.closest<HTMLElement>("[data-section]");
  if (!section) return null;
  if (pressed.matches(".coordination-stop > .armed")) return { kind: "stop", index: groupHeads(root).indexOf(section.querySelector<HTMLElement>(".coordination-group-head")!) };
  const rows = sectionRows(section);
  if (pressed.matches('.coordination-more[aria-expanded="true"]')) return { kind: "less", section: section.dataset.section! };
  if (pressed.matches(".coordination-more")) return { kind: "more", section: section.dataset.section!, index: rows.length };
  if (!pressed.matches('[data-action="resolve"], [data-action="reopen"]')) return null;
  const item = pressed.closest<HTMLElement>("[data-thread-id]");
  const opens = item?.querySelector<HTMLElement>(".coordination-row");
  return item && opens ? { kind: "row", threadId: item.dataset.threadId!, section: section.dataset.section!, index: rows.indexOf(opens) } : null;
}

/**
 * Where the keyboard goes in the Overview once what it pressed is gone. A resolved or reopened row
 * hands focus to the row that took its place, else the one before it, else its own row or the head of
 * the group it went to; a Show more to the first row it brought in, and a Show less to the Show more that replaced it; Stop all, once the Working group
 * is gone, to the head of the group that took its place; a forgotten note to the one that took its
 * place, or to the row that adds one.
 */
function overviewFocus(place: OverviewPlace, root: HTMLElement, groups: Record<OverviewGroup, readonly CoordinatedThreadView[]>): HTMLElement | null | undefined {
  if (place.kind === "note") return root.querySelectorAll<HTMLElement>(".coordination-note-text")[place.index] ?? root.querySelector<HTMLElement>(".coordination-note-add");
  if (place.kind === "stop") return placeOf(groupHeads(root), place.index) ?? root.querySelector<HTMLElement>(".coordination-group-head");
  const section = root.querySelector(`[data-section="${place.section}"]`);
  if (place.kind === "less") return section?.querySelector<HTMLElement>(".coordination-more") ?? section?.querySelector<HTMLElement>(".coordination-group-head");
  const rows = sectionRows(section);
  if (place.kind === "more") return rows[place.index] ?? rows.at(-1);
  const went = OVERVIEW_GROUPS.find((group) => groups[group].some((view) => view.thread.id === place.threadId));
  const own = root.querySelector<HTMLElement>(`[data-thread-id="${place.threadId}"] .coordination-row`);
  const head = went ? root.querySelector<HTMLElement>(`[data-section="${went}"] .coordination-group-head`) : null;
  return placeOf(rows, place.index) ?? own ?? head;
}

/**
 * Text edited where it is read: a click turns it into a field, Enter or leaving it saves, and Esc
 * puts it back as it was. A `multiline` one wraps as it is read and takes Shift+Enter as a new line.
 * A `required` one emptied is marked invalid and is not saved: Enter keeps it open, leaving it puts
 * the text back.
 */
function InlineEdit({ value, label, placeholder, className, maxLength, multiline = false, required = false, editIcon = false, onSave }: {
  value: string;
  label: string;
  placeholder?: string;
  className: string;
  maxLength: number;
  multiline?: boolean;
  required?: boolean;
  /** Marks the text as editable with a pencil while pointed at or focused. */
  editIcon?: boolean;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /** Set once the edit is saved or put back, so the field leaving the page cannot save it a second time. */
  const settled = useRef(false);
  /** The text as the edit found it, so leaving it untouched saves nothing even if the coordinator has changed the text since. */
  const opened = useRef("");
  /** An edit the keyboard ended hands focus back to what was edited; one ended by leaving the field leaves it where it went. */
  const refocus = useRef(false);
  const reading = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (draft !== null || !refocus.current) return;
    refocus.current = false;
    reading.current?.focus();
  }, [draft]);
  if (draft === null) {
    return (
      <button ref={reading} type="button" className={className} aria-label={value ? `Edit ${label.toLowerCase()}: ${value}` : placeholder ?? `Edit ${label.toLowerCase()}`} data-tip={value || undefined} data-tip-overflow onClick={() => { settled.current = false; opened.current = value; setDraft(value); }}>
        {value ? <span>{value}</span> : <span className="coordination-placeholder">{placeholder}</span>}
        {editIcon && <Pencil className="coordination-purpose-edit" size={12} aria-hidden="true" />}
      </button>
    );
  }
  const finish = (text: string | null) => {
    if (settled.current) return;
    settled.current = true;
    const saved = text?.trim();
    if (saved !== undefined && (saved || !required) && saved !== opened.current && saved !== value) onSave(saved);
    setDraft(null);
  };
  const empty = required && !draft.trim();
  const field = {
    className: `${className} editing`,
    "aria-label": label,
    "aria-invalid": empty || undefined,
    value: draft,
    placeholder,
    maxLength,
    autoFocus: true,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (!settled.current) setDraft(event.currentTarget.value); },
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => finish(event.currentTarget.value),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.nativeEvent.isComposing && !(multiline && event.shiftKey)) {
        event.preventDefault();
        if (required && !event.currentTarget.value.trim()) return;
        refocus.current = true;
        finish(event.currentTarget.value);
      }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); refocus.current = true; finish(null); }
    },
  };
  return multiline ? <textarea rows={1} {...field} /> : <input {...field} />;
}

/** What the coordinator is for, in one line. Saving it empty takes it off. */
function PurposeLine({ purpose, onSave }: { purpose: string | null; onSave: (purpose: string | null) => void }) {
  return <InlineEdit value={purpose ?? ""} label="Purpose" placeholder="Add a purpose" className="coordination-purpose" maxLength={MAX_PURPOSE} editIcon onSave={(text) => onSave(text || null)} />;
}

/** How much of a note names the button that forgets it. */
const NOTE_NAME = 60;

/** A note named in a few words where its whole text would be read twice, as beside the button that edits it. */
function noteName(text: string): string {
  const line = text.trim().split("\n", 1)[0]!;
  return line.length > NOTE_NAME ? `${line.slice(0, NOTE_NAME - 1).trimEnd()}…` : line;
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
            {/** Forget is how a note goes, so one emptied while editing is not saved. */}
            <InlineEdit value={note.text} label="Note" className="coordination-note-text" maxLength={MAX_MEMORY_NOTE} multiline required onSave={(text) => memory.onEdit(note.id, text)} />
            <ForgetNote taskId={memory.taskId} note={note} />
          </div>
        ))}
        <NoteInput notes={memory.notes} onAdd={memory.onAdd} />
      </div>}
    </section>
  );
}

/** Forgets a note on the second press. */
function ForgetNote({ taskId, note }: { taskId: string; note: MemoryNote }) {
  const controls = useCommandControls();
  const command = { type: "memory.forget", taskId, noteId: note.id } as const;
  const unavailable = !controls.available(command);
  return (
    <span className="coordination-note-actions">
      <ConfirmAction className="coordination-note-forget" aria-label={`Forget note: ${noteName(note.text)}`} data-tip={unavailable ? REMOTE_UNSUPPORTED : "Forget"} disabled={unavailable}
        confirm="Forget" onConfirm={() => controls.dispatch(command)}>
        <X size={14} aria-hidden="true" />
      </ConfirmAction>
    </span>
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
  const full = notes.length >= MAX_MEMORY_NOTES;
  if (sent && notes.some((note) => note.text === sent.text && !sent.held.has(note.id))) {
    setSent(null);
    if (text.trim() === sent.text) setText("");
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const typed = event.currentTarget.value.trim();
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!typed) return;
      setSent({ text: typed, held: new Set(notes.map((note) => note.id)) });
      onAdd(typed);
    }
    if (event.key === "Escape" && event.currentTarget.value) { event.preventDefault(); event.stopPropagation(); setText(""); }
  };
  return (
    <div className="coordination-note">
      <textarea rows={1} className="coordination-note-add" aria-label="Add a note" placeholder={full ? "Memory is full" : "Add a note"} disabled={full} maxLength={MAX_MEMORY_NOTE} value={text} onChange={(event) => setText(event.currentTarget.value)} onKeyDown={onKeyDown} />
      {!full && <kbd className="coordination-note-hint" aria-hidden="true">↵ add</kbd>}
    </div>
  );
}

/**
 * The head of a section that folds: its label and how many rows it holds, or how much it adds up to,
 * and beside it, never inside, what else it does.
 */
function FoldHead({ label, count, title, open, action, onToggle }: { label: string; count: number | string; title?: string; open: boolean; action?: ReactNode; onToggle: () => void }) {
  const head = (
    <button type="button" className="coordination-group-head" aria-expanded={open} data-tip={title} onClick={onToggle}>
      <ChevronDown size={14} aria-hidden="true" />
      <span>{label}</span>
      <span className="coordination-group-count">{count}</span>
    </button>
  );
  return action ? <div className="coordination-group-heading">{head}{action}</div> : head;
}

function shareOf(tokens: number, total: number): number {
  return total ? tokens / total * 100 : 0;
}

/** What the coordinator and its threads spent: its own share, then by model and by thread. Folded until asked for. */
function UsageSection({ usage, fold, onSetFold, onSelect }: { usage: CoordinationUsage; fold: OverviewFold; onSetFold: FoldChange; onSelect: (threadId: string) => void }) {
  const open = fold.open ?? false;
  const { total, coordinator, byModel, byThread } = usage;
  const shown = fold.all ? byThread : byThread.slice(0, OVERVIEW_LIMIT);
  const own = shareOf(coordinator, total);
  const ownShare = `${own > 0 && own < 1 ? "<1" : Math.round(own)}%`;
  return (
    <section className="coordination-group coordination-usage" aria-label="Usage" data-section="usage">
      <FoldHead label="Usage" count={`${compactTokens(total)} · coordinator ${ownShare}`} title={`${total.toLocaleString("en-US")} tokens`} open={open} onToggle={() => onSetFold("usage", { open: !open })} />
      {open && <div className="coordination-usage-body">
        <p className="coordination-usage-own">This coordinator <strong>{compactTokens(coordinator)}</strong> · {ownShare}</p>
        <h4>By model</h4>
        {byModel.map(({ model, tokens }) => (
          <div key={model} className="coordination-usage-model" data-tip={`${tokens.toLocaleString("en-US")} tokens`}>
            <span>{modelLabel(model)}</span>
            <span className="coordination-usage-track" aria-hidden="true"><span className="coordination-usage-fill" style={{ width: `${shareOf(tokens, total)}%` }} /></span>
            <span className="coordination-usage-tokens">{compactTokens(tokens)}</span>
          </div>
        ))}
        {byThread.length > 0 && <>
          <h4>By thread</h4>
          {shown.map(({ thread, tokens }) => (
            <button key={thread.id} type="button" className="coordination-usage-thread" aria-label={`Open ${thread.title}`} data-tip={`${tokens.toLocaleString("en-US")} tokens`} onClick={() => onSelect(thread.id)}>
              <span>{thread.title}</span>
              <span className="coordination-usage-tokens">{compactTokens(tokens)}</span>
            </button>
          ))}
          {byThread.length > OVERVIEW_LIMIT && (
            <MoreToggle hidden={byThread.length - OVERVIEW_LIMIT} all={Boolean(fold.all)} onToggle={(all) => onSetFold("usage", { all })} />
          )}
        </>}
      </div>}
    </section>
  );
}

/** Shows a long list's rest, then folds it back; each is its own button, so the keyboard settles where the list changed. */
function MoreToggle({ hidden, all, onToggle }: { hidden: number; all: boolean; onToggle: (all: boolean) => void }) {
  return all
    ? <button key="less" type="button" className="coordination-more" aria-expanded="true" onClick={() => onToggle(false)}><ChevronDown size={14} aria-hidden="true" />Show less</button>
    : <button key="more" type="button" className="coordination-more" aria-expanded="false" onClick={() => onToggle(true)}><ChevronDown size={14} aria-hidden="true" />Show {hidden} more</button>;
}

/** Stops the coordinator and everything working under it on the second press. */
function StopAllButton({ taskId, stoppable }: { taskId: string; stoppable: boolean }) {
  const controls = useCommandControls();
  const command = { type: "coordination.stop-all", taskId } as const;
  const unavailable = !controls.available(command);
  return (
    <span className="coordination-stop">
      {unavailable || !stoppable
        ? <button type="button" className="coordination-stop-all danger" aria-disabled="true" data-tip={unavailable ? REMOTE_UNSUPPORTED : "Nothing here is running"}>Stop all</button>
        : <ConfirmAction className="coordination-stop-all danger" confirm="Stop all" onConfirm={() => controls.dispatch(command)}>Stop all</ConfirmAction>}
    </span>
  );
}

/** What the coordinator's new threads run on, picked with the composer's own chips. */
export function OverviewHeader({ taskId, threadModel, engineAccess, favoriteModels, onModelFavorite, onSetThreadModel, onEngineRead, onSignIn, onOpenEngineSettings }: OverviewHeaderProps) {
  const { model, effort } = threadModel;
  const engine = modelEngine(model);
  return (
    <div className="coordination-overview-header">
      <span className="coordination-overview-label">Threads run on</span>
      {/** A model this build does not know, as a newer computer may run, is named and left for that computer to change. */}
      {!engine && <span className="coordination-overview-model">{model}</span>}
      {engine && <CommandGate command={{ type: "coordination.set-thread-model", taskId, model, ...(effort ? { effort } : {}) }}>
        <div className="coordination-thread-model">
          <ModelMenu
            engine={engine}
            engineLocked={false}
            engineAccess={engineAccess}
            model={model}
            models={modelDelegable}
            favoriteModels={favoriteModels}
            onModelFavorite={onModelFavorite}
            onChange={(_engine, next) => onSetThreadModel(next)}
            onOpen={onEngineRead}
            onSignIn={onSignIn}
            {...(effort ? { effort: { value: effort, onChange: (next: AgentEffort) => onSetThreadModel(model, next) } } : {})}
            {...(onOpenEngineSettings ? { onOpenEngineSettings } : {})}
          />
        </div>
      </CommandGate>}
    </div>
  );
}

/** One group of threads. Resolved starts folded, and Done once it is longer than a group shows. */
function ThreadGroup({ group, members, fold, worktrees, action, onSetFold, ...actions }: RowActions & {
  group: OverviewGroup;
  members: readonly CoordinatedThreadView[];
  fold: OverviewFold;
  worktrees: ReadonlyMap<string, Worktree>;
  action?: ReactNode;
  onSetFold: FoldChange;
}) {
  const open = fold.open ?? (group === "resolved" ? false : group !== "done" || members.length <= OVERVIEW_LIMIT);
  const label = OVERVIEW_LABELS[group];
  const shown = fold.all ? members : members.slice(0, OVERVIEW_LIMIT);
  return (
    <section className={`coordination-group ${group}`} aria-label={label} data-section={group}>
      <FoldHead label={label} count={members.length} open={open} action={action} onToggle={() => onSetFold(group, { open: !open })} />
      {/** Only Needs you speaks, as only Priority does in the sidebar: a working thread's progress is not news to read out. */}
      {open && <div className="subagent-list" aria-live={group === "needs" ? "polite" : undefined}>
        {shown.map((view) => <ThreadRow key={view.thread.id} view={view} worktrees={worktrees} {...actions} />)}
        {members.length > OVERVIEW_LIMIT && (
          <MoreToggle hidden={members.length - OVERVIEW_LIMIT} all={Boolean(fold.all)} onToggle={(all) => onSetFold(group, { all })} />
        )}
      </div>}
    </section>
  );
}

/**
 * One thread under the coordinator: a button that opens it, and beside it, never inside, what else its
 * row does. Memoized on its view, which is held while its thread does not move.
 */
const ThreadRow = memo(function ThreadRow({ view: { thread, status, summary, host, lastHeard }, worktrees, onSelect }: RowActions & { view: CoordinatedThreadView; worktrees: ReadonlyMap<string, Worktree> }) {
  const line = coordinationStatusLine(status, summary, lastHeard);
  const lineId = useId();
  return (
    <div className={`coordination-item ${status}`} data-thread-id={thread.id}>
      <button
        type="button"
        className={`coordination-row ${status}`}
        aria-label={`Open ${thread.title}`}
        aria-describedby={lineId}
        title={thread.title}
        onClick={() => onSelect(thread.id)}
      >
        <span className="coordination-row-mark"><CoordinationStatusMark status={status} lastHeard={lastHeard} /></span>
        <span><strong>{thread.title}</strong><small id={lineId} title={line}>{line}</small></span>
        <ThreadMarks thread={thread} host={host} worktree={thread.worktreeId ? worktrees.get(thread.worktreeId) : undefined} />
      </button>
      <ResolutionButton taskId={thread.id} title={thread.title} status={status} className="coordination-row-action" />
    </div>
  );
});

/**
 * Resolves a thread with nothing left waiting on it, or reopens a resolved one; nothing for a thread
 * that is working or waiting on the user. A resolved thread's button reads as a ticked check, which
 * turns into an undo once pointed at, so reopening never looks like running it again. Its icon is
 * even-sized, as its buttons are, so it sits centred on whole pixels rather than a half one.
 */
export function ResolutionButton({ taskId, title, status, className, size = 14 }: {
  taskId: string;
  title: string;
  status: CoordinatedThreadStatus;
  className: string;
  size?: number;
}) {
  if (status === "resolved") {
    return (
      <CommandButton command={{ type: "task.reopen", taskId }} className={className} data-action="reopen" aria-label={`Reopen ${title}`} data-tip="Reopen">
        <Resolved className="resolution-ticked" size={size} aria-hidden="true" />
        <Reopen className="resolution-undo" size={size} aria-hidden="true" />
      </CommandButton>
    );
  }
  if (!canResolve(status)) return null;
  return (
    <CommandButton command={{ type: "task.resolve", taskId }} className={className} data-action="resolve" aria-label={`Resolve ${title}`} data-tip="Resolve">
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

/** A card whose next step the user pressed, which goes once its thread takes the step up. */
type CardPlace = { threadId: string; index: number };

function rememberCardPlace(pressed: HTMLElement, root: HTMLElement): CardPlace | null {
  const card = pressed.matches(".coordination-card-step") ? pressed.closest<HTMLElement>(".coordination-card") : null;
  return card ? { threadId: card.dataset.threadId!, index: [...root.children].indexOf(card) } : null;
}

/** A next step taken hands focus to its own card, or, once that card is gone, to the card that took its place. */
function cardFocus(place: CardPlace, root: HTMLElement): HTMLElement | null | undefined {
  const cards = [...root.children] as HTMLElement[];
  const card = cards.find((item) => item.dataset.threadId === place.threadId) ?? placeOf(cards, place.index);
  return card?.querySelector<HTMLElement>(".coordination-card-open");
}

/** The threads a coordinator started together, side by side where they began in its conversation. */
export function ThreadCards({ threadIds }: { threadIds: readonly string[] }) {
  const shown = useContext(ThreadCardsContext);
  const list = useRef<HTMLDivElement>(null);
  const keepPlace = useKeyboardPlace(list, rememberCardPlace, cardFocus);
  const views = shown ? threadIds.flatMap((id) => shown.cards.get(id) ?? []) : [];
  if (!shown || !views.length) return null;
  return (
    <div ref={list} className="coordination-cards" role="list" aria-label={views.length === 1 ? "Thread started here" : "Threads started here"} onClickCapture={keepPlace}>
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

/** A pull request that can still change is one to review; a merged or closed one is only there to read. */
const MOVING_PULL_REQUESTS: ReadonlySet<PullRequestState> = new Set(["open", "draft"]);

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
  const { thread, status, summary, pullRequest, steps, host, lastHeard } = view;
  /** A thread whose pull request needs work or a review is summed up by it, which the card shows on its own. */
  const line = coordinationStatusLine(status, pullRequest && (status === "needs-work" || status === "review") ? null : summary, lastHeard);
  const Icon = pullRequest ? PULL_REQUEST_ICONS[pullRequest.state] : null;
  const pullRequestText = pullRequest ? pullRequestLine(pullRequest) : null;
  const pullRequestAction = pullRequest && MOVING_PULL_REQUESTS.has(pullRequest.state) ? "Review PR" : "View PR";
  /** The card is read by its status line and, when it has one, its pull request's. */
  const lineId = useId();
  const pullRequestId = `${lineId}-pull-request`;
  return (
    <div className={`coordination-card ${status}`} role="listitem" data-thread-id={thread.id}>
      <button type="button" className="coordination-card-open" aria-label={`Open ${thread.title}`} aria-describedby={pullRequest ? `${lineId} ${pullRequestId}` : lineId} title={thread.title} onClick={() => onSelect(thread.id)}>
        <span className="coordination-card-head">
          <span className="coordination-row-mark"><CoordinationStatusMark status={status} lastHeard={lastHeard} /></span>
          <strong>{thread.title}</strong>
          <ThreadMarks thread={thread} host={host} worktree={worktree} />
        </span>
        <small id={lineId} className={status === "working" && !lastHeard ? "text-sweep" : undefined} title={line}>{line}</small>
        {pullRequest && Icon && (
          <span id={pullRequestId} className="coordination-card-pull-request" data-state={pullRequest.state} title={pullRequestText ?? undefined}>
            <Icon size={12} aria-hidden="true" />
            <span>{pullRequestText}</span>
          </span>
        )}
      </button>
      {(steps.length > 0 || pullRequest) && (
        <div className="coordination-card-steps">
          {steps.map((step) => (
            <CommandButton key={step} type="button" className="coordination-card-step" aria-label={nextStepOf(step).name(thread.title)} command={{ type: "coordination.next-step", taskId: thread.id, step }}>
              {nextStepOf(step).label}
            </CommandButton>
          ))}
          {pullRequest && (
            <WebLink
              className="coordination-card-step"
              href={pullRequest.url}
              title={`#${pullRequest.number} ${pullRequest.title}`}
              aria-label={`${pullRequestAction} for ${thread.title}`}
              openInApp={links.openUrlInApp && (() => links.openUrlInApp!(pullRequest.url))}
            >
              {pullRequestAction}
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
            <div key={worktree.id} className="coordination-row coordination-worktree">
              <span className={`coordination-row-mark worktree-mark hue-${worktreeHue(worktree.id)}`}><FolderSymlink size={12} aria-hidden="true" /></span>
              <span data-tip={worktree.root}><strong>{worktree.name}</strong><small className={worktree.deleting ? "text-sweep" : undefined}>{detail}</small></span>
              <span className="coordination-worktree-actions">
                {onReveal && <button type="button" aria-label={`Reveal ${worktree.name}`} data-tip={MAC ? "Reveal in Finder" : "Show in file manager"} disabled={worktree.deleting} onClick={() => onReveal(worktree.root)}>
                  <FolderOpen size={14} />
                </button>}
                <button
                  type="button"
                  className="danger"
                  aria-label={`Delete ${worktree.name}`}
                  data-tip={worktree.busy ? "Wait for its threads to finish before deleting" : "Delete worktree…"}
                  disabled={worktree.busy || worktree.deleting}
                  onClick={() => onDelete(worktree.root)}
                >
                  <Trash size={14} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Where a thread under the coordinator runs, as its sidebar row marks it: the computer, when it is not
 * this one, the checkout it works in, in that checkout's colour, and its engine.
 */
function ThreadMarks({ thread, host, worktree }: { thread: Thread; host: ThreadHost | null; worktree: Worktree | undefined }) {
  return (
    <span className="coordination-row-marks">
      {host && <HostMark name={host.name} offline={host.offline} reconnecting={host.reconnecting} className="coordination-row-host" />}
      {thread.worktreeId && <FolderSymlink className={`task-worktree worktree-mark hue-${worktreeHue(thread.worktreeId)}`} size={12} aria-label={`Works in ${worktree ? worktreeName(worktree) : "a worktree"}`} />}
      <ThreadEngineIcon engine={thread.engine} className="coordination-row-engine" size={12} />
    </span>
  );
}

/**
 * A thread's place under its coordinator: who it works for, on which computer when that is another,
 * what it was asked, and whether the user owes it an answer. A coordinator elsewhere is reached only
 * when a paired computer here holds it.
 */
export function CoordinationBar({ lead, remoteLead, brief, asking, onSelect }: Pick<CoordinationView, "lead" | "remoteLead" | "brief" | "asking"> & { onSelect: (threadId: string) => void }) {
  const leadId = lead?.id ?? remoteLead?.threadId ?? null;
  const title = lead?.title ?? remoteLead?.title;
  return (
    <div className={`coordination-bar ${asking ? "asking" : ""}`}>
      {title !== undefined && <div className="coordination-bar-line">
        <span className="coordination-bar-lead">
          Works under {leadId ? <button type="button" onClick={() => onSelect(leadId)}>{title}</button> : <strong>{title}</strong>}
          {remoteLead && ` on ${remoteLead.computer}`}
        </span>
        {asking && <>
          <span className="coordination-bar-asking">{asking}</span>
          {leadId && <button type="button" className="coordination-bar-answer" onClick={() => onSelect(leadId)}>Answer</button>}
        </>}
      </div>}
      {brief && <BriefDetails brief={brief} />}
    </div>
  );
}

/** What a coordinator handed a thread, folded under its name until asked for. */
export function BriefDetails({ brief }: { brief: ThreadBrief }) {
  return (
    <details className="coordination-brief">
      <summary>Brief</summary>
      <BriefList brief={brief} />
    </details>
  );
}

/** What a coordinator handed a thread: the user's words, what finished looks like, and how it lands. */
function BriefList({ brief }: { brief: ThreadBrief }) {
  return (
    <dl>
      <dt>Your words</dt><dd className="coordination-brief-intent">{brief.intent}</dd>
      <dt>Done when</dt><dd>{brief.doneWhen}</dd>
      <dt>Delivers</dt><dd>{deliveryLabel(brief.delivers)}</dd>
    </dl>
  );
}
