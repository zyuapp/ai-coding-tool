import { CommandButton } from "./CommandControl";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Draggable, type DraggableProvided } from "@hello-pangea/dnd";
import { LuAlarmClock as AlarmClock, LuArchive as Archive, LuCheck as Check, LuFolderSymlink as FolderSymlink, LuHourglass as Hourglass } from "react-icons/lu";
import { pauseSummary } from "../../domain/usage-limit";
import { projectName, type Project } from "../../domain/project";
import { threadActivityAt, type Thread } from "../../domain/thread";
import { hasUnreadAttention, newestUnreadFinding } from "../../domain/attention";
import type { ThreadOutcome } from "../../domain/thread-run";
import { worktreeHue, worktreeName, type Worktree } from "../../domain/worktree";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { ContextMenu } from "./PopoverMenu";
import { threadMenuEntries } from "./thread-menu";
import type { SnoozeHours } from "../../domain/thread-snooze";
import { RenameInput, useRenaming } from "./SidebarRename";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { ThreadRoleMark } from "./ThreadRoleMark";
import type { ThreadRole } from "../../domain/thread-role";
import { openDecisions } from "../../domain/coordination";
import type { ThreadHost } from "../../application/computers";
import { HostMark } from "./HostMark";

/** What a row's trailing slot offers, if anything. Only one of them ever shows in a given list. */
export type RowAction = "archive" | "dismiss" | "none";

const OUTCOME_LABELS: Record<ThreadOutcome, string> = {
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

const BLOCKED_LABEL = "Needs approval";

const MEMBER_BLOCKED_LABEL = "A thread needs your approval";

const SIDE_CHAT_LABEL = "A side chat is waiting";

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function formatTime(value: number) {
  return TIME_FORMAT.format(value);
}

/** The mark says the thread runs on a schedule; whether that schedule is well is the part worth hearing. */
function scheduleLabel(automation: AutomationView) {
  if (automation.paused) return "Schedule paused";
  if (automation.nextRunAt === null) return "Schedule missed its run";
  if (automation.lastStatus === "failed") return "Runs on a schedule, and its last run failed";
  if (automation.lastStatus === "skipped") return "Runs on a schedule, and its last tick could not run";
  return "Runs on a schedule";
}

/** The dot a row carries. What a run found is named outright: "Finished" says nothing a headline does. */
function attentionMark(thread: Thread, sideChatWaiting: boolean, decisions: number) {
  if (decisions) return <span key="status" className="task-attention approval" aria-label={decisionLabel(decisions)} />;
  const finding = newestUnreadFinding(thread);
  if (finding) return <span key="status" className="task-attention" aria-label={finding.headline} />;
  if (hasUnreadAttention(thread)) return <span key="status" className={`task-attention ${thread.outcome!}`} aria-label={OUTCOME_LABELS[thread.outcome!]} />;
  /** A side chat has no row, so the thread holding it says one of its chats is waiting. */
  if (sideChatWaiting) return <span key="status" className="task-attention" aria-label={SIDE_CHAT_LABEL} />;
  return false;
}

function decisionLabel(count: number) {
  return count === 1 ? "A decision is waiting on you" : `${count} decisions are waiting on you`;
}

/**
 * What a row says under its title in activity mode: which computer and folder it lives in, and when
 * it last moved. A row carrying something a run found says that instead — the headline is why the
 * row is in Priority.
 */
function activityMeta(thread: Thread, host: ThreadHost | undefined, projectLabel: string | undefined, decisions: number, memberBlocked: boolean, pauseLabel: string | null) {
  if (decisions) return decisionLabel(decisions);
  if (memberBlocked) return MEMBER_BLOCKED_LABEL;
  const finding = newestUnreadFinding(thread);
  if (finding) return finding.headline;
  if (pauseLabel !== null) return hostMeta(host, pauseLabel);
  return hostMeta(host, ...[projectLabel, formatTime(threadActivityAt(thread))].filter((part): part is string => Boolean(part)));
}

/** A row's meta line: the computer it lives on, marked as one, ahead of whatever else the line says. */
export function hostMeta(host: ThreadHost | undefined, ...parts: string[]): ReactNode {
  const rest = parts.join(" · ");
  if (!host) return rest;
  return <><HostMark name={host.name} offline={host.offline} />{rest && ` · ${rest}`}</>;
}

function ThreadSpinner() {
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
  return <span ref={ref} className="task-spinner" aria-label="Working" />;
}

export type ThreadRowsOptions = {
  projects: Project[];
  currentId: string | null;
  runningThreadIds: Set<string>;
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
  openMenu: string | null;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string) => void;
  onDismissThread: (threadId: string) => void;
  onSnoozeThread: (threadId: string, hours: SnoozeHours) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onForkThread: (threadId: string, worktree: boolean) => void;
  onSetThreadRole: (threadId: string, role: ThreadRole | null) => void;
  sidebarCoordination: SidebarCoordination;
};

