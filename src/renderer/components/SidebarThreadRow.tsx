import { CommandButton } from "./CommandControl";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Draggable, type DraggableProvided } from "@hello-pangea/dnd";
import { LuActivity as Activity, LuAlarmClock as AlarmClock, LuAlarmClockOff as AlarmClockOff, LuCheck as Check, LuClockAlert as ClockAlert, LuEllipsis as Ellipsis, LuFolderSymlink as FolderSymlink, LuHourglass as Hourglass, LuMonitorOff as MonitorOff } from "react-icons/lu";
import { pauseSummary } from "../../domain/usage-limit";
import { projectName, type Project } from "../../domain/project";
import { threadActivityAt, type Thread } from "../../domain/thread";
import { attentionUrgency, FOLDER_LABELS, hasUnreadAttention, MEMBER_BLOCKED_LABEL, MEMBER_UNREAD_LABEL, newestUnreadFinding, type AttentionTone } from "../../domain/attention";
import type { ThreadOutcome } from "../../domain/thread-run";
import { worktreeHue, worktreeName, type Worktree } from "../../domain/worktree";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { ContextMenu, type MenuEntry, type MenuItem } from "./PopoverMenu";
import { threadMenuEntries } from "./thread-menu";
import type { SnoozeHours } from "../../domain/thread-snooze";
import { RenameInput, useRenaming } from "./SidebarRename";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { roleIcon, ThreadRoleMark } from "./ThreadRoleMark";
import { threadRoleLabel, type ThreadRole } from "../../domain/thread-role";
import { engineLabel, isAgentEngine } from "../../domain/agent-engine";
import type { ThreadHost } from "../../application/computers";
import { rowHeadline } from "../../application/coordination";
import { HostMark } from "./HostMark";
import type { ThreadDropTarget } from "../../domain/project";
import { threadMoveBlock } from "../../application/thread-order";

/** What a row offers beside its menu: dismissing, in Priority, or nothing more. */
export type RowAction = "dismiss" | "none";

