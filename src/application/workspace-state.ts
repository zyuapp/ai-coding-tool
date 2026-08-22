import { runStatusFor, type ApprovalView, type RunTransitionState, type StreamingTail, type TaskRunStatus } from "./task-workspace.js";
import { backfillProjectSortIndex, orderProjects } from "./project-order.js";
import { activitySections, backfillSortIndex, orderTasks } from "./task-order.js";
import type { ChangedFilesResult, DiffSummaryResult } from "../contracts/ipc.js";
import type { ReadingPoint } from "../contracts/commands.js";

export type { ReadingPoint };
import { fileFingerprint, rangeKey, UNCOMMITTED, type DiffRange } from "../domain/diff.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import type { AutomationView } from "../domain/automation.js";
import type { BrowserApproval, BrowserTab } from "../domain/browser.js";
import { findHits, type FindHit, type FindResults, type FindTarget } from "../domain/find.js";
import { shortcutSettings, type ShortcutOverrides, type ShortcutSurface } from "../domain/shortcuts.js";
import type { SidebarMode, SidebarSections } from "../domain/sidebar.js";
import type { TerminalSession } from "../domain/terminal.js";
import { DEFAULT_THEME, DEFAULT_THEME_MODE, type ThemeMode } from "../domain/theme.js";
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, READING_SIZE, TERMINAL_SIZE } from "../domain/typography.js";
import type { Workflow } from "../domain/workflow.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type AgentEffort, type AgentModel, type ExecutionPolicy } from "../domain/run.js";
import { legacyProjectId, retainedTasks, threadActivityAt, type Annotation, type PastedText, type Project, type StagedImage, type Task, type TaskStoreData } from "../domain/task.js";
import { worktreeName, type Worktree } from "../domain/worktree.js";

/**
 * A run the user or the scheduler asked for that is still resolving its workspace. It lives in state
 * rather than in a closure so the reducer can re-check the task when resolution lands.
 */
export type PendingRun = {
  id: string;
  runId: string;
  origin: "composer" | "automation";
  taskId?: string;
  projectId?: string;
  /** The checkout the run was told to happen in, for a thread that does not exist yet to claim. */
  worktreeId?: string;
  /** Composer only: which draft to clear once the run starts. */
  draftKey?: string;
  /** What the user typed, before attachments are appended. Titles a brand new task. */
  text: string;
  prompt: string;
  attachments: string[];
  annotations?: Annotation[];
  pastes?: PastedText[];
  detail?: string;
  policy?: ExecutionPolicy;
  automationId?: string;
  /** Automation only: this tick may settle without surfacing if it earns the silence. */
  quiet?: true;
  /** Automation only: a cron tick has nobody to answer its approvals, so the run may answer its own. */
  unattended?: true;
  /** Queued messages this run is draining, cleared only once the run actually starts. */
  queuedIds?: string[];
  /** Set when the checkout this run needs is being made on the way, which is the slow part of resolving. */
  creatingWorktree?: boolean;
};

/** Where a thread's runs happen, with the moment between asking for a checkout and having one. */
export type ThreadLocation =
  | { kind: "local" }
  | { kind: "creating" }
  | { kind: "worktree"; worktree: Worktree };

/** What a thread is waiting on before it can work: a checkout being made, or a run finding one. */
export type ThreadWait = "worktree" | "run";

/** A checkout with the threads working in it, which is how a project offers starting one more there. */
export type WorktreeGroup = {
  worktree: Worktree;
  tasks: Task[];
};

/**
 * Something the user typed while a run was going. It waits for the run to finish, unless it is
 * steered into that run first.
 */
export type QueuedMessage = {
  id: string;
  text: string;
  prompt: string;
  attachments: string[];
  annotations?: Annotation[];
  pastes?: PastedText[];
  /** Set once steering is on its way to the agent, which is the point of no return. */
  steering?: boolean;
};

/**
 * One forked conversation. Its thread is an ordinary task in `tasks`, so everything keyed by a task
 * id — drafts, queued messages, approvals, steering — reaches it too. This record only marks the
 * task as one that is never persisted and never listed.
 */
export type SideChat = {
  id: string;
  sourceTaskId: string;
  error: string | null;
};

export type SideChatView = SideChat & {
  title: string;
  task: Task;
  prompt: string;
  annotations: Annotation[];
  pastes: PastedText[];
  images: StagedImage[];
  running: boolean;
  compacting: boolean;
  status: TaskRunStatus;
  streamingTail: StreamingTail | null;
  queuedMessages: QueuedMessage[];
  approval?: ApprovalView;
  readingPoint: ReadingPoint;
};

/** The ids of every thread that only lives for this session. */
export function sideChatIds(state: Pick<WorkspaceState, "sideChats">) {
  return new Set(state.sideChats.map((chat) => chat.id));
}

/**
 * What the find bar is looking for, and where. Only the query and the match the user stepped to live
 * here: what a query matches is derived, so a thread that is still streaming keeps finding what it
 * has just printed.
 */