/** The threads working under each coordinator, which its row speaks for, and what moves a thread between them. */
export type SidebarCoordination = {
  threadsByCoordinator: Map<string, Thread[]>;
  coordinators: Thread[];
  onSetCoordinator: (threadId: string, coordinatorId: string | null) => void;
};

/** A coordinator's row speaks for the decisions its threads are waiting on as well as its own. */
export function decisionCount(thread: Thread, threadsByCoordinator: Map<string, Thread[]>) {
  return [thread, ...threadsByCoordinator.get(thread.id) ?? []].reduce((count, item) => count + openDecisions(item).length, 0);
}

/**
 * What can be done to a thread from its row. Activity mode offers dismissing on a priority row
 * - a thread still asking has nothing to dismiss - and nothing on the others, rather than two
 * different icons in one view; archiving a thread there is on its menu.
 */
function rowActionButtons(thread: Thread, action: RowAction, scheduled: boolean, onDismiss: (threadId: string) => void, onArchive: (threadId: string) => void): React.ReactNode[] {
  return [
    action === "dismiss" && <CommandButton command={{ type: "task.dismiss", taskId: thread.id }}
      key="dismiss"
      className="row-action task-dismiss"
      type="button"
      aria-label={scheduled ? `Dismiss ${thread.title}, which keeps running on its schedule` : `Dismiss ${thread.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onDismiss(thread.id);
      }}
    >
      <Check size={13} aria-hidden="true" />
    </CommandButton>,
    action === "archive" && <CommandButton command={{ type: "task.archive", taskId: thread.id }}
      key="archive"
      className="row-action task-archive"
      type="button"
      aria-label={`Archive ${thread.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onArchive(thread.id);
      }}
    >
      <Archive size={13} aria-hidden="true" />
    </CommandButton>,
  ].filter(Boolean);
}

/** Everything a row draws from besides its thread, settled by the list so an unchanged row is not drawn again. */
type RowState = {
  thread: Thread;
  active: boolean;
  /** A row on a computer that cannot be reached is drawn, greyed, and takes nothing. */
  away: boolean;
  /** The thread, or one working under it, has a run going. */
  running: boolean;
  blocked: boolean;
  memberBlocked: boolean;
  sideChatWaiting: boolean;
  decisions: number;
  inWorktree: boolean;
  worktree: Worktree | undefined;
  schedule: AutomationView | undefined;
  host: ThreadHost | undefined;
  /** What a thread waiting out its usage limit says, read against the clock when the list was drawn. */
  pauseLabel: string | null;
  editing: boolean;
  menuAt: { x: number; y: number } | null;
  /** Only a row with its menu open is handed the coordinators. */
  coordinators: Thread[];
  handlers: RowHandlers;
};

/** One set for every row, each taking the thread it acts on, which always reaches the list's latest callbacks. */
type RowHandlers = {
  select: (threadId: string) => void;
  archive: (threadId: string) => void;
  dismiss: (threadId: string) => void;
  snooze: (threadId: string, hours: SnoozeHours) => void;
  fork: (threadId: string, worktree: boolean) => void;
  setRole: (threadId: string, role: ThreadRole | null) => void;
  setCoordinator: (threadId: string, coordinatorId: string | null) => void;
  startRename: (threadId: string, row?: HTMLElement | null) => void;
  commitRename: (threadId: string, value: string) => void;
  cancelRename: () => void;
  openMenu: (threadId: string, at: { x: number; y: number }, row: HTMLElement | null) => void;
  closeMenu: () => void;
  renameInput: RefObject<HTMLInputElement | null>;
  menuReturn: RefObject<HTMLElement | null>;
};

const NO_THREADS: Thread[] = [];