const OUTCOME_LABELS: Record<ThreadOutcome, string> = {
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

const BLOCKED_LABEL = "Needs approval";

const SIDE_CHAT_LABEL = "A side chat is waiting";

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

function formatTime(value: number) {
  return TIME_FORMAT.format(value);
}

/** When a snoozed thread comes back: the time alone today, else the day too. */
function snoozeLabel(until: number) {
  const today = new Date().toDateString() === new Date(until).toDateString();
  return `Until ${(today ? TIME_FORMAT : DAY_FORMAT).format(until)}`;
}

/** The mark says the thread runs on a schedule; whether that schedule is well is the part worth hearing. */
function scheduleLabel(automation: AutomationView) {
  if (automation.paused) return "Schedule paused";
  if (automation.nextRunAt === null) return "Schedule missed its run";
  if (automation.lastStatus === "failed") return "Runs on a schedule, and its last run failed";
  if (automation.lastStatus === "skipped") return "Runs on a schedule, and its last tick could not run";
  return "Runs on a schedule";
}

/** What a row's status mark says, or null when it carries none. A coordinator's row speaks for its threads. */
type RowStatus =
  | { kind: "dot"; tone: ThreadOutcome | "approval" | null; label: string }
  | { kind: "paused"; label: string }
  | { kind: "working"; label: string }
  | { kind: "monitoring"; label: string };

/**
 * What waits on the user outranks work going on, as an approval does, since the row is where it is
 * answered. What a run found is named outright: "Finished" says nothing a headline does.
 */
function rowStatus(row: RowState): RowStatus | null {
  const { thread } = row;
  if (row.blocked || row.memberBlocked) return { kind: "dot", tone: "approval", label: row.blocked ? BLOCKED_LABEL : MEMBER_BLOCKED_LABEL };
  if (row.waiting) return { kind: "dot", tone: "approval", label: row.waiting };
  if (row.pauseLabel !== null) return { kind: "paused", label: row.pauseLabel };
  if (row.running) return { kind: "working", label: "Working" };
  if (row.monitoring) return { kind: "monitoring", label: "Monitoring" };
  const finding = newestUnreadFinding(thread);
  if (finding) return { kind: "dot", tone: null, label: finding.headline };
  if (hasUnreadAttention(thread)) return { kind: "dot", tone: thread.outcome!, label: OUTCOME_LABELS[thread.outcome!] };
  /** A side chat has no row, so the thread holding it says one of its chats is waiting. */
  if (row.sideChatWaiting) return { kind: "dot", tone: null, label: SIDE_CHAT_LABEL };
  /** Nor does a thread under a coordinator, so the coordinator's row says one of them has news. */
  if (row.memberUnread) return { kind: "dot", tone: null, label: MEMBER_UNREAD_LABEL };
  return null;
}

function statusMark(status: RowStatus | null): ReactNode {
  if (!status) return false;
  if (status.kind === "working") return <ThreadSpinner key="status" label={status.label} />;
  if (status.kind === "paused") return <Hourglass key="status" className="task-paused" size={14} role="img" aria-label={status.label} />;
  if (status.kind === "monitoring") return <Activity key="status" className="task-monitoring" size={14} role="img" aria-label={status.label} />;
  return <span key="status" className={status.tone ? `task-attention ${status.tone}` : "task-attention"} role="img" aria-label={status.label} />;
}

/**
 * What a row says under its title in activity mode: which computer and folder it lives in, and when
 * it last moved. A row carrying something a run found says that instead — the headline is why the
 * row is in Priority. A snoozed row says when it comes back.
 */
function activityMeta(thread: Thread, host: ThreadHost | undefined, projectLabel: string | undefined, waiting: string | null, memberBlocked: boolean, pauseLabel: string | null) {
  /** An approval a thread under it waits on is said first, as its mark says it. */
  if (memberBlocked) return MEMBER_BLOCKED_LABEL;
  const headline = rowHeadline(thread, waiting);
  if (headline) return headline;
  if (pauseLabel !== null) return hostMeta(host, pauseLabel);
  if (thread.snoozedUntil !== undefined) return hostMeta(host, ...[projectLabel, snoozeLabel(thread.snoozedUntil)].filter((part): part is string => Boolean(part)));
  return hostMeta(host, ...[projectLabel, formatTime(threadActivityAt(thread))].filter((part): part is string => Boolean(part)));
}

/** A row's meta line: the computer it lives on, marked as one, ahead of whatever else the line says. */
export function hostMeta(host: ThreadHost | undefined, ...parts: string[]): ReactNode {
  const rest = parts.join(" · ");
  if (!host) return rest;
  return <><HostMark name={host.name} offline={host.offline} reconnecting={host.reconnecting} />{rest && ` · ${rest}`}</>;
}

function ThreadSpinner({ label }: { label: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  // Anchor every spinner to the document timeline so rows that mount later stay in phase. A row that
  // mounts while nothing is drawing it has no animation to anchor yet, so each start is anchored too.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const anchor = () => {
      for (const animation of element.getAnimations()) animation.startTime = 0;
    };
    anchor();
    element.addEventListener("animationstart", anchor);
    return () => element.removeEventListener("animationstart", anchor);
  }, []);
  return <span ref={ref} className="task-spinner" role="img" aria-label={label} />;
}

export type ThreadRowsOptions = {
  projects: Project[];
  currentId: string | null;
  runningThreadIds: Set<string>;
  /** Threads not running whose background shell or monitor will wake them. */
  monitoringThreadIds: Set<string>;
  /** Threads stopped on an approval only the user can answer. A subset of `runningThreadIds`. */
  blockedThreadIds: Set<string>;
  /** Threads holding a side chat with something unseen, which have no row of their own. */
  sideChatAttention: Set<string>;
  schedules: Map<string, AutomationView>;
  /** Each thread waiting out its usage limit, by its place in line. */
  limitPositions: Map<string, number>;
  worktreeThreadIds: Set<string>;
  worktreeGroups: WorktreeGroup[];
  /** Which paired computer holds each thread that is not this computer's own. */
  threadHosts: Map<string, ThreadHost>;
  projectHosts: Map<string, ThreadHost>;
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string) => void;
  onDismissThread: (threadId: string) => void;
  onSnoozeThread: (threadId: string, hours: SnoozeHours) => void;
  onUnsnoozeThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onMoveThread: (threadId: string, target: ThreadDropTarget) => void;
  onForkThread: (threadId: string, worktree: boolean) => void;
  onSetThreadRole: (threadId: string, role: ThreadRole | null) => void;
  sidebarCoordination: SidebarCoordination;
};