export type FindState = {
  target: FindTarget;
  query: string;
  /** Which match the user stepped to, counting from zero. */
  index: number;
  /** Bumped whenever find is asked for again, which is all the bar needs to take the caret back. */
  focus: number;
};

/** Whether two reading points name the same place, which decides whether a report is worth making. */
export function sameReadingPoint(a: ReadingPoint, b: ReadingPoint) {
  if (a === null || b === null) return a === b;
  return a.anchor === b.anchor && a.depth === b.depth;
}

/** The branch a thread is to start from. `create` names one the repository does not have yet. */
export type DraftBranch = { name: string; create: boolean };

/**
 * One thread's review of its own checkout: what it is comparing, which files it has folded away, and
 * which it has ticked off. Only the file list is held; a patch is content, so it is read when its
 * file is drawn and never becomes state, the way a page's contents and a shell's scrollback never do.
 */
export type DiffState = {
  range: DiffRange;
  /** The checkout the list was read from, so a thread that moves does not read a stale one. */
  workspaceId: string | null;
  result: DiffSummaryResult | null;
  loading: boolean;
  /** Files folded shut. Everything is open until the user says otherwise, so a review reads top to bottom. */
  collapsed: string[];
  /** Ticked-off paths, each against the counts it had when ticked, so a file that moves un-ticks. */
  viewed: Record<string, string>;
  split: boolean;
};

/**
 * One thread's right dock: whether it is showing, which panels are open as tabs, which tab is on top,
 * and the pages and shells that thread opened. A page and a shell belong to the thread that asked for
 * one, so a run drives its own dock and never the dock of whichever thread the user is looking at.
 * Only the records live here. What a page holds and what a shell has printed never become state.
 */
export type ThreadDock = {
  open: boolean;
  /** Whether the dock is taking the whole workspace, which only a dock that is showing ever does. */
  expanded: boolean;
  panels: string[];
  tab: string;
  /** The workflow the dock's workflow panel is following, kept per thread the way its panels are. */
  workflowId: string | null;
  browserTabs: BrowserTab[];
  browserTabId: string | null;
  terminals: TerminalSession[];
  terminalId: string | null;
};

export type WorkspaceState = {
  tasks: Task[];
  projects: Project[];
  /**
   * Every checkout the app made and a thread still claims. A checkout outlives the thread that asked
   * for it, so it lives here rather than inside one of them, and goes when the last claim does.
   */
  worktrees: Worktree[];
  /** Threads whose checkout is being made, so nothing asks for a second one while the first lands. */
  creatingWorktrees: string[];
  lastFolder: string | null;
  currentId: string | null;
  /** Threads the user has landed on this session, oldest first, with a cursor for back and forward. */
  history: string[];
  historyIndex: number;
  draftProjectId: string | null;
  draftPolicy: ExecutionPolicy;
  /** How the next new thread starts: which branch, and whether it gets a checkout of its own. */
  draftBranch: DraftBranch | null;
  draftWorktree: boolean;
  /** The checkout the next new thread starts in, when the user picked one the project already has. */
  draftWorktreeId: string | null;
  draftModel: AgentModel;
  draftEffort: AgentEffort;
  prompts: Record<string, string>;
  /** Annotations waiting in each composer, keyed the way `prompts` is. */
  annotations: Record<string, Annotation[]>;
  /** Pasted blocks waiting in each composer, keyed the way `prompts` is. */
  pastes: Record<string, PastedText[]>;
  /** Images waiting in each composer, keyed the way `prompts` is. */
  images: Record<string, StagedImage[]>;
  expandedProjects: Set<string>;
  /** Which of the sidebar's lists are unfolded, across both of its modes. */
  sections: SidebarSections;
  theme: string;
  /** The ground the user asked for, which "auto" leaves to the system's own appearance. */
  themeMode: ThemeMode;
  /** The two families the window sets type in, and the two sizes in px that follow the user. */
  uiFont: string;
  monoFont: string;
  readingSize: number;
  terminalSize: number;
  sidebarMode: SidebarMode;
  sidebarOpen: boolean;
  sessionPanelOpen: boolean;
  /** Whether grabbing a window plays the shutter, and whether it brings the window forward. */
  captureSound: boolean;
  captureFocus: boolean;
  settingsOpen: boolean;
  /** The bindings the user changed, and the action waiting for a keystroke while settings are open. */
  shortcuts: ShortcutOverrides;
  capturingShortcut: string | null;
  /** Bumped whenever something asks for the caret, which is all the composer needs to take it. */
  composerFocus: number;
  /**
   * The dock view that last asked for the keyboard: whose dock it is in, which tab, and a count
   * bumped each time one asks. A view takes the keys when the count it is drawn with changes.
   */
  dockFocus: { owner: string; tab: string; count: number } | null;
  /** One dock per thread, keyed by thread id, so moving between threads leaves each one as it was. */
  docks: Record<string, ThreadDock>;
  /** One review per thread, keyed the way `docks` is, so each thread keeps its own place in a diff. */
  diffs: Record<string, DiffState>;
  /** Where each thread was left reading, keyed by thread id. Session-only, and never persisted. */
  readingPoints: Record<string, ReadingPoint>;
  /** The find bar, and what a page or a shell reported after searching itself. */
  find: FindState | null;
  findResults: FindResults | null;
  /** Which shell has the keyboard, so find knows whether ⌘F means the shell or the transcript. */
  focusedTerminalId: string | null;
  /** The origins a run may reach without asking. Visiting a site adds it. */
  browserOrigins: string[];
  browserApproval: BrowserApproval | null;
  openMenu: string | null;
  environment: { workspaceId: string; result: ChangedFilesResult } | null;
  computerUseSetup: boolean;
  automations: AutomationView[];
  pendingRuns: Record<string, PendingRun>;
  queuedMessages: Record<string, QueuedMessage[]>;
  sideChats: SideChat[];
  sideChatSequence: number;
  /** Latest run per task, so a reply from a superseded run can be dropped. */
  lastRunIds: Record<string, string>;
  focused: boolean;
} & RunTransitionState & {
  storageError: string | null;
  actionError: string | null;
  writable: boolean;
  /** Whether the stored threads have answered. Until they have, there is nothing to say is empty. */
  restored: boolean;
};

