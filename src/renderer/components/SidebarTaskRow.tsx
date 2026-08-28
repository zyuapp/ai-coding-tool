import { useLayoutEffect, useRef, useState } from "react";
import { Draggable, type DraggableProvided } from "@hello-pangea/dnd";
import { AlarmClock, Archive, Check, FolderSymlink } from "lucide-react";
import { projectName, threadActivityAt } from "../../domain/task";
import { hasUnreadAttention, newestUnreadFinding } from "../../domain/attention";
import type { TaskDropTarget } from "../../domain/task";
import type { Project, Task, TaskOutcome } from "../../domain/task";
import { worktreeName } from "../../domain/worktree";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { ContextMenu, type MenuEntry } from "./PopoverMenu";
import { threadLink } from "../../domain/thread-handles";
import { RenameInput, useRenaming } from "./SidebarRename";
import { EngineGlyph, hasEngineGlyph } from "./EngineGlyph";

/** What a row's trailing slot offers, if anything. Only one of them ever shows in a given list. */
export type RowAction = "archive" | "dismiss" | "none";

const OUTCOME_LABELS: Record<TaskOutcome, string> = {
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

const BLOCKED_LABEL = "Needs approval";

/** The mark says the thread runs on a schedule; whether that schedule is well is the part worth hearing. */
function scheduleLabel(automation: AutomationView) {
  if (automation.paused) return "Schedule paused";
  if (automation.nextRunAt === null) return "Schedule missed its run";
  if (automation.lastStatus === "failed") return "Runs on a schedule, and its last run failed";
  if (automation.lastStatus === "skipped") return "Runs on a schedule, and its last tick could not run";
  return "Runs on a schedule";
}

/** The dot a row carries. What a run found is named outright: "Finished" says nothing a headline does. */
function attentionMark(task: Task) {
  const finding = newestUnreadFinding(task);
  if (finding) return <span key="status" className="task-attention" aria-label={finding.headline} />;
  if (!hasUnreadAttention(task)) return false;
  return <span key="status" className={`task-attention ${task.outcome!}`} aria-label={OUTCOME_LABELS[task.outcome!]} />;
}

/**
 * What a row says under its title in activity mode: which folder it lives in, and when it last moved.
 * A row carrying something a run found says that instead — the headline is why the row is in Priority.
 */
function activityMeta(task: Task, projects: Project[], formatTime: (value: number) => string) {
  const finding = newestUnreadFinding(task);
  if (finding) return finding.headline;
  const project = projects.find((item) => item.id === task.projectId);
  return [project && projectName(project), formatTime(threadActivityAt(task))].filter(Boolean).join(" · ");
}

function TaskSpinner() {
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

/** One list a thread can be moved into: the project it belongs to, or none, and how long that list is. */
export type MenuFolder = { id: string | null; label: string; count: number };

/**
 * What a thread offers on a right-click, grouped the way a menu on this platform is: naming it,
 * taking a reference to it, copying it, then putting it away. A thread working in a checkout is
 * only ever moved within the project that checkout was cut from.
 */
function threadMenuEntries(task: Task, folders: MenuFolder[], actions: {
  onRename: () => void;
  onMove: (target: TaskDropTarget) => void;
  onFork: (worktree: boolean) => void;
  onArchive: () => void;
}): MenuEntry[] {
  const inFolder = task.projectId ?? null;
  return [
    { label: "Rename", onSelect: actions.onRename },
    {
      label: "Move to folder",
      /** The list it is already in is ticked, not an offer to send it to the bottom of that list. */
      items: folders.map((folder) => ({
        label: folder.label,
        checked: folder.id === inFolder,
        disabled: Boolean(task.worktreeId) && folder.id !== inFolder,
        ...(folder.id === inFolder ? {} : { onSelect: () => actions.onMove({ projectId: folder.id, index: folder.count }) }),
      })),
    },
    "separator",
    { label: "Copy link", onSelect: () => void navigator.clipboard?.writeText(threadLink(task.id)) },
    "separator",
    { label: "Fork", onSelect: () => actions.onFork(false) },
    { label: "Fork into a new worktree", onSelect: () => actions.onFork(true) },
    "separator",
    { label: "Archive", danger: true, onSelect: actions.onArchive },
  ];
}

export type TaskRowsOptions = {
  projects: Project[];
  currentId: string | null;
  runningTaskIds: Set<string>;
  /** Threads stopped on an approval only the user can answer. A subset of `runningTaskIds`. */
  blockedTaskIds: Set<string>;
  schedules: Map<string, AutomationView>;
  worktreeTaskIds: Set<string>;
  worktreeGroups: WorktreeGroup[];
  /** Every list a thread can be moved into, which its menu offers. */
  folders: MenuFolder[];
  openMenu: string | null;
  formatTime: (value: number) => string;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectTask: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
  onDismissTask: (taskId: string) => void;
  onRenameTask: (taskId: string, title: string) => void;
  onMoveTask: (taskId: string, target: TaskDropTarget) => void;
  onForkTask: (taskId: string, worktree: boolean) => void;
};

/** Both lists draw the same row, so both of them ask this for one: only the placement differs. */
export function useTaskRows({
  projects,
  currentId,
  runningTaskIds,
  blockedTaskIds,
  schedules,
  worktreeTaskIds,
  worktreeGroups,
  folders,
  openMenu,
  formatTime,
  onSetOpenMenu,
  onSelectTask,
  onArchiveTask,
  onDismissTask,
  onRenameTask,
  onMoveTask,
  onForkTask,
}: TaskRowsOptions) {
  const [taskMenuPosition, setTaskMenuPosition] = useState({ x: 0, y: 0 });
  const taskNames = useRenaming((taskId, value) => { if (value.trim()) onRenameTask(taskId, value); });

  const checkoutNames = new Map(worktreeGroups.flatMap(({ worktree, tasks }) =>
    tasks.map((task) => [task.id, worktreeName(worktree)] as const)));
  /** A thread's own mark names its checkout, which is what one flat list leaves it to say. */
  const worktreeLabel = (taskId: string) => `Works in ${checkoutNames.get(taskId) ?? "a worktree"}`;

  /** What a thread is: the engine it runs on, the checkout it works in, the schedule it runs on, and what it is doing now. */
  const rowMarks = (task: Task): React.ReactNode[] => [
    hasEngineGlyph(task.engine) && <EngineGlyph key="engine" engine={task.engine} className="task-engine" />,
    worktreeTaskIds.has(task.id) && <FolderSymlink key="worktree" className="task-worktree" size={13} aria-label={worktreeLabel(task.id)} />,
    schedules.has(task.id) && <AlarmClock key="automation" className="task-automation" size={13} aria-label={scheduleLabel(schedules.get(task.id)!)} />,
    blockedTaskIds.has(task.id)
      ? <span key="status" className="task-attention approval" aria-label={BLOCKED_LABEL} />
      : runningTaskIds.has(task.id)
        ? <TaskSpinner key="status" />
        : attentionMark(task),
  ].filter(Boolean);

  /**
   * What can be done to a thread from its row. Activity mode offers dismissing on a priority row
   * - a thread still asking has nothing to dismiss - and nothing on the others, rather than two
   * different icons in one view; archiving a thread there is on its menu.
   */
  const rowActions = (task: Task, action: RowAction): React.ReactNode[] => [
    action === "dismiss" && <button
      key="dismiss"
      className="row-action task-dismiss"
      type="button"
      aria-label={schedules.has(task.id) ? `Dismiss ${task.title}, which keeps running on its schedule` : `Dismiss ${task.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onDismissTask(task.id);
      }}
    >
      <Check size={13} aria-hidden="true" />
    </button>,
    action === "archive" && <button
      key="archive"
      className="row-action task-archive"
      type="button"
      aria-label={`Archive ${task.title}`}
      onClick={(event) => {
        event.stopPropagation();
        onArchiveTask(task.id);
      }}
    >
      <Archive size={13} aria-hidden="true" />
    </button>,
  ].filter(Boolean);

  /**
   * Every task row ends in the same rail: two layers of icons over one set of slots, the marks it
   * carries at rest and the actions it offers hovered. Both fill the rail from its right edge, so an
   * action lands on the mark it stands in for, and every rail is the same width, so the slots line up
   * down the list. A layer that gains an icon keeps the other layer's geometry.
   */
  const taskRail = (task: Task, action: RowAction) => {
    const actions = rowActions(task, action);
    return (
      <span className="row-rail">
        <span className="row-layer row-marks">{rowMarks(task)}</span>
        {actions.length > 0 && <span className="row-layer row-actions">{actions}</span>}
      </span>
    );
  };

  /** The row itself, which is the same whether the list around it lets it be dragged or not. */
  const rowBody = (task: Task, className: string, content: React.ReactNode, action: RowAction) => (
    <>
    <div
      className={className}
      onClick={() => onSelectTask(task.id)}
      onDoubleClick={(event) => taskNames.start(task.id, event.currentTarget.closest(".task-entry"))}
      onContextMenu={(event) => {
        event.preventDefault();
        taskNames.row.current = event.currentTarget.closest(".task-entry");
        setTaskMenuPosition({ x: event.clientX, y: event.clientY });
        onSetOpenMenu(`task:${task.id}`);
      }}
      title={task.title}
    >
      {taskNames.editing === task.id
        ? <RenameInput
            inputRef={taskNames.input}
            className="task-rename"
            label={`Rename ${task.title}`}
            value={task.title}
            onCommit={(value) => taskNames.commit(task.id, value)}
            onCancel={taskNames.cancel}
          />
        : <>{content}{taskRail(task, action)}</>}
    </div>
    {openMenu === `task:${task.id}` && <ContextMenu
      at={taskMenuPosition}
      returnFocus={taskNames.row}
      onClose={() => onSetOpenMenu(null)}
      entries={threadMenuEntries(task, folders, {
        onRename: () => taskNames.start(task.id),
        onMove: (target) => onMoveTask(task.id, target),
        onFork: (worktree) => onForkTask(task.id, worktree),
        onArchive: () => onArchiveTask(task.id),
      })}
    />}
    </>
  );

  const selectOnEnter = (event: React.KeyboardEvent, taskId: string) => {
    if (event.key === "Enter") onSelectTask(taskId);
  };

  const taskRow = (task: Task, index: number, className: string, content: React.ReactNode) => (
    <Draggable draggableId={task.id} index={index} key={task.id}>
      {(provided: DraggableProvided, snapshot) => (
        <div
          className={`task-entry ${snapshot.isDragging ? "is-dragging" : ""}`}
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onKeyDown={(event) => selectOnEnter(event, task.id)}
        >
          {rowBody(task, className, content, "archive")}
        </div>
      )}
    </Draggable>
  );

  /** Activity mode ranks its rows itself, so nothing there is dragged and no list places it. */
  const activityRow = (task: Task, action: RowAction) => (
    <div className="task-entry" key={task.id} tabIndex={0} onKeyDown={(event) => selectOnEnter(event, task.id)}>
      {rowBody(task, `task-row ${task.id === currentId ? "active" : ""}`, (
        <span className="task-row-text">
          <span>{task.title}</span>
          <small>{activityMeta(task, projects, formatTime)}</small>
        </span>
      ), action)}
    </div>
  );

  return { taskRow, activityRow };
}

export type TaskRowRenderer = ReturnType<typeof useTaskRows>["taskRow"];
export type ActivityRowRenderer = ReturnType<typeof useTaskRows>["activityRow"];
