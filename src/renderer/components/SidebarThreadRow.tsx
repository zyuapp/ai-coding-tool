import { useLayoutEffect, useRef, useState } from "react";
import { Draggable, type DraggableProvided } from "@hello-pangea/dnd";
import { LuAlarmClock as AlarmClock, LuArchive as Archive, LuCheck as Check, LuFolderSymlink as FolderSymlink } from "react-icons/lu";
import { projectName, type Project } from "../../domain/project";
import { threadActivityAt, type Thread } from "../../domain/thread";
import { hasUnreadAttention, newestUnreadFinding } from "../../domain/attention";
import type { ThreadOutcome } from "../../domain/thread-run";
import { worktreeHue, worktreeName } from "../../domain/worktree";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { ContextMenu } from "./PopoverMenu";
import { threadMenuEntries } from "./thread-menu";
import type { SnoozeHours } from "../../domain/thread-snooze";
import { RenameInput, useRenaming } from "./SidebarRename";
import { ThreadEngineIcon } from "./ThreadEngineIcon";
import { ThreadRoleMark } from "./ThreadRoleMark";
import type { ThreadRole } from "../../domain/thread-role";
import type { ThreadHost } from "../../application/computers";

/** What a row's trailing slot offers, if anything. Only one of them ever shows in a given list. */
export type RowAction = "archive" | "dismiss" | "none";

const OUTCOME_LABELS: Record<ThreadOutcome, string> = {
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

const BLOCKED_LABEL = "Needs approval";

const SIDE_CHAT_LABEL = "A side chat is waiting";

/** The mark says the thread runs on a schedule; whether that schedule is well is the part worth hearing. */
function scheduleLabel(automation: AutomationView) {
  if (automation.paused) return "Schedule paused";
  if (automation.nextRunAt === null) return "Schedule missed its run";
  if (automation.lastStatus === "failed") return "Runs on a schedule, and its last run failed";
  if (automation.lastStatus === "skipped") return "Runs on a schedule, and its last tick could not run";
  return "Runs on a schedule";
}

/** The dot a row carries. What a run found is named outright: "Finished" says nothing a headline does. */
function attentionMark(thread: Thread, sideChatWaiting: boolean) {
  const finding = newestUnreadFinding(thread);
  if (finding) return <span key="status" className="task-attention" aria-label={finding.headline} />;
  if (hasUnreadAttention(thread)) return <span key="status" className={`task-attention ${thread.outcome!}`} aria-label={OUTCOME_LABELS[thread.outcome!]} />;
  /** A side chat has no row, so the thread holding it says one of its chats is waiting. */
  if (sideChatWaiting) return <span key="status" className="task-attention" aria-label={SIDE_CHAT_LABEL} />;
  return false;
}

/**
 * What a row says under its title in activity mode: which computer and folder it lives in, and when
 * it last moved. A row carrying something a run found says that instead — the headline is why the
 * row is in Priority.
 */
function activityMeta(thread: Thread, host: ThreadHost | undefined, projects: Project[], formatTime: (value: number) => string) {
  const finding = newestUnreadFinding(thread);
  if (finding) return finding.headline;
  const project = projects.find((item) => item.id === thread.projectId);
  return [host?.name, project && projectName(project), formatTime(threadActivityAt(thread))].filter(Boolean).join(" · ");
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
  worktreeThreadIds: Set<string>;
  worktreeGroups: WorktreeGroup[];
  /** Which paired computer holds each thread that is not this computer's own. */
  threadHosts: Map<string, ThreadHost>;
  openMenu: string | null;
  formatTime: (value: number) => string;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string) => void;
  onDismissThread: (threadId: string) => void;
  onSnoozeThread: (threadId: string, hours: SnoozeHours) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onForkThread: (threadId: string, worktree: boolean) => void;
  onSetThreadRole: (threadId: string, role: ThreadRole | null) => void;
};

/**
 * What can be done to a thread from its row. Activity mode offers dismissing on a priority row
 * - a thread still asking has nothing to dismiss - and nothing on the others, rather than two
 * different icons in one view; archiving a thread there is on its menu.
 */
function rowActionButtons(thread: Thread, action: RowAction, scheduled: boolean, onDismiss: (threadId: string) => void, onArchive: (threadId: string) => void): React.ReactNode[] {
  return [
    action === "dismiss" && <button
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
    </button>,
    action === "archive" && <button
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
    </button>,
  ].filter(Boolean);
}

