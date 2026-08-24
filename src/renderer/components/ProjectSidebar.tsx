import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { DragDropContext, Draggable, Droppable, type DraggableProvided, type DropResult } from "@hello-pangea/dnd";
import { AlarmClock, Archive, Check, CheckCheck, ChevronLeft, ChevronRight, FolderSymlink, Inbox, Settings, SquarePen } from "lucide-react";
import { folderName, projectName, threadActivityAt } from "../../domain/task";
import { dismissableTasks, hasUnreadAttention, newestUnreadFinding } from "../../domain/attention";
import type { TaskDropTarget } from "../../domain/task";
import type { Project, Task, TaskOutcome } from "../../domain/task";
import type { SidebarMode, SidebarSection, SidebarSections } from "../../domain/sidebar";
import { worktreeName } from "../../domain/worktree";
import type { ActivitySections } from "../../application/task-order";
import type { AutomationView } from "../../domain/automation";
import type { WorktreeGroup } from "../../application/workspace-state";
import { ContextMenu, PopoverMenu, type MenuEntry } from "./PopoverMenu";
import { threadLink } from "../../domain/thread-handles";
import { ShowMore } from "./ShowMore";
import { useDismissibleLayer } from "../focus";

const RECENTS_DROPPABLE = "recents";
const PROJECTS_DROPPABLE = "projects";
const PROJECT_DRAG = "project";
const PROJECT_TASK_LIMIT = 10;

/** What a row's trailing slot offers, if anything. Only one of them ever shows in a given list. */
type RowAction = "archive" | "dismiss" | "none";

const OUTCOME_LABELS: Record<TaskOutcome, string> = {
  finished: "Finished",
  failed: "Failed",
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

/** The activity mode's three lists, top to bottom, with the heading each is drawn under. */
const ACTIVITY_SECTIONS = [
  { key: "priority", label: "Priority" },
  { key: "running", label: "Running" },
  { key: "threads", label: "Threads" },
] as const satisfies ReadonlyArray<{ key: keyof ActivitySections & SidebarSection; label: string }>;

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

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
  );
}

/** One list a thread can be moved into: the project it belongs to, or none, and how long that list is. */
type MenuFolder = { id: string | null; label: string; count: number };

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

export type ProjectSidebarProps = {
  open: boolean;
  inactive: boolean;
  projects: Project[];
  orderedTasks: Task[];
  recentTasks: Task[];
  currentId: string | null;
  draftProjectId: string | null;
  expandedProjects: Set<string>;
  runningTaskIds: Set<string>;
  /** Threads stopped on an approval only the user can answer. A subset of {@link runningTaskIds}. */
  blockedTaskIds: Set<string>;
  schedules: Map<string, AutomationView>;
  worktreeTaskIds: Set<string>;
  /** The checkouts each project has, with the threads in each. A project offers starting one more there. */
  worktreeGroups: WorktreeGroup[];
  /** The same threads ranked by what wants the user, which is what activity mode draws. */
  activityTasks: ActivitySections;
  mode: SidebarMode;
  sections: SidebarSections;
  openMenu: string | null;
  settingsOpen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  /** A thread in the project, or in one of its checkouts when `worktreeId` names one. */
  onNewTask: (projectId?: string, worktreeId?: string) => void;
  onOpenFolder: () => void;
  onToggleProject: (projectId: string) => void;
  /** The name typed on the row itself. Blank gives the folder its own name back. */
  onRenameProject: (projectId: string, name: string) => void;
  onEditProject: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onSetMode: (mode: SidebarMode) => void;
  onSetSectionOpen: (section: SidebarSection, open: boolean) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSelectTask: (taskId: string) => void;
  onArchiveTask: (taskId: string) => void;
  /** Takes the dot off one thread, and off every thread carrying one. */
  onDismissTask: (taskId: string) => void;
  onDismissAll: () => void;
  onRenameTask: (taskId: string, title: string) => void;
  onMoveTask: (taskId: string, target: TaskDropTarget) => void;
  /** Copies the thread into a new one beside it, with a checkout of its own when `worktree`. */
  onForkTask: (taskId: string, worktree: boolean) => void;
  onMoveProject: (projectId: string, index: number) => void;
  onOpenSettings: () => void;
};