export function emptyWorkspaceState(storageError: string | null = null): WorkspaceState {
  return {
    tasks: [],
    projects: [],
    worktrees: [],
    creatingWorktrees: [],
    lastFolder: null,
    currentId: null,
    history: [],
    historyIndex: -1,
    draftProjectId: null,
    draftPolicy: "confirm",
    draftBranch: null,
    draftWorktree: false,
    draftWorktreeId: null,
    draftModel: DEFAULT_MODEL,
    draftEffort: DEFAULT_EFFORT,
    prompts: {},
    annotations: {},
    pastes: {},
    images: {},
    expandedProjects: new Set(),
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    theme: DEFAULT_THEME,
    themeMode: DEFAULT_THEME_MODE,
    uiFont: DEFAULT_UI_FONT,
    monoFont: DEFAULT_MONO_FONT,
    readingSize: READING_SIZE.default,
    terminalSize: TERMINAL_SIZE.default,
    sidebarMode: "projects",
    sidebarOpen: true,
    sessionPanelOpen: false,
    captureSound: true,
    captureFocus: true,
    settingsOpen: false,
    shortcuts: {},
    capturingShortcut: null,
    composerFocus: 0,
    dockFocus: null,
    docks: {},
    diffs: {},
    readingPoints: {},
    find: null,
    findResults: null,
    focusedTerminalId: null,
    browserOrigins: [],
    browserApproval: null,
    openMenu: null,
    environment: null,
    computerUseSetup: false,
    automations: [],
    pendingRuns: {},
    queuedMessages: {},
    sideChats: [],
    sideChatSequence: 0,
    lastRunIds: {},
    focused: true,
    activeRuns: {},
    runStatuses: {},
    approvals: {},
    streamingTails: {},
    backgroundProcesses: {},
    workflows: {},
    storageError,
    actionError: null,
    writable: storageError === null,
    restored: false,
  };
}

export function stateFromData(data: TaskStoreData, storageError: string | null = null): WorkspaceState {
  const projects = data.lastFolder && !data.projects.some((project) => project.root === data.lastFolder)
    ? [...data.projects, { id: legacyProjectId(data.lastFolder), root: data.lastFolder }]
    : data.projects;
  const tasks = retainedTasks(data.tasks, Date.now());
  const firstTask = tasks[0];
  const firstProject = firstTask?.projectId ?? (firstTask ? null : projects.find((project) => project.root === data.lastFolder)?.id ?? null);
  return {
    ...emptyWorkspaceState(storageError),
    tasks: backfillSortIndex(tasks),
    projects: backfillProjectSortIndex(projects),
    /** A store answering from an older build has no checkouts to hand over. */
    worktrees: data.worktrees ?? [],
    lastFolder: data.lastFolder,
    currentId: firstTask?.id ?? null,
    history: firstTask ? [firstTask.id] : [],
    historyIndex: firstTask ? 0 : -1,
    draftProjectId: firstProject,
    draftPolicy: firstTask?.executionPolicy ?? "confirm",
    draftModel: firstTask?.model ?? DEFAULT_MODEL,
    draftEffort: firstTask?.effort ?? DEFAULT_EFFORT,
    expandedProjects: new Set(firstProject ? [firstProject] : []),
  };
}

/**
 * The store answering the load a session opened with. The window is live and typed into while the
 * store is read, so threads and projects arrive into the session rather than replacing it: a draft,
 * an annotation, a run on its way out and a run already going all outlive the arrival.
 */