/** The threads working under each coordinator, which its row speaks for, and what moves a thread between them. */
export type SidebarCoordination = {
  threadsByCoordinator: Map<string, Thread[]>;
  /**
   * What each row says waits on the user, a coordinator's for everything its Needs-you card holds:
   * the decisions its threads put to the user as well as its own, its suggestions and its requests.
   */
  waitingLines: ReadonlyMap<string, string>;
  /** The coordinators on each computer, this one's under null, of which only those holding a thread can take it. */
  coordinatorsByComputer: ReadonlyMap<string | null, readonly Thread[]>;
  onSetCoordinator: (threadId: string, coordinatorId: string | null) => void;
  /** Whether desktop notices are on at all, which a coordinator's mute only narrows. */
  notifications: boolean;
  onSetMuted: (threadId: string, muted: boolean) => void;
  /** The coordinators Stop all has something to stop under. */
  stoppable: Set<string>;
  onStopAll: (threadId: string) => void;
};

/**
 * What can be done to a thread from its row: its menu, and in Priority dismissing at the rail's
 * outer edge, over the engine mark, so the status it clears stays in view. Archiving is in the menu,
 * a step from a stray click.
 */
function rowActionButtons(row: RowState, action: RowAction): React.ReactNode[] {
  const { thread, handlers } = row;
  return [
    <button
      key="menu"
      className="row-action task-more"
      type="button"
      aria-label={`More options for ${thread.title}`}
      aria-haspopup="menu"
      aria-expanded={row.menuAt !== null}
      data-tip="More"
      onClick={(event) => {
        event.stopPropagation();
        const box = event.currentTarget.getBoundingClientRect();
        handlers.openMenu(thread.id, { x: box.left, y: box.bottom + 4 }, event.currentTarget.closest(".task-entry"));
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Ellipsis size={16} aria-hidden="true" />
    </button>,
    action === "dismiss" && <CommandButton command={{ type: "task.dismiss", taskId: thread.id }}
      key="dismiss"
      className="row-action task-dismiss"
      type="button"
      aria-label={row.schedule ? `Dismiss ${thread.title}, which keeps running on its schedule` : `Dismiss ${thread.title}`}
      data-tip="Dismiss"
      onClick={(event) => {
        event.stopPropagation();
        handlers.dismiss(thread.id);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Check size={14} aria-hidden="true" />
    </CommandButton>,
  ].filter(Boolean);
}

/** Everything a row draws from besides its thread, settled by the list so an unchanged row is not drawn again. */
type RowState = {
  thread: Thread;
  active: boolean;
  /** A row on a computer that cannot be reached is drawn, greyed, and takes nothing: choosing it only says why. */
  away: boolean;
  /** The thread, or one working under it, has a run going. */
  running: boolean;
  /** The agent's turn is over, but a background shell or monitor it left will wake it. */
  monitoring: boolean;
  blocked: boolean;
  memberBlocked: boolean;
  sideChatWaiting: boolean;
  memberUnread: boolean;
  /** What waits on the user from the thread and those under it, or null when nothing does. */
  waiting: string | null;
  inWorktree: boolean;
  worktree: Worktree | undefined;
  schedule: AutomationView | undefined;
  host: ThreadHost | undefined;
  /** What a thread waiting out its usage limit says, read against the clock when the list was drawn. */
  pauseLabel: string | null;
  editing: boolean;
  menuAt: { x: number; y: number } | null;
  /** Only a row with its menu open is handed the coordinators, and whether Stop all has work to stop. */
  coordinators: readonly Thread[];
  stoppable: boolean;
  notifications: boolean;
  /** Why a drag can reorder the thread within its folder but not carry it elsewhere, or null when it can. */
  pinned: string | null;
  /** The folders an open menu offers to move the thread to, or null when it cannot move. */
  moveTargets: readonly Project[] | null;
  handlers: RowHandlers;
};

/** One set for every row, each taking the thread it acts on, which always reaches the list's latest callbacks. */
type RowHandlers = {
  select: (threadId: string) => void;
  archive: (threadId: string) => void;
  dismiss: (threadId: string) => void;
  snooze: (threadId: string, hours: SnoozeHours) => void;
  unsnooze: (threadId: string) => void;
  fork: (threadId: string, worktree: boolean) => void;
  move: (threadId: string, projectId: string | null) => void;
  setRole: (threadId: string, role: ThreadRole | null) => void;
  setCoordinator: (threadId: string, coordinatorId: string | null) => void;
  setMuted: (threadId: string, muted: boolean) => void;
  stopAll: (threadId: string) => void;
  startRename: (threadId: string, row?: HTMLElement | null) => void;
  commitRename: (threadId: string, value: string) => void;
  cancelRename: () => void;
  openMenu: (threadId: string, at: { x: number; y: number }, row: HTMLElement | null) => void;
  closeMenu: () => void;
  renameInput: RefObject<HTMLInputElement | null>;
  menuReturn: RefObject<HTMLElement | null>;
};

const NO_THREADS: Thread[] = [];

/** A mark fills its slot, so pointing anywhere in the slot names it. */
function railMark(key: string, tip: string, icon: ReactNode) {
  return <span key={key} className={`row-mark mark-${key}`} data-tip={tip}>{icon}</span>;
}

/** The most slots a rail takes, so one row carrying many marks never shortens every title. */
export const MAX_RAIL_SLOTS = 3;

type RailMark = { key: string; tip: string; icon: ReactNode };

/**
 * The engine stays at the right edge, with status beside it, whatever other marks a row carries.
 * Past three, the marks ahead of those two share one slot, a count that names each of them.
 */
function rowMarks(row: RowState, status: RowStatus | null): ReactNode[] {
  const { thread, worktree, host } = row;
  const marks = [
    row.away && host && { key: "away", tip: awayLabel(host), icon: <MonitorOff className="task-away" size={14} role="img" aria-label={awayLabel(host)} /> },
    thread.role && roleIcon(thread.role) && { key: "role", tip: threadRoleLabel(thread.role), icon: <ThreadRoleMark role={thread.role} size={14} /> },
    /** A thread's own mark names its checkout, and threads sharing one share its colour, so a list ranked by attention still groups by eye. */
    row.inWorktree && { key: "worktree", tip: worktreeLabel(row), icon: <FolderSymlink className={`task-worktree${worktree ? ` worktree-mark hue-${worktreeHue(worktree.id)}` : ""}`} size={14} role="img" aria-label={worktreeLabel(row)} /> },
    row.schedule && { key: "automation", tip: scheduleLabel(row.schedule), icon: scheduleMark(row.schedule) },
    status && { key: "status", tip: status.label, icon: statusMark(status) },
    isAgentEngine(thread.engine) && { key: "engine", tip: `${engineLabel(thread.engine)} thread`, icon: <ThreadEngineIcon engine={thread.engine} className="task-engine" size={14} /> },
  ].filter((mark): mark is RailMark => Boolean(mark));
  if (marks.length <= MAX_RAIL_SLOTS) return marks.map((mark) => railMark(mark.key, mark.tip, mark.icon));
  const folded = marks.slice(0, -(MAX_RAIL_SLOTS - 1));
  const tips = folded.map((mark) => mark.tip);
  return [
    railMark("more", tips.join(" · "), <span className="task-more-marks" role="img" aria-label={tips.join(", ")}>+{folded.length}</span>),
    ...marks.slice(-(MAX_RAIL_SLOTS - 1)).map((mark) => railMark(mark.key, mark.tip, mark.icon)),
  ];
}

function awayLabel(host: ThreadHost) {
  return `${host.name} is ${host.reconnecting ? "reconnecting" : "offline"}`;
}

function worktreeLabel(row: RowState) {
  return `Works in ${row.worktree ? worktreeName(row.worktree) : "a worktree"}`;
}

/** A schedule that missed or failed its run is drawn apart from one that is well or paused on purpose. */
function scheduleTrouble(automation: AutomationView) {
  return !automation.paused && (automation.nextRunAt === null || automation.lastStatus === "failed" || automation.lastStatus === "skipped");
}

/** Each state of a schedule has its own glyph, so trouble reads without its colour. */
function scheduleMark(automation: AutomationView) {
  const label = scheduleLabel(automation);
  if (scheduleTrouble(automation)) return <ClockAlert className="task-automation trouble" size={14} role="img" aria-label={label} />;
  const Glyph = automation.paused ? AlarmClockOff : AlarmClock;
  return <Glyph className="task-automation" size={14} role="img" aria-label={label} />;
}

/**
 * Every thread row ends in the same rail: two layers of icons over one set of slots, the marks it
 * carries at rest and the actions it offers hovered. Both fill the rail from its right edge, so an
 * action covers only the marks in its own slots, and every rail is the same width, so the slots line
 * up down the list and the title never moves.
 */
function threadRail(row: RowState, status: RowStatus | null, away: boolean, action: RowAction) {
  const actions = away ? [] : rowActionButtons(row, action);
  return (
    <span className="row-rail">
      <span className="row-layer row-marks">{rowMarks(row, status)}</span>
      {actions.length > 0 && <span className="row-layer row-actions">{actions}</span>}
    </span>
  );
}

/** The menu's way to do what a drag does: every other folder on the thread's computer, and Recents. */
function moveEntry(row: RowState): MenuEntry[] {
  const { thread, moveTargets, handlers } = row;
  if (!moveTargets) return [];
  const destination = (label: string, projectId: string | null): MenuItem => ({
    label,
    command: { type: "task.move", taskId: thread.id, target: { projectId, index: 0 } },
    onSelect: () => handlers.move(thread.id, projectId),
  });
  const items = [
    ...moveTargets.filter((project) => project.id !== thread.projectId).map((project) => destination(projectName(project), project.id)),
    ...(thread.projectId ? [destination("Recents", null)] : []),
  ];
  return items.length ? [{ label: "Move to", items }] : [];
}

function rowMenuEntries(row: RowState, priority: boolean): MenuEntry[] {
  const { thread, handlers } = row;
  const entries = threadMenuEntries(thread, {
    onRename: () => handlers.startRename(thread.id),
    onFork: (worktree) => handlers.fork(thread.id, worktree),
    onArchive: () => handlers.archive(thread.id),
    onSetRole: (role) => handlers.setRole(thread.id, role),
    coordinators: row.coordinators,
    onSetCoordinator: (coordinatorId) => handlers.setCoordinator(thread.id, coordinatorId),
    notifications: row.notifications,
    onSetMuted: (muted) => handlers.setMuted(thread.id, muted),
    stoppable: row.stoppable,
    onStopAll: () => handlers.stopAll(thread.id),
    ...(priority ? { onSnooze: (hours: SnoozeHours) => handlers.snooze(thread.id, hours) } : {}),
    ...(thread.snoozedUntil !== undefined ? { onUnsnooze: () => handlers.unsnooze(thread.id) } : {}),
  });
  const firstBreak = entries.indexOf("separator");
  entries.splice(firstBreak < 0 ? entries.length : firstBreak, 0, ...moveEntry(row));
  return entries.map((entry) => entry !== "separator" && entry.command?.type === "task.rename" ? { ...entry, shortcut: RENAME_KEY } : entry);
}

const RENAME_KEY = "F2";

/** Where a menu opens: at the pointer, or under the row's start when the keyboard's menu key asked. */
function menuPoint(event: React.MouseEvent<HTMLElement>) {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left + 12, y: box.bottom + 4 };
}

/**
 * The row itself, which is the same whether the list around it lets it be dragged or not. The title
 * shows itself whole under the pointer only while it is cut short. A row on a computer that is away
 * answers a right-click as it does a click, by saying why it takes nothing.
 */
function rowBody(row: RowState, className: string, content: ReactNode, action: RowAction, priority = false) {
  const { thread, away, handlers } = row;
  const status = rowStatus(row);
  return (
    <>
    <div
      className={`${thread.role ? `${className} role-${thread.role}` : className}${away ? " offline" : ""}`}
      aria-disabled={away || undefined}
      onClick={() => handlers.select(thread.id)}
      onDoubleClick={away ? undefined : (event) => handlers.startRename(thread.id, event.currentTarget.closest(".task-entry"))}
      onContextMenu={(event) => {
        event.preventDefault();
        if (away) handlers.select(thread.id);
        else handlers.openMenu(thread.id, menuPoint(event), event.currentTarget.closest(".task-entry"));
      }}
    >
      {row.editing && !away
        ? <RenameInput
            inputRef={handlers.renameInput}
            className="task-rename"
            label={`Rename ${thread.title}`}
            value={thread.title}
            placeholder={thread.title}
            required
            onCommit={(value) => handlers.commitRename(thread.id, value)}
            onCancel={handlers.cancelRename}
          />
        : <>{content}{threadRail(row, status, away, action)}</>}
    </div>
    {row.menuAt && <ContextMenu
      at={row.menuAt}
      returnFocus={handlers.menuReturn}
      onClose={handlers.closeMenu}
      entries={rowMenuEntries(row, priority)}
    />}
    </>
  );
}

/** Enter opens the row's thread and F2 renames it, as the menu's Rename does. Space opens it too where dragging does not claim it. */
function rowKeys(event: React.KeyboardEvent<HTMLElement>, row: RowState, space = false) {
  if (event.target !== event.currentTarget) return;
  if (event.key === "Enter" || (space && event.key === " ")) {
    if (event.key === " ") event.preventDefault();
    row.handlers.select(row.thread.id);
  }
  else if (event.key === RENAME_KEY && !row.away) {
    event.preventDefault();
    row.handlers.startRename(row.thread.id, event.currentTarget);
  }
}

/** Where a draggable row sits: under its folder, or in Recents with when it last moved. */
type ThreadRowPlace = "project" | "recent";

const ThreadRow = memo(function ThreadRow({ index, place, ...row }: RowState & { index: number; place: ThreadRowPlace }) {
  const { thread, host } = row;
  const content = place === "project"
    ? <span data-tip={thread.title} data-tip-overflow>{thread.title}</span>
    : <span className="task-row-text">
        <span data-tip={thread.title} data-tip-overflow>{thread.title}</span>
        <small>{hostMeta(host, formatTime(threadActivityAt(thread)))}</small>
      </span>;
  return (
    <Draggable draggableId={thread.id} index={index} isDragDisabled={row.away}>
      {(provided: DraggableProvided, snapshot) => (
        <div
          className={`task-entry ${snapshot.isDragging ? "is-dragging" : ""}`}
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          data-pinned={row.pinned ?? undefined}
          aria-current={row.active || undefined}
          onKeyDown={(event) => rowKeys(event, row)}
        >
          {rowBody(row, `${place === "project" ? "project-task-row" : "task-row"} ${row.active ? "active" : ""}`, content, "none")}
        </div>
      )}
    </Draggable>
  );
});

/** Activity mode ranks its rows itself, so nothing there is dragged and no list places it. */
const ActivityRow = memo(function ActivityRow({ projectLabel, action, priority, ...row }: RowState & { projectLabel: string | undefined; action: RowAction; priority: boolean }) {
  const { thread } = row;
  return (
    <div
      className="task-entry"
      tabIndex={0}
      aria-current={row.active || undefined}
      onKeyDown={(event) => rowKeys(event, row, true)}
    >
      {rowBody(row, `task-row ${row.active ? "active" : ""}`, (
        <span className="task-row-text">
          <span data-tip={thread.title} data-tip-overflow>{thread.title}</span>
          <small>{activityMeta(thread, row.host, projectLabel, row.waiting, row.memberBlocked, row.pauseLabel)}</small>
        </span>
      ), action, priority)}
    </div>
  );
});

/** Both lists draw the same row, so both of them ask this for one: only the placement differs. */
export function useThreadRows({
  projects,
  currentId,
  runningThreadIds,
  monitoringThreadIds,
  blockedThreadIds,
  sideChatAttention,
  schedules,
  limitPositions,
  worktreeThreadIds,
  worktreeGroups,
  threadHosts,
  projectHosts,
  openMenu,
  onSetOpenMenu,
  onSelectThread,
  onArchiveThread,
  onDismissThread,
  onSnoozeThread,
  onUnsnoozeThread,
  onRenameThread,
  onMoveThread,
  onForkThread,
  onSetThreadRole,
  sidebarCoordination: coordination,
}: ThreadRowsOptions) {
  const [threadMenuPosition, setThreadMenuPosition] = useState({ x: 0, y: 0 });
  const threadNames = useRenaming((threadId, value) => { if (value.trim()) onRenameThread(threadId, value); });

  const offline = (threadId: string) => threadHosts.get(threadId)?.offline === true;
  /** A row whose computer went away takes back what it was offering: a name being typed, or its menu. */
  useEffect(() => {
    if (threadNames.editing !== null && offline(threadNames.editing)) threadNames.cancel();
    if (openMenu?.startsWith("task:") && offline(openMenu.slice("task:".length))) onSetOpenMenu(null);
  });

  const latest = useRef({ onSelectThread, onArchiveThread, onDismissThread, onSnoozeThread, onUnsnoozeThread, onMoveThread, onForkThread, onSetThreadRole, onSetOpenMenu, coordination, threadNames });
  latest.current = { onSelectThread, onArchiveThread, onDismissThread, onSnoozeThread, onUnsnoozeThread, onMoveThread, onForkThread, onSetThreadRole, onSetOpenMenu, coordination, threadNames };
  const { input: renameInput, row: menuReturn } = threadNames;
  const handlers = useMemo<RowHandlers>(() => ({
    select: (threadId) => latest.current.onSelectThread(threadId),
    archive: (threadId) => latest.current.onArchiveThread(threadId),
    dismiss: (threadId) => latest.current.onDismissThread(threadId),
    snooze: (threadId, hours) => latest.current.onSnoozeThread(threadId, hours),
    unsnooze: (threadId) => latest.current.onUnsnoozeThread(threadId),
    fork: (threadId, worktree) => latest.current.onForkThread(threadId, worktree),
    move: (threadId, projectId) => latest.current.onMoveThread(threadId, { projectId, index: 0 }),
    setRole: (threadId, role) => latest.current.onSetThreadRole(threadId, role),
    setCoordinator: (threadId, coordinatorId) => latest.current.coordination.onSetCoordinator(threadId, coordinatorId),
    setMuted: (threadId, muted) => latest.current.coordination.onSetMuted(threadId, muted),
    stopAll: (threadId) => latest.current.coordination.onStopAll(threadId),
    startRename: (threadId, row) => latest.current.threadNames.start(threadId, row),
    commitRename: (threadId, value) => latest.current.threadNames.commit(threadId, value),
    cancelRename: () => latest.current.threadNames.cancel(),
    openMenu: (threadId, at, row) => {
      menuReturn.current = row;
      setThreadMenuPosition(at);
      latest.current.onSetOpenMenu(`task:${threadId}`);
    },
    closeMenu: () => latest.current.onSetOpenMenu(null),
    renameInput,
    menuReturn,
  }), [renameInput, menuReturn]);

  const checkouts = useMemo(() => new Map(worktreeGroups.flatMap(({ worktree, threads }) =>
    threads.map((thread) => [thread.id, worktree] as const))), [worktreeGroups]);

  const coordinated = useMemo(() => new Set([...coordination.threadsByCoordinator.values()].flat().map((thread) => thread.id)), [coordination.threadsByCoordinator]);
  const pinned = (thread: Thread) => threadMoveBlock(thread, threadHosts.get(thread.id), coordinated.has(thread.id));
  const moveTargets = (thread: Thread) => pinned(thread) !== null ? null : projects.filter((project) => !projectHosts.has(project.id));

  const rowState = (thread: Thread): RowState => {
    const away = offline(thread.id);
    const members = coordination.threadsByCoordinator.get(thread.id) ?? NO_THREADS;
    const menuOpen = openMenu === `task:${thread.id}` && !away;
    return {
      thread,
      active: thread.id === currentId,
      away,
      running: runningThreadIds.has(thread.id) || members.some((member) => runningThreadIds.has(member.id)),
      monitoring: monitoringThreadIds.has(thread.id),
      blocked: blockedThreadIds.has(thread.id),
      memberBlocked: members.some((member) => blockedThreadIds.has(member.id)),
      sideChatWaiting: sideChatAttention.has(thread.id),
      memberUnread: members.some(hasUnreadAttention),
      waiting: coordination.waitingLines.get(thread.id) ?? null,
      inWorktree: worktreeThreadIds.has(thread.id),
      worktree: checkouts.get(thread.id),
      schedule: schedules.get(thread.id),
      host: threadHosts.get(thread.id),
      pauseLabel: thread.limitPause ? pauseSummary(thread.limitPause, limitPositions.get(thread.id) ?? null, Date.now()) : null,
      editing: threadNames.editing === thread.id,
      menuAt: menuOpen ? threadMenuPosition : null,
      coordinators: menuOpen ? coordination.coordinatorsByComputer.get(threadHosts.get(thread.id)?.id ?? null) ?? NO_THREADS : NO_THREADS,
      stoppable: menuOpen && coordination.stoppable.has(thread.id),
      notifications: coordination.notifications,
      pinned: pinned(thread),
      moveTargets: menuOpen ? moveTargets(thread) : null,
      handlers,
    };
  };

  /** A folded folder's one mark: what most wants the user among the threads it hides, counted when more than one says it. */
  const folderStatus = (threads: Thread[]): ReactNode => {
    let pressing: RowStatus | null = null;
    let count = 0;
    for (const thread of threads) {
      if (offline(thread.id)) continue;
      const status = rowStatus(rowState(thread));
      if (!status) continue;
      const urgency = attentionUrgency(statusTone(status));
      if (!pressing || urgency < attentionUrgency(statusTone(pressing))) {
        pressing = status;
        count = 1;
      } else if (urgency === attentionUrgency(statusTone(pressing))) count += 1;
    }
    if (!pressing) return null;
    const label = count > 1 ? `${FOLDER_LABELS[statusTone(pressing)]}, and ${count - 1} more` : FOLDER_LABELS[statusTone(pressing)];
    return (
      <span className="row-mark folder-status" data-tip={label}>
        {statusMark({ ...pressing, label })}
        {count > 1 && <span className="folder-status-count" aria-hidden="true">{count}</span>}
      </span>
    );
  };

  const threadRow = Object.assign((thread: Thread, index: number, place: ThreadRowPlace) => (
    <ThreadRow key={thread.id} index={index} place={place} {...rowState(thread)} />
  ), { folderStatus });

  const activityRow = (thread: Thread, action: RowAction, priority: boolean) => {
    const project = projects.find((item) => item.id === thread.projectId);
    return <ActivityRow key={thread.id} projectLabel={project && projectName(project)} action={action} priority={priority} {...rowState(thread)} />;
  };

  return { threadRow, activityRow };
}

function statusTone(status: RowStatus): AttentionTone {
  return status.kind === "dot" ? status.tone ?? "unread" : status.kind;
}

export type ThreadRowRenderer = ReturnType<typeof useThreadRows>["threadRow"];
export type ActivityRowRenderer = ReturnType<typeof useThreadRows>["activityRow"];