function groupedBy<T>(items: T[], keyFor: (item: T) => string | undefined): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    if (key) grouped.get(key)?.push(item) ?? grouped.set(key, [item]);
  }
  return grouped;
}

/** Which row of a list is being renamed, the input over it, and the row focus goes back to. */
function useRenaming(onCommit: (id: string, value: string) => void) {
  const [editing, setEditing] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const row = useRef<HTMLElement>(null);
  useDismissibleLayer(editing !== null, [input], () => input.current?.blur(), row);
  return {
    editing,
    input,
    row,
    start: (id: string, element?: HTMLElement | null) => {
      if (element) row.current = element;
      setEditing(id);
    },
    cancel: () => setEditing(null),
    commit: (id: string, value: string) => {
      setEditing(null);
      onCommit(id, value);
    },
  };
}

/**
 * A name being typed in place, over the row it belongs to. Enter and blur keep what was typed and
 * Escape leaves it, so both lists rename the same way.
 */
function RenameInput({ inputRef, className, label, value, placeholder, onCommit, onCancel }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  className: string;
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      ref={inputRef}
      className={className}
      aria-label={label}
      autoFocus
      defaultValue={value}
      placeholder={placeholder}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      /** The row answers Enter itself and dragging claims the arrow and space keys. */
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") onCommit(event.currentTarget.value);
        else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={(event) => onCommit(event.currentTarget.value)}
    />
  );
}