export function withStoreData(state: WorkspaceState, data: TaskStoreData): WorkspaceState {
  const landing = stateFromData(data);
  /** Threads the answer cannot know about: a fork, which is never stored, and one just started here. */
  const held = new Set([
    ...sideChatIds(state),
    ...Object.keys(state.activeRuns),
    ...Object.values(state.pendingRuns).flatMap((pending) => pending.taskId ? [pending.taskId] : []),
    ...state.creatingWorktrees,
  ]);
  const stored = new Set(landing.tasks.map((task) => task.id));
  const tasks = [...landing.tasks, ...state.tasks.filter((task) => held.has(task.id) && !stored.has(task.id))];
  /** A checkout the store has yet to hear about is still claimed here, so the session keeps its record. */
  const arrived: WorkspaceState = {
    ...state,
    tasks,
    worktrees: [
      ...landing.worktrees,
      ...state.worktrees.filter((worktree) => !landing.worktrees.some((item) => item.id === worktree.id) && tasks.some((task) => task.worktreeId === worktree.id)),
    ],
    projects: landing.projects,
    lastFolder: landing.lastFolder,
    storageError: landing.storageError,
    writable: landing.writable,
  };
  if (sessionStarted(arrived)) return arrived;
  return {
    ...arrived,
    currentId: landing.currentId,
    history: landing.history,
    historyIndex: landing.historyIndex,
    draftProjectId: landing.draftProjectId,
    draftPolicy: landing.draftPolicy,
    draftModel: landing.draftModel,
    draftEffort: landing.draftEffort,
    expandedProjects: landing.expandedProjects,
  };
}

/**
 * Whether the session has gone anywhere of its own: it holds a thread, a project, a draft, or a run.
 * Only a session that has not takes the thread and the draft answers the store implies.
 */
function sessionStarted(state: WorkspaceState): boolean {
  return (state.currentId !== null && state.tasks.some((task) => task.id === state.currentId))
    || state.draftProjectId !== null
    || Object.keys(state.prompts).length > 0
    || Object.keys(state.annotations).length > 0
    || Object.keys(state.pastes).length > 0
    || Object.keys(state.images).length > 0
    || Object.keys(state.pendingRuns).length > 0;
}

/** The slice of state that survives a restart, gathered here so persisting it stays one decision. */
export function viewPreferences(state: WorkspaceState): ViewPreferences {
  /** Only a thread that will still be there reopens its pages, so a dock nothing owns stops being written. */
  const browserTabs: Record<string, string[]> = {};
  for (const [owner, dock] of Object.entries(state.docks)) {
    if (owner !== DRAFT_DOCK && !state.tasks.some((task) => task.id === owner)) continue;
    const urls = dock.browserTabs.map((tab) => tab.url).filter(Boolean);
    if (urls.length) browserTabs[owner] = urls;
  }
  return {
    theme: state.theme,
    themeMode: state.themeMode,
    uiFont: state.uiFont,
    monoFont: state.monoFont,
    readingSize: state.readingSize,
    terminalSize: state.terminalSize,
    sessionPanelOpen: state.sessionPanelOpen,
    captureSound: state.captureSound,
    captureFocus: state.captureFocus,
    sidebarOpen: state.sidebarOpen,
    sidebarMode: state.sidebarMode,
    shortcuts: state.shortcuts,
    browserTabs,
    browserOrigins: state.browserOrigins,
  };
}

/** The dock tab that offers the panels, shown whenever no panel is on top. */
export const DOCK_PICKER = "home";

/** The dock the app shows while no thread is current, so a draft has a dock of its own too. */
export const DRAFT_DOCK = "draft";

export const EMPTY_DOCK: ThreadDock = {
  open: false,
  expanded: false,
  panels: [],
  tab: DOCK_PICKER,
  workflowId: null,
  browserTabs: [],
  browserTabId: null,
  terminals: [],
  terminalId: null,
};

/**
 * Whose dock a command belongs in: the thread it names, else the one the user is looking at. A side
 * chat is a tab within its source thread's dock, so its own commands land in that same dock.
 */
export function dockOwner(state: Pick<WorkspaceState, "currentId" | "sideChats">, taskId?: string | null): string {
  const id = taskId ?? state.currentId;
  if (!id) return DRAFT_DOCK;
  return state.sideChats.find((chat) => chat.id === id)?.sourceTaskId ?? id;
}

export function dockFor(state: Pick<WorkspaceState, "docks">, owner: string): ThreadDock {
  return state.docks[owner] ?? EMPTY_DOCK;
}

/** A workflow by id, wherever it is kept: a dock follows one workflow, not one thread's list. */
export function workflowById(state: Pick<WorkspaceState, "workflows">, id: string | null): Workflow | undefined {
  if (!id) return undefined;
  for (const workflows of Object.values(state.workflows)) {
    const found = workflows.find((workflow) => workflow.id === id);
    if (found) return found;
  }
  return undefined;
}

export function withDock(state: WorkspaceState, owner: string, patch: Partial<ThreadDock>): WorkspaceState {
  return { ...state, docks: { ...state.docks, [owner]: { ...dockFor(state, owner), ...patch } } };
}