/** The engine stays at the right edge, with status beside it, whatever other marks a row carries. */
function rowMarks(row: RowState): ReactNode[] {
  const { thread, worktree } = row;
  return [
    thread.role && <ThreadRoleMark key="role" role={thread.role} size={13} />,
    /** A thread's own mark names its checkout, and threads sharing one share its colour, so a list ranked by attention still groups by eye. */
    row.inWorktree && <FolderSymlink key="worktree" className={`task-worktree${worktree ? ` worktree-mark hue-${worktreeHue(worktree.id)}` : ""}`} size={13} aria-label={`Works in ${worktree ? worktreeName(worktree) : "a worktree"}`} />,
    row.schedule && <AlarmClock key="automation" className="task-automation" size={13} aria-label={scheduleLabel(row.schedule)} />,
    /** A coordinator's row stands for its threads, so it shows the approval or the work they have going. */
    row.blocked || row.memberBlocked
      ? <span key="status" className="task-attention approval" aria-label={row.blocked ? BLOCKED_LABEL : MEMBER_BLOCKED_LABEL} />
      : row.pauseLabel !== null
        ? <Hourglass key="status" className="task-paused" size={13} aria-label={row.pauseLabel} />
        : row.running
          ? <ThreadSpinner key="status" />
          : attentionMark(thread, row.sideChatWaiting, row.decisions),
    <ThreadEngineIcon key="engine" engine={thread.engine} className="task-engine" size={13} />,
  ].filter(Boolean);
}

/**
 * Every thread row ends in the same rail: two layers of icons over one set of slots, the marks it
 * carries at rest and the actions it offers hovered. Both fill the rail from its right edge, so an
 * action lands on the mark it stands in for, and every rail is the same width, so the slots line up
 * down the list. A layer that gains an icon keeps the other layer's geometry.
 */
function threadRail(row: RowState, action: RowAction) {
  const actions = rowActionButtons(row.thread, action, Boolean(row.schedule), row.handlers.dismiss, row.handlers.archive);
  return (
    <span className="row-rail">
      <span className="row-layer row-marks">{rowMarks(row)}</span>
      {actions.length > 0 && <span className="row-layer row-actions">{actions}</span>}
    </span>
  );
}

/** The row itself, which is the same whether the list around it lets it be dragged or not. */
function rowBody(row: RowState, className: string, content: ReactNode, action: RowAction, priority = false) {
  const { thread, away, handlers } = row;
  return (
    <>
    <div
      className={`${thread.role ? `${className} role-${thread.role}` : className}${away ? " offline" : ""}`}
      aria-disabled={away || undefined}
      onClick={away ? undefined : () => handlers.select(thread.id)}
      onDoubleClick={away ? undefined : (event) => handlers.startRename(thread.id, event.currentTarget.closest(".task-entry"))}
      onContextMenu={(event) => {
        event.preventDefault();
        if (away) return;
        handlers.openMenu(thread.id, { x: event.clientX, y: event.clientY }, event.currentTarget.closest(".task-entry"));
      }}
      title={thread.title}
    >
      {row.editing && !away
        ? <RenameInput
            inputRef={handlers.renameInput}
            className="task-rename"
            label={`Rename ${thread.title}`}
            value={thread.title}
            onCommit={(value) => handlers.commitRename(thread.id, value)}
            onCancel={handlers.cancelRename}
          />
        : <>{content}{threadRail(row, away ? "none" : action)}</>}
    </div>
    {row.menuAt && <ContextMenu
      at={row.menuAt}
      returnFocus={handlers.menuReturn}
      onClose={handlers.closeMenu}
      entries={threadMenuEntries(thread, {
        onRename: () => handlers.startRename(thread.id),
        onFork: (worktree) => handlers.fork(thread.id, worktree),
        onArchive: () => handlers.archive(thread.id),
        onSetRole: (role) => handlers.setRole(thread.id, role),
        coordinators: row.coordinators,
        onSetCoordinator: (coordinatorId) => handlers.setCoordinator(thread.id, coordinatorId),
        ...(priority ? { onSnooze: (hours: SnoozeHours) => handlers.snooze(thread.id, hours) } : {}),
      })}
    />}
    </>
  );
}

function selectOnEnter(event: React.KeyboardEvent, row: RowState) {
  if (event.key === "Enter" && !row.away) row.handlers.select(row.thread.id);
}

/** Where a draggable row sits: under its folder, or in Recents with when it last moved. */
type ThreadRowPlace = "project" | "recent";