/** Both lists draw the same row, so both of them ask this for one: only the placement differs. */
export function useThreadRows({
  projects,
  currentId,
  runningThreadIds,
  blockedThreadIds,
  sideChatAttention,
  schedules,
  worktreeThreadIds,
  worktreeGroups,
  threadHosts,
  openMenu,
  formatTime,
  onSetOpenMenu,
  onSelectThread,
  onArchiveThread,
  onDismissThread,
  onSnoozeThread,
  onRenameThread,
  onForkThread,
  onSetThreadRole,
}: ThreadRowsOptions) {
  const [threadMenuPosition, setThreadMenuPosition] = useState({ x: 0, y: 0 });
  const threadNames = useRenaming((threadId, value) => { if (value.trim()) onRenameThread(threadId, value); });

  const checkouts = new Map(worktreeGroups.flatMap(({ worktree, threads }) =>
    threads.map((thread) => [thread.id, worktree] as const)));
  /** A thread's own mark names its checkout, which is what one flat list leaves it to say. */
  const worktreeLabel = (threadId: string) => {
    const worktree = checkouts.get(threadId);
    return `Works in ${worktree ? worktreeName(worktree) : "a worktree"}`;
  };
  /** Threads sharing a checkout share its colour, so a list ranked by attention still groups by eye. */
  const worktreeMark = (threadId: string) => {
    const worktree = checkouts.get(threadId);
    return `task-worktree${worktree ? ` worktree-mark hue-${worktreeHue(worktree.id)}` : ""}`;
  };

  /** The engine stays at the right edge, with status beside it, whatever other marks a row carries. */
  const rowMarks = (thread: Thread): React.ReactNode[] => [
    thread.role && <ThreadRoleMark key="role" role={thread.role} size={13} />,
    worktreeThreadIds.has(thread.id) && <FolderSymlink key="worktree" className={worktreeMark(thread.id)} size={13} aria-label={worktreeLabel(thread.id)} />,
    schedules.has(thread.id) && <AlarmClock key="automation" className="task-automation" size={13} aria-label={scheduleLabel(schedules.get(thread.id)!)} />,
    blockedThreadIds.has(thread.id)
      ? <span key="status" className="task-attention approval" aria-label={BLOCKED_LABEL} />
      : runningThreadIds.has(thread.id)
        ? <ThreadSpinner key="status" />
        : attentionMark(thread, sideChatAttention.has(thread.id)),
    <ThreadEngineIcon key="engine" engine={thread.engine} className="task-engine" size={13} />,
  ].filter(Boolean);

  const rowActions = (thread: Thread, action: RowAction) => rowActionButtons(thread, action, schedules.has(thread.id), onDismissThread, onArchiveThread);

  /**
   * Every thread row ends in the same rail: two layers of icons over one set of slots, the marks it
   * carries at rest and the actions it offers hovered. Both fill the rail from its right edge, so an
   * action lands on the mark it stands in for, and every rail is the same width, so the slots line up
   * down the list. A layer that gains an icon keeps the other layer's geometry.
   */
  const threadRail = (thread: Thread, action: RowAction) => {
    const actions = rowActions(thread, action);
    return (
      <span className="row-rail">
        <span className="row-layer row-marks">{rowMarks(thread)}</span>
        {actions.length > 0 && <span className="row-layer row-actions">{actions}</span>}
      </span>
    );
  };

  /** A row on a computer that cannot be reached is drawn, greyed, and takes nothing. */
  const offline = (thread: Thread) => threadHosts.get(thread.id)?.offline === true;

  /** The row itself, which is the same whether the list around it lets it be dragged or not. */
  const rowBody = (thread: Thread, className: string, content: React.ReactNode, action: RowAction, priority = false) => {
    const away = offline(thread);
    return (
    <>
    <div
      className={`${thread.role ? `${className} role-${thread.role}` : className}${away ? " offline" : ""}`}
      aria-disabled={away || undefined}
      onClick={away ? undefined : () => onSelectThread(thread.id)}
      onDoubleClick={away ? undefined : (event) => threadNames.start(thread.id, event.currentTarget.closest(".task-entry"))}
      onContextMenu={(event) => {
        event.preventDefault();
        if (away) return;
        threadNames.row.current = event.currentTarget.closest(".task-entry");
        setThreadMenuPosition({ x: event.clientX, y: event.clientY });
        onSetOpenMenu(`task:${thread.id}`);
      }}
      title={thread.title}
    >
      {threadNames.editing === thread.id
        ? <RenameInput
            inputRef={threadNames.input}
            className="task-rename"
            label={`Rename ${thread.title}`}
            value={thread.title}
            onCommit={(value) => threadNames.commit(thread.id, value)}
            onCancel={threadNames.cancel}
          />
        : <>{content}{threadRail(thread, away ? "none" : action)}</>}
    </div>
    {openMenu === `task:${thread.id}` && <ContextMenu
      at={threadMenuPosition}
      returnFocus={threadNames.row}
      onClose={() => onSetOpenMenu(null)}
      entries={threadMenuEntries(thread, {
        onRename: () => threadNames.start(thread.id),
        onFork: (worktree) => onForkThread(thread.id, worktree),
        onArchive: () => onArchiveThread(thread.id),
        onSetRole: (role) => onSetThreadRole(thread.id, role),
        ...(priority ? { onSnooze: (hours: SnoozeHours) => onSnoozeThread(thread.id, hours) } : {}),
      })}
    />}
    </>
    );
  };

  const selectOnEnter = (event: React.KeyboardEvent, thread: Thread) => {
    if (event.key === "Enter" && !offline(thread)) onSelectThread(thread.id);
  };

  const threadRow = (thread: Thread, index: number, className: string, content: React.ReactNode) => (
    <Draggable draggableId={thread.id} index={index} key={thread.id} isDragDisabled={offline(thread)}>
      {(provided: DraggableProvided, snapshot) => (
        <div
          className={`task-entry ${snapshot.isDragging ? "is-dragging" : ""}`}
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onKeyDown={(event) => selectOnEnter(event, thread)}
        >
          {rowBody(thread, className, content, "archive")}
        </div>
      )}
    </Draggable>
  );

  /** Activity mode ranks its rows itself, so nothing there is dragged and no list places it. */
  const activityRow = (thread: Thread, action: RowAction, priority: boolean) => (
    <div className="task-entry" key={thread.id} tabIndex={0} onKeyDown={(event) => selectOnEnter(event, thread)}>
      {rowBody(thread, `task-row ${thread.id === currentId ? "active" : ""}`, (
        <span className="task-row-text">
          <span>{thread.title}</span>
          <small>{activityMeta(thread, threadHosts.get(thread.id), projects, formatTime)}</small>
        </span>
      ), action, priority)}
    </div>
  );

  return { threadRow, activityRow };
}

export type ThreadRowRenderer = ReturnType<typeof useThreadRows>["threadRow"];
export type ActivityRowRenderer = ReturnType<typeof useThreadRows>["activityRow"];