export const EMPTY_DIFF: DiffState = {
  range: UNCOMMITTED,
  workspaceId: null,
  result: null,
  loading: false,
  collapsed: [],
  viewed: {},
  split: true,
};

export function diffFor(state: Pick<WorkspaceState, "diffs">, owner: string): DiffState {
  return state.diffs[owner] ?? EMPTY_DIFF;
}

export function withDiff(state: WorkspaceState, owner: string, patch: Partial<DiffState>): WorkspaceState {
  return { ...state, diffs: { ...state.diffs, [owner]: { ...diffFor(state, owner), ...patch } } };
}

/**
 * The ticks that survive a fresh list: a file whose counts moved has changed since it was read, so
 * it comes back unread rather than staying ticked against work the user has not seen.
 */
export function retainedViews(viewed: Record<string, string>, result: DiffSummaryResult) {
  if (result.status !== "available") return viewed;
  const fingerprints = new Map(result.files.map((file) => [file.path, fileFingerprint(file)]));
  return Object.fromEntries(Object.entries(viewed).filter(([path, mark]) => fingerprints.get(path) === mark));
}

/** Whether a landed list still answers what its dock is asking, which a slow read may not. */
export function diffMatches(diff: DiffState, workspaceId: string, range: DiffRange) {
  return diff.workspaceId === workspaceId && rangeKey(diff.range) === rangeKey(range);
}

/** Which dock holds a page or a shell, for the events and commands that only name its id. */
export function ownerOfBrowserTab(state: WorkspaceState, tabId: string): string | undefined {
  return Object.keys(state.docks).find((owner) => state.docks[owner].browserTabs.some((tab) => tab.id === tabId));
}

export function ownerOfTerminal(state: WorkspaceState, terminalId: string): string | undefined {
  return Object.keys(state.docks).find((owner) => state.docks[owner].terminals.some((terminal) => terminal.id === terminalId));
}

/** The forks a dock draws as tabs: the ones taken from the thread that owns it. */
export function dockSideChats(state: Pick<WorkspaceState, "sideChats">, owner: string) {
  return state.sideChats.filter((chat) => chat.sourceTaskId === owner);
}

/**
 * What a dock tab is showing. A page and a shell are tabs in their own right rather than tabs within
 * a panel, so `tab` names one of them directly and there is one strip in the app, not two.
 */
export function dockTabKind(state: WorkspaceState, owner: string, tab: string) {
  const dock = dockFor(state, owner);
  if (dock.browserTabs.some((page) => page.id === tab)) return "browser" as const;
  if (dock.terminals.some((terminal) => terminal.id === tab)) return "terminal" as const;
  if (dockSideChats(state, owner).some((chat) => chat.id === tab)) return "side-chat" as const;
  return dock.panels.includes(tab) ? "panel" as const : "picker" as const;
}

/** Every tab in the dock, in the order the strip draws them. */
export function dockTabIds(state: WorkspaceState, owner: string) {
  const dock = dockFor(state, owner);
  return [
    ...dock.panels,
    ...dock.browserTabs.map((page) => page.id),
    ...dock.terminals.map((terminal) => terminal.id),
    ...dockSideChats(state, owner).map((chat) => chat.id),
  ];
}

/** Which tab takes over when `tab` closes: its neighbour on the left, else on the right, else the picker. */
export function dockTabAfterClosing(state: WorkspaceState, owner: string, tab: string) {
  const tabs = dockTabIds(state, owner);
  const index = tabs.indexOf(tab);
  if (index === -1) return dockFor(state, owner).tab;
  const remaining = tabs.filter((id) => id !== tab);
  return remaining[index - 1] ?? remaining[index] ?? DOCK_PICKER;
}

export function activeBrowserTab(dock: ThreadDock) {
  return dock.browserTabs.find((tab) => tab.id === dock.browserTabId);
}

/** Which tab a browser command acts on: the one it names, else the one that dock is showing. */
export function browserTarget(dock: ThreadDock, tabId: string | undefined) {
  return tabId === undefined ? activeBrowserTab(dock) : dock.browserTabs.find((tab) => tab.id === tabId);
}

export function activeTerminal(dock: ThreadDock) {
  return dock.terminals.find((terminal) => terminal.id === dock.terminalId);
}

/**
 * Which terminal a read acts on: the one it names, else the one the asking thread opened, else the
 * one its dock is showing. A thread with a shell of its own never reads somebody else's by accident.
 */
export function terminalTarget(dock: ThreadDock, terminalId: string | undefined, taskId?: string) {
  if (terminalId !== undefined) return dock.terminals.find((terminal) => terminal.id === terminalId);
  const own = taskId === undefined ? undefined : [...dock.terminals].reverse().find((terminal) => terminal.taskId === taskId);
  return own ?? activeTerminal(dock);
}