const ThreadRow = memo(function ThreadRow({ index, place, ...row }: RowState & { index: number; place: ThreadRowPlace }) {
  const { thread, host } = row;
  const content = place === "project"
    ? <span>{thread.title}</span>
    : <span className="task-row-text">
        <span>{thread.title}</span>
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
          onKeyDown={(event) => selectOnEnter(event, row)}
        >
          {rowBody(row, `${place === "project" ? "project-task-row" : "task-row"} ${row.active ? "active" : ""}`, content, "archive")}
        </div>
      )}
    </Draggable>
  );
});

/** Activity mode ranks its rows itself, so nothing there is dragged and no list places it. */
const ActivityRow = memo(function ActivityRow({ projectLabel, action, priority, ...row }: RowState & { projectLabel: string | undefined; action: RowAction; priority: boolean }) {
  const { thread } = row;
  return (
    <div className="task-entry" tabIndex={0} onKeyDown={(event) => selectOnEnter(event, row)}>
      {rowBody(row, `task-row ${row.active ? "active" : ""}`, (
        <span className="task-row-text">
          <span>{thread.title}</span>
          <small>{activityMeta(thread, row.host, projectLabel, row.decisions, row.memberBlocked, row.pauseLabel)}</small>
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
  blockedThreadIds,
  sideChatAttention,
  schedules,
  limitPositions,
  worktreeThreadIds,
  worktreeGroups,
  threadHosts,
  openMenu,
  onSetOpenMenu,
  onSelectThread,
  onArchiveThread,
  onDismissThread,
  onSnoozeThread,
  onRenameThread,
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

  const latest = useRef({ onSelectThread, onArchiveThread, onDismissThread, onSnoozeThread, onForkThread, onSetThreadRole, onSetOpenMenu, coordination, threadNames });
  latest.current = { onSelectThread, onArchiveThread, onDismissThread, onSnoozeThread, onForkThread, onSetThreadRole, onSetOpenMenu, coordination, threadNames };
  const { input: renameInput, row: menuReturn } = threadNames;
  const handlers = useMemo<RowHandlers>(() => ({
    select: (threadId) => latest.current.onSelectThread(threadId),
    archive: (threadId) => latest.current.onArchiveThread(threadId),
    dismiss: (threadId) => latest.current.onDismissThread(threadId),
    snooze: (threadId, hours) => latest.current.onSnoozeThread(threadId, hours),
    fork: (threadId, worktree) => latest.current.onForkThread(threadId, worktree),
    setRole: (threadId, role) => latest.current.onSetThreadRole(threadId, role),
    setCoordinator: (threadId, coordinatorId) => latest.current.coordination.onSetCoordinator(threadId, coordinatorId),
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

  const rowState = (thread: Thread): RowState => {
    const away = offline(thread.id);
    const members = coordination.threadsByCoordinator.get(thread.id) ?? NO_THREADS;
    const menuOpen = openMenu === `task:${thread.id}` && !away;
    return {
      thread,
      active: thread.id === currentId,
      away,
      running: runningThreadIds.has(thread.id) || members.some((member) => runningThreadIds.has(member.id)),
      blocked: blockedThreadIds.has(thread.id),
      memberBlocked: members.some((member) => blockedThreadIds.has(member.id)),
      sideChatWaiting: sideChatAttention.has(thread.id),
      decisions: decisionCount(thread, coordination.threadsByCoordinator),
      inWorktree: worktreeThreadIds.has(thread.id),
      worktree: checkouts.get(thread.id),
      schedule: schedules.get(thread.id),
      host: threadHosts.get(thread.id),
      pauseLabel: thread.limitPause ? pauseSummary(thread.limitPause, limitPositions.get(thread.id) ?? null, Date.now()) : null,
      editing: threadNames.editing === thread.id,
      menuAt: menuOpen ? threadMenuPosition : null,
      coordinators: menuOpen ? coordination.coordinators : NO_THREADS,
      handlers,
    };
  };

  const threadRow = (thread: Thread, index: number, place: ThreadRowPlace) => (
    <ThreadRow key={thread.id} index={index} place={place} {...rowState(thread)} />
  );

  const activityRow = (thread: Thread, action: RowAction, priority: boolean) => {
    const project = projects.find((item) => item.id === thread.projectId);
    return <ActivityRow key={thread.id} projectLabel={project && projectName(project)} action={action} priority={priority} {...rowState(thread)} />;
  };

  return { threadRow, activityRow };
}

export type ThreadRowRenderer = ReturnType<typeof useThreadRows>["threadRow"];
export type ActivityRowRenderer = ReturnType<typeof useThreadRows>["activityRow"];
