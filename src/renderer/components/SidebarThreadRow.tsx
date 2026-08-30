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
import { ContextMenu, type MenuEntry } from "./PopoverMenu";
import { threadLink } from "../../domain/thread-handles";
import { RenameInput, useRenaming } from "./SidebarRename";
import { ThreadEngineIcon } from "./ThreadEngineIcon";

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
 * What a row says under its title in activity mode: which folder it lives in, and when it last moved.
 * A row carrying something a run found says that instead — the headline is why the row is in Priority.
 */
function activityMeta(thread: Thread, projects: Project[], formatTime: (value: number) => string) {
  const finding = newestUnreadFinding(thread);
  if (finding) return finding.headline;
  const project = projects.find((item) => item.id === thread.projectId);
  return [project && projectName(project), formatTime(threadActivityAt(thread))].filter(Boolean).join(" · ");
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

/**
 * What a thread offers on a right-click, grouped the way a menu on this platform is: naming it,
 * taking a reference to it, copying it, then putting it away.
 */
function threadMenuEntries(thread: Thread, actions: {
  onRename: () => void;
  onFork: (worktree: boolean) => void;
  onArchive: () => void;
}): MenuEntry[] {
  return [
    { label: "Rename", onSelect: actions.onRename },
    "separator",
    { label: "Copy link", onSelect: () => void navigator.clipboard?.writeText(threadLink(thread.id)) },
    "separator",
    { label: "Fork", onSelect: () => actions.onFork(false) },
    { label: "Fork into a new worktree", onSelect: () => actions.onFork(true) },
    "separator",
    { label: "Archive", danger: true, onSelect: actions.onArchive },
  ];
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
  openMenu: string | null;
  /** The digit that reaches a thread, while the command key is held. Nothing otherwise. */
  slotOf: (threadId: string) => number | undefined;
  formatTime: (value: number) => string;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string) => void;
  onDismissThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onForkThread: (threadId: string, worktree: boolean) => void;
};

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
  openMenu,
  slotOf,
  formatTime,
  onSetOpenMenu,
  onSelectThread,
  onArchiveThread,
  onDismissThread,
  onRenameThread,
  onForkThread,
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

  /** What a thread is: its engine, checkout, schedule, and what it is doing now. */
  const rowMarks = (thread: Thread): React.ReactNode[] => [
    <ThreadEngineIcon key="engine" engine={thread.engine} className="task-engine" size={13} />,
    worktreeThreadIds.has(thread.id) && <FolderSymlink key="worktree" className={worktreeMark(thread.id)} size={13} aria-label={worktreeLabel(thread.id)} />,
    schedules.has(thread.id) && <AlarmClock key="automation" className="task-automation" size={13} aria-label={scheduleLabel(schedules.get(thread.id)!)} />,
    blockedThreadIds.has(thread.id)
      ? <span key="status" className="task-attention approval" aria-label={BLOCKED_LABEL} />
      : runningThreadIds.has(thread.id)
        ? <ThreadSpinner key="status" />
        : attentionMark(thread, sideChatAttention.has(thread.id)),
  ].filter(Boolean);

  /**
   * What can be done to a thread from its row. Activity mode offers dismissing on a priority row
   * - a thread still asking has nothing to dismiss - and nothing on the others, rather than two
   * different icons in one view; archiving a thread there is on its menu.
   */
  const rowActions = (thread: Thread, action: RowAction): React.ReactNode[] => [
    action === "dismiss" && <button
      key="dismiss"
      className="row-action task-dismiss"
      type="button"
      aria-label={schedules.has(thread.id) ? `Dismiss ${thread.title}, which keeps running on its schedule` : `Dismiss ${thread.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onDismissThread(thread.id);
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
        onArchiveThread(thread.id);
      }}
    >
      <Archive size={13} aria-hidden="true" />
    </button>,
  ].filter(Boolean);

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

  /** The row itself, which is the same whether the list around it lets it be dragged or not. */
  const rowBody = (thread: Thread, className: string, content: React.ReactNode, action: RowAction) => {
    const slot = slotOf(thread.id);
    return (
    <>
    {slot !== undefined && <span className="row-number" aria-hidden="true">{slot}</span>}
    <div
      className={className}
      onClick={() => onSelectThread(thread.id)}
      onDoubleClick={(event) => threadNames.start(thread.id, event.currentTarget.closest(".task-entry"))}
      onContextMenu={(event) => {
        event.preventDefault();
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
        : <>{content}{threadRail(thread, action)}</>}
    </div>
    {openMenu === `task:${thread.id}` && <ContextMenu
      at={threadMenuPosition}
      returnFocus={threadNames.row}
      onClose={() => onSetOpenMenu(null)}
      entries={threadMenuEntries(thread, {
        onRename: () => threadNames.start(thread.id),
        onFork: (worktree) => onForkThread(thread.id, worktree),
        onArchive: () => onArchiveThread(thread.id),
      })}
    />}
    </>
    );
  };

  const selectOnEnter = (event: React.KeyboardEvent, threadId: string) => {
    if (event.key === "Enter") onSelectThread(threadId);
  };

  const threadRow = (thread: Thread, index: number, className: string, content: React.ReactNode) => (
    <Draggable draggableId={thread.id} index={index} key={thread.id}>
      {(provided: DraggableProvided, snapshot) => (
        <div
          className={`task-entry ${snapshot.isDragging ? "is-dragging" : ""}`}
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onKeyDown={(event) => selectOnEnter(event, thread.id)}
        >
          {rowBody(thread, className, content, "archive")}
        </div>
      )}
    </Draggable>
  );

  /** Activity mode ranks its rows itself, so nothing there is dragged and no list places it. */
  const activityRow = (thread: Thread, action: RowAction) => (
    <div className="task-entry" key={thread.id} tabIndex={0} onKeyDown={(event) => selectOnEnter(event, thread.id)}>
      {rowBody(thread, `task-row ${thread.id === currentId ? "active" : ""}`, (
        <span className="task-row-text">
          <span>{thread.title}</span>
          <small>{activityMeta(thread, projects, formatTime)}</small>
        </span>
      ), action)}
    </div>
  );

  return { threadRow, activityRow };
}

export type ThreadRowRenderer = ReturnType<typeof useThreadRows>["threadRow"];
export type ActivityRowRenderer = ReturnType<typeof useThreadRows>["activityRow"];