/** Where a new shell starts: the thread's own checkout, else its project, else the last folder opened. */
export function terminalFolder(state: WorkspaceState): string | null {
  const task = state.tasks.find((item) => item.id === state.currentId);
  const draft = state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.root : undefined;
  return taskWorkspaceRoot(state, task) ?? draft ?? state.lastFolder;
}

export function projectFor(state: WorkspaceState, task: Task | undefined) {
  return task?.projectId ? state.projects.find((project) => project.id === task.projectId) : undefined;
}

export function worktreeById(state: Pick<WorkspaceState, "worktrees">, worktreeId: string | undefined) {
  return worktreeId ? state.worktrees.find((worktree) => worktree.id === worktreeId) : undefined;
}

/** The checkout a thread works in, when it works in one rather than in its project. */
export function worktreeFor(state: Pick<WorkspaceState, "worktrees">, task: Task | undefined) {
  return worktreeById(state, task?.worktreeId);
}

/**
 * The threads keeping a checkout alive. Archiving one is walking out of it, so an archived thread
 * holds nothing open: a checkout whose last live thread leaves is handed back there and then.
 */
export function worktreeClaimants(state: Pick<WorkspaceState, "tasks">, worktreeId: string) {
  return state.tasks.filter((task) => task.worktreeId === worktreeId && task.archivedAt === undefined);
}

/** The folder a thread works in: the checkout it shares once it has one, otherwise its project's. */
export function taskWorkspaceRoot(state: WorkspaceState, task: Task | undefined) {
  return worktreeFor(state, task)?.root ?? projectFor(state, task)?.root;
}

/** Where a thread's runs happen: the checkout it shares once it has one, otherwise its project's. */
export function taskWorkspaceId(state: WorkspaceState, task: Task | undefined) {
  return worktreeFor(state, task)?.workspaceId ?? projectFor(state, task)?.workspaceId;
}

/**
 * Threads that are working, which is more than the threads with a run in them: a send still finding
 * its checkout, and a checkout being made, are both work the thread is waiting on.
 */
export function busyTaskIds(state: WorkspaceState): Set<string> {
  const busy = new Set(Object.keys(state.activeRuns));
  for (const pending of Object.values(state.pendingRuns)) if (pending.taskId) busy.add(pending.taskId);
  for (const taskId of state.creatingWorktrees) busy.add(taskId);
  return busy;
}

/** Threads stopped on a question only the user can answer, which outranks any work they were doing. */
export function blockedTaskIds(state: WorkspaceState): Set<string> {
  return new Set(Object.values(state.activeRuns).filter((run) => run.status === "awaiting-approval").map((run) => run.taskId));
}

/** What the current thread is waiting on, if anything: its own checkout, or where a send will run. */
export function waitFor(state: WorkspaceState, currentTask: Task | undefined): ThreadWait | null {
  if (currentTask && state.creatingWorktrees.includes(currentTask.id)) return "worktree";
  const key = promptKey(state);
  const resolving = Object.values(state.pendingRuns).find((pending) =>
    (currentTask !== undefined && pending.taskId === currentTask.id) || pending.draftKey === key);
  if (!resolving) return null;
  return resolving.creatingWorktree ? "worktree" : "run";
}

export function locationOf(state: Pick<WorkspaceState, "worktrees" | "creatingWorktrees">, task: Task | undefined): ThreadLocation {
  const worktree = worktreeFor(state, task);
  if (worktree) return { kind: "worktree", worktree };
  return task && state.creatingWorktrees.includes(task.id) ? { kind: "creating" } : { kind: "local" };
}

/** Composer drafts live per task, with one draft per project for the not-yet-created task. */
export function promptKey(state: Pick<WorkspaceState, "currentId" | "draftProjectId">) {
  return state.currentId ?? `draft:${state.draftProjectId ?? ""}`;
}

export function withPrompt(state: WorkspaceState, key: string, prompt: string): WorkspaceState {
  if (prompt) return { ...state, prompts: { ...state.prompts, [key]: prompt } };
  const { [key]: _cleared, ...prompts } = state.prompts;
  return { ...state, prompts };
}

const NO_ANNOTATIONS: Annotation[] = [];

export function annotationsFor(state: Pick<WorkspaceState, "annotations">, key: string): Annotation[] {
  return state.annotations[key] ?? NO_ANNOTATIONS;
}

export function withAnnotations(state: WorkspaceState, key: string, annotations: Annotation[]): WorkspaceState {
  if (annotations.length) return { ...state, annotations: { ...state.annotations, [key]: annotations } };
  const { [key]: _cleared, ...remaining } = state.annotations;
  return { ...state, annotations: remaining };
}

const NO_PASTES: PastedText[] = [];

export function pastesFor(state: Pick<WorkspaceState, "pastes">, key: string): PastedText[] {
  return state.pastes[key] ?? NO_PASTES;
}

export function withPastes(state: WorkspaceState, key: string, pastes: PastedText[]): WorkspaceState {
  if (pastes.length) return { ...state, pastes: { ...state.pastes, [key]: pastes } };
  const { [key]: _cleared, ...remaining } = state.pastes;
  return { ...state, pastes: remaining };
}