export function ProjectSidebar({
  open,
  inactive,
  projects,
  orderedTasks,
  recentTasks,
  currentId,
  draftProjectId,
  expandedProjects,
  runningTaskIds,
  blockedTaskIds,
  schedules,
  worktreeTaskIds,
  worktreeGroups,
  activityTasks,
  mode,
  sections,
  openMenu,
  settingsOpen,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  onNewTask,
  onOpenFolder,
  onToggleProject,
  onRenameProject,
  onEditProject,
  onRemoveProject,
  onSetMode,
  onSetSectionOpen,
  onSetOpenMenu,
  onSelectTask,
  onArchiveTask,
  onDismissTask,
  onDismissAll,
  onRenameTask,
  onMoveTask,
  onForkTask,
  onMoveProject,
  onOpenSettings,
}: ProjectSidebarProps) {
  const [taskMenuPosition, setTaskMenuPosition] = useState({ x: 0, y: 0 });
  const list = useRef<HTMLElement>(null);
  const taskNames = useRenaming((taskId, value) => { if (value.trim()) onRenameTask(taskId, value); });
  const projectNames = useRenaming(onRenameProject);
  const [showAllTasks, setShowAllTasks] = useState<Set<string>>(new Set());
  let timeFormatter: Intl.DateTimeFormat | undefined;
  const formatTime = (value: number) => (timeFormatter ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })).format(value);

  const tasksByProject = useMemo(() => groupedBy(orderedTasks, (task) => task.projectId), [orderedTasks]);
  /** Every list a thread can be moved into, with the length of each, which is where a move lands. */
  const folders = useMemo((): MenuFolder[] => [
    { id: null, label: "No folder", count: recentTasks.length },
    ...projects.map((project) => ({ id: project.id, label: projectName(project), count: tasksByProject.get(project.id)?.length ?? 0 })),
  ], [projects, recentTasks.length, tasksByProject]);
  const checkoutsByProject = useMemo(() => groupedBy(worktreeGroups, (group) => group.worktree.projectId), [worktreeGroups]);

  const checkoutNames = new Map(worktreeGroups.flatMap(({ worktree, tasks }) =>
    tasks.map((task) => [task.id, worktreeName(worktree)] as const)));
  /** A thread's own mark names its checkout, which is what one flat list leaves it to say. */
  const worktreeLabel = (taskId: string) => `Works in ${checkoutNames.get(taskId) ?? "a worktree"}`;

  /** The final slot always belongs to run status, so starting or stopping a run moves no other mark. */
  const railSlots = [...orderedTasks, ...recentTasks].reduce((widest, task) => Math.max(widest, markCount(task)), 1);

  function markCount(task: Task) {
    return Number(worktreeTaskIds.has(task.id)) + Number(schedules.has(task.id)) + 1;
  }

  /** Stepping through threads from the keyboard is blind unless the list follows the one now open. */
  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(".task-row.active, .project-task-row.active")?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  /** A folder shows its first ten tasks, and enough more to keep the open one in view. */
  function visibleCount(projectTasks: Task[], projectId: string) {
    if (showAllTasks.has(projectId)) return projectTasks.length;
    const current = projectTasks.findIndex((task) => task.id === currentId);
    return Math.max(PROJECT_TASK_LIMIT, current + 1);
  }

  function toggleShowAll(projectId: string) {
    setShowAllTasks((shown) => {
      const next = new Set(shown);
      if (!next.delete(projectId)) next.add(projectId);
      return next;
    });
  }

  /** One context carries both drags; `type` says which list the drop belongs to. */
  function finishDrag({ draggableId, type, source, destination }: DropResult) {
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) return;
    if (type === PROJECT_DRAG) return onMoveProject(draggableId, destination.index);
    onMoveTask(draggableId, {
      projectId: destination.droppableId === RECENTS_DROPPABLE ? null : destination.droppableId,
      index: destination.index,
    });
  }

  function resizeSidebar(target: HTMLElement, clientX: number) {
    const sidebar = target.parentElement;
    /** The width is a custom property because the hidden state slides the sidebar out by that same width. */
    if (sidebar) sidebar.style.setProperty("--sidebar-width", `${Math.min(innerWidth / 2, Math.max(220, clientX - sidebar.getBoundingClientRect().left))}px`);
  }

  /** What a thread is: the checkout it works in, the schedule it runs on, and what it is doing now. */
  const rowMarks = (task: Task): React.ReactNode[] => {
    const status = blockedTaskIds.has(task.id)
      ? <span key="status" className="task-attention approval" aria-label={BLOCKED_LABEL} />
      : runningTaskIds.has(task.id)
        ? <TaskSpinner key="status" />
        : attentionMark(task);
    return [
      worktreeTaskIds.has(task.id) && <FolderSymlink key="worktree" className="task-worktree" size={13} aria-label={worktreeLabel(task.id)} />,
      schedules.has(task.id) && <AlarmClock key="automation" className="task-automation" size={13} aria-label={scheduleLabel(schedules.get(task.id)!)} />,
      status || <span key="status" className="task-status-slot" aria-hidden="true" />,
    ].filter(Boolean);
  };

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

  return (
    <DragDropContext onDragEnd={finishDrag}>
    <aside
      ref={list}
      className={`sidebar ${open ? "compact-open" : "hidden"}`}
      inert={inactive || !open}
      style={{ "--row-slots": railSlots } as React.CSSProperties}
    >
      <div className="traffic-space">
        <div className="sidebar-modes">
          {/** One switch, not a pair: pressed ranks the threads, released puts them back under their folders. */}
          <button
            className={`thread-nav-button ${mode === "activity" ? "active" : ""}`}
            type="button"
            aria-label="Rank threads by activity"
            aria-pressed={mode === "activity"}
            onClick={() => onSetMode(mode === "activity" ? "projects" : "activity")}
          >
            <Inbox size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="thread-nav">
          <button className="thread-nav-button" type="button" aria-label="Go back" disabled={!canGoBack} onClick={onGoBack}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button className="thread-nav-button" type="button" aria-label="Go forward" disabled={!canGoForward} onClick={onGoForward}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <button className="new-task-button" onClick={() => onNewTask()}>
        <span className="new-task-icon" aria-hidden="true">＋</span>
        <span>New task</span>
      </button>

      <div className="sidebar-scroll">
        {mode === "activity" && ACTIVITY_SECTIONS.map(({ key, label }) => {
          const tasks = activityTasks[key];
          const dottedCount = key === "priority" ? dismissableTasks(tasks).length : 0;
          return (
            <section className="activity-group" key={key}>
              <div className="section-heading activity-heading">
                <button className="section-toggle" onClick={() => onSetSectionOpen(key, !sections[key])} aria-expanded={sections[key]}>
                  <span>{label}</span>
                  <span className="section-chevron" aria-hidden="true" />
                </button>
                {key === "priority" && dottedCount > 0 && (
                  <button className="section-action" onClick={onDismissAll} aria-label="Dismiss all">
                    <CheckCheck size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
              {sections[key] && tasks.length === 0 && key === "priority" && <p className="sidebar-empty">Nothing waiting</p>}
              {/** Only Priority speaks: a spinner appearing in Running is not news anyone needs read out. */}
              {sections[key] && <nav className="task-list" aria-label={label} aria-live={key === "priority" ? "polite" : undefined}>
                {tasks.map((task) => activityRow(task, key === "priority" && !blockedTaskIds.has(task.id) ? "dismiss" : "none"))}
              </nav>}
            </section>
          );
        })}

        {mode === "projects" && <>
        <div className="section-heading projects-heading">
          <button className="section-toggle" onClick={() => onSetSectionOpen("projects", !sections.projects)} aria-expanded={sections.projects}>
            <span>Projects</span><span className="section-chevron" aria-hidden="true" />
          </button>
          <button className="section-action add-project" onClick={onOpenFolder} aria-label="Add project">＋</button>
        </div>
        {sections.projects && <Droppable droppableId={PROJECTS_DROPPABLE} type={PROJECT_DRAG}>
          {(list) => (
            <nav className="project-list" aria-label="Projects" ref={list.innerRef} {...list.droppableProps}>
              {projects.map((project, projectIndex) => {
                const projectTasks = tasksByProject.get(project.id) ?? [];
                /** A checkout is somewhere a thread can be started, not a list the sidebar draws. */
                const checkouts = checkoutsByProject.get(project.id) ?? [];
                const expanded = expandedProjects.has(project.id);
                const shown = visibleCount(projectTasks, project.id);
                const hidden = projectTasks.length - shown;
                return (
                  <Draggable draggableId={project.id} index={projectIndex} key={project.id} disableInteractiveElementBlocking>
                    {(dragged: DraggableProvided, snapshot) => (
                      <section
                        className={`project-group ${snapshot.isDragging ? "is-dragging" : ""}`}
                        ref={dragged.innerRef}
                        {...dragged.draggableProps}
                      >
                        {/** The header row is the handle, buttons and all: the library refuses to lift from a
                          *  button unless told otherwise, and the row is nothing but buttons. It swallows the
                          *  click a drag ends on, so the row keeps its click-to-fold. */}
                        <div className={`project-row ${draftProjectId === project.id ? "current" : ""}`} {...dragged.dragHandleProps}>
                          {projectNames.editing === project.id
                            ? <RenameInput
                                inputRef={projectNames.input}
                                className="project-rename"
                                label={`Rename ${projectName(project)}`}
                                value={projectName(project)}
                                placeholder={folderName(project.root)}
                                onCommit={(value) => projectNames.commit(project.id, value)}
                                onCancel={projectNames.cancel}
                              />
                            : <button
                                className="project-main"
                                onClick={() => onToggleProject(project.id)}
                                onDoubleClick={(event) => projectNames.start(project.id, event.currentTarget.closest(".project-row"))}
                                title={project.root}
                                aria-expanded={expanded}
                              >
                                <span className="folder-icon"><FolderIcon /></span>
                                <span>{projectName(project)}</span>
                              </button>}
                          <PopoverMenu
                            id={`project:${project.id}`}
                            openMenu={openMenu}
                            onSetOpenMenu={onSetOpenMenu}
                            label={`More options for ${projectName(project)}`}
                            className="project-menu"
                            items={[
                              { label: "New task", onSelect: () => onNewTask(project.id) },
                              ...checkouts.map(({ worktree }) => ({
                                label: `New thread in ${worktreeName(worktree)}`,
                                onSelect: () => onNewTask(project.id, worktree.id),
                              })),
                              { label: expanded ? "Collapse" : "Expand", onSelect: () => onToggleProject(project.id) },
                              { label: "Edit…", onSelect: () => onEditProject(project.id) },
                              { label: "Remove", danger: true, onSelect: () => onRemoveProject(project.id) },
                            ]}
                          />
                          <button className="project-new" onClick={() => onNewTask(project.id)} aria-label={`New task in ${projectName(project)}`}><SquarePen size={16} /></button>
                        </div>
                        {/** A folded folder holds no droppable, so a drag neither unfolds it nor opens a gap where it sits. */}
                        {expanded && <Droppable droppableId={project.id} type="task">
                          {(provided) => (
                            <div className="project-tasks" ref={provided.innerRef} {...provided.droppableProps}>
                              {projectTasks.slice(0, shown).map((task, index) => taskRow(task, index, `project-task-row ${task.id === currentId ? "active" : ""}`, <span>{task.title}</span>))}
                              {provided.placeholder}
                            </div>
                          )}
                        </Droppable>}
                        {expanded && projectTasks.length === 0 && <p className="empty-tasks">No threads yet</p>}
                        {expanded && (hidden > 0 || showAllTasks.has(project.id)) && (
                          <ShowMore
                            label={hidden > 0 ? `Show ${hidden} more` : "Show less"}
                            expanded={showAllTasks.has(project.id)}
                            onSelect={() => toggleShowAll(project.id)}
                          />
                        )}
                      </section>
                    )}
                  </Draggable>
                );
              })}
              {list.placeholder}
            </nav>
          )}
        </Droppable>}

        <div className="section-heading recents-heading">
          <button className="section-toggle" onClick={() => onSetSectionOpen("recents", !sections.recents)} aria-expanded={sections.recents}>
            <span>Recents</span><span className="section-chevron" aria-hidden="true" />
          </button>
          <PopoverMenu
            id="recents"
            openMenu={openMenu}
            onSetOpenMenu={onSetOpenMenu}
            label="Recent chat options"
            className="section-menu"
            popoverClassName="section-menu-popover"
            items={[{ label: "New chat", onSelect: () => onNewTask() }]}
          />
          <button className="section-action recent-new" onClick={() => onNewTask()} aria-label="New chat"><SquarePen size={16} /></button>
        </div>
        {sections.recents && <Droppable droppableId={RECENTS_DROPPABLE} type="task">
          {(provided, snapshot) => (
            <nav className="task-list" aria-label="Project-less tasks" ref={provided.innerRef} {...provided.droppableProps}>
              {recentTasks.length === 0 && !snapshot.isDraggingOver && <p className="sidebar-empty">No chats</p>}
              {recentTasks.map((task, index) => taskRow(task, index, `task-row ${task.id === currentId ? "active" : ""}`, <span className="task-row-text">
                  <span>{task.title}</span>
                  <small>{formatTime(threadActivityAt(task))}</small>
                </span>))}
              {provided.placeholder}
            </nav>
          )}
        </Droppable>}
        </>}
      </div>
      <button className={`sidebar-settings ${settingsOpen ? "active" : ""}`} type="button" aria-pressed={settingsOpen} onClick={onOpenSettings}>
        <Settings size={17} aria-hidden="true" />
        <span>Settings</span>
      </button>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeSidebar(event.currentTarget, event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const sidebar = event.currentTarget.parentElement;
          if (sidebar) resizeSidebar(event.currentTarget, sidebar.getBoundingClientRect().right + (event.key === "ArrowLeft" ? -10 : 10));
        }}
      />
    </aside>
    </DragDropContext>
  );
}