const NO_IMAGES: StagedImage[] = [];

export function imagesFor(state: Pick<WorkspaceState, "images">, key: string): StagedImage[] {
  return state.images[key] ?? NO_IMAGES;
}

export function withImages(state: WorkspaceState, key: string, images: StagedImage[]): WorkspaceState {
  if (images.length) return { ...state, images: { ...state.images, [key]: images } };
  const { [key]: _cleared, ...remaining } = state.images;
  return { ...state, images: remaining };
}

/** Where the cursor lands moving `step` through history, stepping over threads that are gone or archived. */
export function reachableVisit(state: WorkspaceState, step: -1 | 1): number | null {
  for (let index = state.historyIndex + step; index >= 0 && index < state.history.length; index += step) {
    const id = state.history[index];
    if (state.tasks.some((task) => task.id === id && task.archivedAt === undefined)) return index;
  }
  return null;
}

/** Remembers where the app took the user, dropping the forward entries the way a browser does. */
export function recordVisit(state: WorkspaceState, taskId: string): WorkspaceState {
  const history = state.history.slice(0, state.historyIndex + 1);
  if (history[history.length - 1] !== taskId) history.push(taskId);
  return { ...state, history, historyIndex: history.length - 1 };
}

/**
 * What ⌘F searches: the page while one has the keys, else the shell holding them, else the thread
 * being read. A keystroke is the only thing that knows about the page, because a page swallows it.
 */
export function findTargetFor(state: WorkspaceState, surface: ShortcutSurface): FindTarget {
  const dock = dockFor(state, dockOwner(state));
  if (surface === "browser" && dock.browserTabId) return { kind: "browser", tabId: dock.browserTabId };
  if (state.focusedTerminalId) return { kind: "terminal", terminalId: state.focusedTerminalId };
  return { kind: "transcript" };
}

/** The find bar as it is drawn: its matches counted here for a thread, reported for a page or a shell. */
export type FindView = FindState & FindResults & { hit: FindHit | null };

function findView(state: WorkspaceState, currentTask: Task | undefined): FindView | null {
  const find = state.find;
  if (!find) return null;
  if (find.target.kind !== "transcript") {
    return { ...find, matches: state.findResults?.matches ?? 0, index: state.findResults?.index ?? 0, hit: null };
  }
  const hits = findHits(currentTask?.messages ?? [], find.query);
  const index = hits.length ? Math.min(find.index, hits.length - 1) : 0;
  return { ...find, index, matches: hits.length, hit: hits[index] ?? null };
}

export type WorkspaceView = ReturnType<typeof deriveView>;

/** Everything the UI reads, derived in one place so components never reach into raw state. */
export function deriveView(state: WorkspaceState) {
  const currentTask = state.tasks.find((task) => task.id === state.currentId);
  const draftWorktree = worktreeById(state, state.draftWorktreeId ?? undefined);
  const currentProject = currentTask
    ? projectFor(state, currentTask)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
  const forked = sideChatIds(state);
  const listedTasks = state.tasks.filter((task) => !forked.has(task.id));
  const visibleTasks = listedTasks.filter((task) => task.archivedAt === undefined);
  const currentRun = state.currentId ? state.activeRuns[state.currentId] : undefined;
  const workspaceId = currentTask
    ? taskWorkspaceId(state, currentTask)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.workspaceId : undefined);
  const environment = workspaceId && state.environment?.workspaceId === workspaceId ? state.environment.result : null;
  const owner = dockOwner(state);
  const dock = dockFor(state, owner);
  const waitingOn = waitFor(state, currentTask);
  const busy = busyTaskIds(state);
  const blocked = blockedTaskIds(state);
  return {
    tasks: listedTasks,
    projects: orderProjects(state.projects),
    orderedTasks: orderTasks(visibleTasks),
    /** The same threads ranked by what wants the user, which is the sidebar's other shape. */
    activityTasks: activitySections(visibleTasks, busy, blocked),
    archivedTasks: listedTasks.filter((task) => task.archivedAt !== undefined).sort((a, b) => b.archivedAt! - a.archivedAt!),
    /** Ranked and stamped by when each chat last did something, so a tick that surfaced nothing moves none of them. */
    recentTasks: visibleTasks.filter((task) => !task.projectId).sort((a, b) => threadActivityAt(b) - threadActivityAt(a)),
    currentTask,
    currentProject,
    folder: currentProject?.root ?? "",
    policy: currentTask?.executionPolicy ?? state.draftPolicy,
    model: currentTask?.model ?? state.draftModel,
    effort: currentTask?.effort ?? state.draftEffort,
    prompt: state.prompts[promptKey(state)] ?? "",
    annotations: annotationsFor(state, promptKey(state)),
    pastes: pastesFor(state, promptKey(state)),
    images: imagesFor(state, promptKey(state)),
    status: currentRun ? "running" as const : runStatusFor(state, state.currentId),
    compacting: currentRun?.status === "compacting",
    runActive: Boolean(currentRun),
    queuedMessages: (state.currentId ? state.queuedMessages[state.currentId] : undefined) ?? [],
    runningTaskIds: busy,
    blockedTaskIds: blocked,
    approval: currentRun?.status === "awaiting-approval" ? state.approvals[currentRun.runId] as ApprovalView | undefined : undefined,
    subagents: currentTask?.subagents ?? [],
    backgroundProcesses: (state.currentId ? state.backgroundProcesses[state.currentId] : undefined) ?? [],
    workflows: (state.currentId ? state.workflows[state.currentId] : undefined) ?? [],
    /** The workflow this thread's panel is on, which outlives a move to another thread and back. */
    inspectedWorkflow: workflowById(state, dock.workflowId) ?? null,
    streamingTail: state.currentId ? state.streamingTails[state.currentId] ?? null : null,
    readingPoint: state.currentId ? state.readingPoints[state.currentId] ?? null : null,
    automation: state.automations.find((item) => item.taskId === state.currentId) ?? null,
    schedules: new Map(state.automations.map((automation) => [automation.taskId, automation])),
    /** When a run on this thread last found something, which is what the automation panel reports. */
    lastFoundAt: currentTask?.lastFindingAt ?? null,
    worktreeTaskIds: new Set(listedTasks.filter((task) => task.worktreeId).map((task) => task.id)),
    /** The checkouts a project has, each with the threads that claim it. */
    worktreeGroups: state.worktrees.map((worktree): WorktreeGroup => ({
      worktree,
      tasks: orderTasks(visibleTasks.filter((task) => task.worktreeId === worktree.id)),
    })),
    location: locationOf(state, currentTask),
    waitingOn,
    /** The checkout the current thread works in, which is what Git is read from and moved. */
    workspaceId,
    draftBranch: state.draftBranch,
    draftWorktree: state.draftWorktree,
    draftWorktreeId: state.draftWorktreeId,
    /** What the composer calls the checkout a draft starts in, when the user picked one. */
    draftWorktreeName: draftWorktree ? worktreeName(draftWorktree) : null,
    environment,
    storageError: state.storageError,
    actionError: state.actionError,
    restored: state.restored,
    computerUseSetup: state.computerUseSetup,
    expandedProjects: state.expandedProjects,
    sections: state.sections,
    theme: state.theme,
    themeMode: state.themeMode,
    uiFont: state.uiFont,
    monoFont: state.monoFont,
    readingSize: state.readingSize,
    terminalSize: state.terminalSize,
    sidebarMode: state.sidebarMode,
    sidebarOpen: state.sidebarOpen,
    sessionPanelOpen: state.sessionPanelOpen,
    captureSound: state.captureSound,
    captureFocus: state.captureFocus,
    shortcuts: shortcutSettings(state.shortcuts),
    capturingShortcut: state.capturingShortcut,
    composerFocus: state.composerFocus,
    /** Only the dock on screen can take the keys, so a request in another thread's dock is not drawn. */
    dockFocus: state.dockFocus?.owner === owner ? state.dockFocus : null,
    /** Asking for computer use opens settings whether or not the user did. */
    settingsOpen: state.settingsOpen || state.computerUseSetup,
    dockOpen: dock.open,
    dockExpanded: dock.expanded,
    dockPanels: dock.panels,
    /** The review this thread has open, whether or not the panel drawing it is the tab in front. */
    diff: diffFor(state, owner),
    dockTab: dock.tab,
    browserTabs: dock.browserTabs,
    browserApproval: state.browserApproval,
    browserOrigins: state.browserOrigins,
    terminals: dock.terminals,
    terminalFolder: terminalFolder(state),
    openMenu: state.openMenu,
    find: findView(state, currentTask),
    canGoBack: reachableVisit(state, -1) !== null,
    canGoForward: reachableVisit(state, 1) !== null,
    sideChats: dockSideChats(state, owner).flatMap((chat): SideChatView[] => {
      const task = state.tasks.find((item) => item.id === chat.id);
      if (!task) return [];
      const active = state.activeRuns[chat.id];
      const approval = active?.status === "awaiting-approval" ? state.approvals[active.runId] as ApprovalView | undefined : undefined;
      return [{
        ...chat,
        title: task.title,
        task,
        prompt: state.prompts[chat.id] ?? "",
        annotations: annotationsFor(state, chat.id),
        pastes: pastesFor(state, chat.id),
        images: imagesFor(state, chat.id),
        running: Boolean(active),
        compacting: active?.status === "compacting",
        status: active ? "running" : runStatusFor(state, chat.id),
        streamingTail: state.streamingTails[chat.id] ?? null,
        queuedMessages: state.queuedMessages[chat.id] ?? [],
        readingPoint: state.readingPoints[chat.id] ?? null,
        ...(approval ? { approval } : {}),
      }];
    }),
  };
}
