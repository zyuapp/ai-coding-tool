import { runStatusFor, type ApprovalView, type RunTransitionState, type StreamingTail, type TaskRunStatus } from "./task-workspace.js";
import { backfillProjectSortIndex, orderProjects } from "./project-order.js";
import { activitySections, backfillSortIndex, orderTasks } from "./task-order.js";
import type { ChangedFilesResult } from "../contracts/ipc.js";
import type { ReadingPoint } from "../contracts/commands.js";

export type { ReadingPoint };
import { DIFF_PANEL, dockFor, dockOwner, dockSideChats, dockTabKind, frontDock, type ThreadDock } from "./workspace-dock.js";
export {
  DIFF_PANEL, DOCK_PICKER, DRAFT_DOCK, EMPTY_DOCK, WORKFLOW_PANEL, activeBrowserTab, activeTerminal, browserTarget,
  dockFor, dockHoldsTab, dockOwner, dockSideChats, dockTabAfterClosing, dockTabIds, dockTabKind, frontDock,
  keyboardTerminalId, ownerOfBrowserTab, ownerOfTerminal, terminalTarget, withDock,
} from "./workspace-dock.js";
export type { ThreadDock } from "./workspace-dock.js";
import { diffFor, type DiffState } from "./workspace-diff.js";
export { EMPTY_DIFF, diffFor, diffMatches, foldedOnLoad, retainedViews, withDiff } from "./workspace-diff.js";
export type { DiffState } from "./workspace-diff.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import type { AutomationView } from "../domain/automation.js";
import { emptyMobileServerState, type MobileServerState } from "../domain/mobile.js";
import type { BrowserApproval } from "../domain/browser.js";
import { memoizedFindHits, searchesItself, type FindHit, type FindResults, type FindTarget } from "../domain/find.js";
import { shortcutSettings, type ShortcutOverrides, type ShortcutSurface } from "../domain/shortcuts.js";
import type { SidebarMode, SidebarSections } from "../domain/sidebar.js";
import { DEFAULT_THEME, DEFAULT_THEME_MODE, type ThemeMode } from "../domain/theme.js";
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, READING_SIZE, TERMINAL_SIZE } from "../domain/typography.js";
import type { Workflow } from "../domain/workflow.js";
import { DEFAULT_ENGINE, DEFAULT_MODEL, byEngine, capabilitiesFor, defaultEffortFor, defaultModelFor, engineLabel, type AgentEngine, type AgentModel, type EngineAccess, type EngineCapabilities, type EngineStatus } from "../domain/agent-engine.js";
import { engineAccessOf } from "./engine-access.js";
import { DEFAULT_EFFORT, OPEN_SUBAGENT_GROUPS, type AgentEffort, type ExecutionPolicy, type Subagent, type SubagentGroups } from "../domain/run.js";
import { annotationsFor, filesFor, imagesFor, pastesFor } from "./composer-drafts.js";
import { legacyProjectId, projectName, retainedTasks, threadActivityAt, type Annotation, type AttachedFile, type PastedText, type Project, type StagedImage, type Task, type TaskStoreData } from "../domain/task.js";
import { worktreeName, type ManagedWorktree, type Worktree } from "../domain/worktree.js";
import { worktreeSettingsViews } from "./worktree-settings.js";
export type { WorktreeSettingsView } from "./worktree-settings.js";

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
  files?: AttachedFile[];
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
  | { kind: "releasing" }
  /** `threads` counts everyone in the checkout, which says whether leaving it takes it away. */
  | { kind: "worktree"; worktree: Worktree; threads: number };

/** What a thread is waiting on before it can work: a checkout being made or removed, or a run finding one. */
export type ThreadWait = "worktree" | "worktree-release" | "run";

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
  files?: AttachedFile[];
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
  files: AttachedFile[];
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
 * The folder editor, open on one project. A name typed beside a folder that is still being opened
 * waits here, so a directory the app cannot open leaves the name where the user last saw it too.
 */
export type ProjectEdit = {
  projectId: string;
  name?: string | null;
  saving: boolean;
  error: string | null;
};

export type WorkspaceState = {
  tasks: Task[];
  projects: Project[];
  /**
   * Every checkout the app has recorded. A checkout outlives the thread that asked for it and stays
   * until the user explicitly returns from or deletes it.
   */
  worktrees: Worktree[];
  /** Directories found under app-owned roots for the manual Settings list. Null until that list lands. */
  managedWorktrees: ManagedWorktree[] | null;
  worktreeManagementError: string | null;
  worktreeManagementNotice: string | null;
  /** Threads whose checkout is being made, so nothing asks for a second one while the first lands. */
  creatingWorktrees: string[];
  /** Threads giving up their checkout, so the wait is shown and nothing asks to leave twice. */
  releasingWorktrees: string[];
  /** Roots of checkouts being deleted, so the list shows the wait and refuses a second delete. */
  deletingWorktrees: string[];
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
  draftEngine: AgentEngine;
  draftModel: AgentModel;
  draftEffort: AgentEffort;
  /** What main last said about which engines can take a run. Session-only, and never persisted. */
  engineStatus: EngineStatus;
  prompts: Record<string, string>;
  /** Annotations waiting in each composer, keyed the way `prompts` is. */
  annotations: Record<string, Annotation[]>;
  /** Pasted blocks waiting in each composer, keyed the way `prompts` is. */
  pastes: Record<string, PastedText[]>;
  /** Images waiting in each composer, keyed the way `prompts` is. */
  images: Record<string, StagedImage[]>;
  /** Files and folders waiting in each composer, keyed the way `prompts` is. */
  files: Record<string, AttachedFile[]>;
  expandedProjects: Set<string>;
  /** The folder the editor is open on, if any, and what came back the last time it tried to save. */
  projectEdit: ProjectEdit | null;
  /** Which of the sidebar's lists are unfolded, across both of its modes. */
  sections: SidebarSections;
  /** Which subagent groups are unfolded: the sidebar's list, and each status heading in the panel. */
  subagentGroups: SubagentGroups;
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
  /** Whether a run selects the app's Simplified Technical English output style. */
  plainEnglish: boolean;
  /** Whether a run reaches the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  /** Whether a run may see and operate other applications. */
  computerUse: boolean;
  /** Whether a run may drive the browser panel. The user's own tabs stay usable either way. */
  browserTools: boolean;
  /** Whether a thread that needs the user is announced on the desktop. Off leaves it to the sidebar alone. */
  notifications: boolean;
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
  /** Which dock tab the keyboard is in, so ⌘F knows whether it means that view or the thread. */
  keyboardTab: string | null;
  /** The origins a run may reach without asking. Visiting a site adds it. */
  browserOrigins: string[];
  browserApproval: BrowserApproval | null;
  openMenu: string | null;
  /**
   * What Git last said about each checkout, keyed by checkout. A checkout is what a branch and a set
   * of changes belong to, so a scan of one never overwrites another, and a thread returned to shows
   * what was last read while a new scan runs. Session-only, and never persisted.
   */
  environments: Record<string, ChangedFilesResult>;
  computerUseSetup: boolean;
  automations: AutomationView[];
  pendingRuns: Record<string, PendingRun>;
  queuedMessages: Record<string, QueuedMessage[]>;
  sideChats: SideChat[];
  sideChatSequence: number;
  /** Latest run per task, so a reply from a superseded run can be dropped. */
  lastRunIds: Record<string, string>;
  /** The bridge a phone reaches this Mac through, as the main process last reported it. */
  remote: MobileServerState;
  focused: boolean;
} & RunTransitionState & {
  storageError: string | null;
  actionError: string | null;
  writable: boolean;
  /** Whether the stored threads have answered. Until they have, there is nothing to say is empty. */
  restored: boolean;
};

/** The folder editor as the dialog draws it: the folder being edited, and how the last save went. */
export type ProjectEditorView = { project: Project; checkouts: number; saving: boolean; error: string | null };

function projectEditorView(state: WorkspaceState): ProjectEditorView | null {
  const edit = state.projectEdit;
  const project = edit && state.projects.find((item) => item.id === edit.projectId);
  if (!edit || !project) return null;
  const checkouts = state.worktrees.filter((worktree) => worktree.projectId === project.id).length;
  return { project, checkouts, saving: edit.saving, error: edit.error };
}

export function withoutWorktreeRoot(state: Pick<WorkspaceState, "deletingWorktrees">, root: string) {
  return state.deletingWorktrees.filter((item) => item !== root);
}

export function emptyWorkspaceState(storageError: string | null = null): WorkspaceState {
  return {
    tasks: [],
    projects: [],
    worktrees: [],
    managedWorktrees: null,
    worktreeManagementError: null,
    worktreeManagementNotice: null,
    creatingWorktrees: [],
    releasingWorktrees: [],
    deletingWorktrees: [],
    lastFolder: null,
    currentId: null,
    history: [],
    historyIndex: -1,
    draftProjectId: null,
    draftPolicy: "confirm",
    draftBranch: null,
    draftWorktree: false,
    draftWorktreeId: null,
    draftEngine: DEFAULT_ENGINE,
    draftModel: DEFAULT_MODEL,
    draftEffort: DEFAULT_EFFORT,
    engineStatus: {},
    prompts: {},
    annotations: {},
    pastes: {},
    images: {},
    files: {},
    expandedProjects: new Set(),
    projectEdit: null,
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    theme: DEFAULT_THEME,
    themeMode: DEFAULT_THEME_MODE,
    uiFont: DEFAULT_UI_FONT,
    monoFont: DEFAULT_MONO_FONT,
    readingSize: READING_SIZE.default,
    terminalSize: TERMINAL_SIZE.default,
    sidebarMode: "projects",
    sidebarOpen: true,
    subagentGroups: OPEN_SUBAGENT_GROUPS,
    sessionPanelOpen: false,
    captureSound: true,
    captureFocus: true,
    plainEnglish: false,
    chromeBrowser: false,
    computerUse: true,
    browserTools: true,
    notifications: true,
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
    keyboardTab: null,
    browserOrigins: [],
    browserApproval: null,
    openMenu: null,
    environments: {},
    computerUseSetup: false,
    automations: [],
    pendingRuns: {},
    queuedMessages: {},
    sideChats: [],
    sideChatSequence: 0,
    lastRunIds: {},
    remote: emptyMobileServerState(),
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
    draftEngine: firstTask?.engine ?? DEFAULT_ENGINE,
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
  const held = sideChatIds(state);
  for (const taskId in state.activeRuns) held.add(taskId);
  for (const pendingId in state.pendingRuns) if (state.pendingRuns[pendingId]!.taskId) held.add(state.pendingRuns[pendingId]!.taskId!);
  for (const taskId of state.creatingWorktrees) held.add(taskId);
  const stored = new Set<string>(); for (const task of landing.tasks) stored.add(task.id);
  const tasks = [...landing.tasks, ...state.tasks.filter((task) => held.has(task.id) && !stored.has(task.id))];
  const landingWorktreeIds = new Set<string>(); for (const worktree of landing.worktrees) landingWorktreeIds.add(worktree.id);
  const claimedWorktreeIds = new Set<string>(); for (const task of tasks) if (task.worktreeId) claimedWorktreeIds.add(task.worktreeId);
  /** A checkout the store has yet to hear about is still claimed here, so the session keeps its record. */
  const arrived: WorkspaceState = {
    ...state,
    tasks,
    worktrees: [
      ...landing.worktrees,
      ...state.worktrees.filter((worktree) => !landingWorktreeIds.has(worktree.id) && claimedWorktreeIds.has(worktree.id)),
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
    draftEngine: landing.draftEngine,
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
    || Object.keys(state.files).length > 0
    || Object.keys(state.pendingRuns).length > 0;
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

/** The folder the app is pointed at: the thread's own checkout, else its project, else the last one opened. */
export function currentFolder(state: WorkspaceState): string | null {
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

/** Every thread still linked to a checkout, including archived threads. */
export function worktreeClaimants(state: Pick<WorkspaceState, "tasks">, worktreeId: string) {
  return state.tasks.filter((task) => task.worktreeId === worktreeId);
}

/** The folder a thread works in: the checkout it shares once it has one, otherwise its project's. */
export function taskWorkspaceRoot(state: WorkspaceState, task: Task | undefined) {
  return worktreeFor(state, task)?.root ?? projectFor(state, task)?.root;
}

/**
 * Where a file a message named is looked for, nearest the thread first: the checkout it works in,
 * its project's own checkout, then the project's other checkouts, most recently used first.
 */
export function taskFileRoots(state: WorkspaceState, task: Task | undefined): string[] {
  const project = projectFor(state, task);
  const siblings = project
    ? [...state.worktrees.filter((worktree) => worktree.projectId === project.id)]
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .map((worktree) => worktree.root)
    : [];
  const roots = [worktreeFor(state, task)?.root, project?.root, ...siblings];
  return [...new Set(roots.filter((root): root is string => !!root))];
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
  /** A checkout on its way out is ground about to move, so every thread standing on it waits. */
  for (const taskId of leavingTaskIds(state)) busy.add(taskId);
  return busy;
}

/**
 * Threads whose checkout is going: the ones that asked to leave, and every thread in a checkout the
 * user is deleting, whichever thread or Settings asked for it.
 */
export function leavingTaskIds(state: Pick<WorkspaceState, "tasks" | "worktrees" | "releasingWorktrees" | "deletingWorktrees">): Set<string> {
  const leaving = new Set(state.releasingWorktrees);
  if (state.deletingWorktrees.length === 0) return leaving;
  const going = new Set(state.worktrees.filter((worktree) => state.deletingWorktrees.includes(worktree.root)).map((worktree) => worktree.id));
  for (const task of state.tasks) if (task.worktreeId && going.has(task.worktreeId)) leaving.add(task.id);
  return leaving;
}

/** Threads stopped on a question only the user can answer, which outranks any work they were doing. */
export function blockedTaskIds(state: WorkspaceState): Set<string> {
  return new Set(Object.values(state.activeRuns).filter((run) => run.status === "awaiting-approval").map((run) => run.taskId));
}

/** What the current thread is waiting on, if anything: its own checkout, or where a send will run. */
export function waitFor(state: WorkspaceState, currentTask: Task | undefined): ThreadWait | null {
  if (currentTask && state.creatingWorktrees.includes(currentTask.id)) return "worktree";
  if (currentTask && leavingTaskIds(state).has(currentTask.id)) return "worktree-release";
  const key = promptKey(state);
  const resolving = Object.values(state.pendingRuns).find((pending) =>
    (currentTask !== undefined && pending.taskId === currentTask.id) || pending.draftKey === key);
  if (!resolving) return null;
  return resolving.creatingWorktree ? "worktree" : "run";
}

type LocationState = Pick<WorkspaceState, "tasks" | "worktrees" | "creatingWorktrees" | "releasingWorktrees" | "deletingWorktrees">;

export function locationOf(state: LocationState, task: Task | undefined): ThreadLocation {
  if (task && leavingTaskIds(state).has(task.id)) return { kind: "releasing" };
  const worktree = worktreeFor(state, task);
  if (worktree) return { kind: "worktree", worktree, threads: worktreeClaimants(state, worktree.id).length };
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

/** Where the cursor lands moving `step` through history, stepping over threads that are gone or archived. */
export function reachableVisit(state: WorkspaceState, step: -1 | 1): number | null {
  for (let index = state.historyIndex + step, misses = 0, reachable: Set<string> | null = null;
    index >= 0 && index < state.history.length; index += step) {
    const id = state.history[index];
    if (reachable ? reachable.has(id) : state.tasks.some((task) => task.id === id && task.archivedAt === undefined)) return index;
    /** Short gaps are common. Index only once a long gap repays the allocation. */
    if (++misses === 128) reachable = new Set(state.tasks.filter((task) => task.archivedAt === undefined).map((task) => task.id));
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
 * What ⌘F searches: the page when the keystroke came from one and the dock is showing it, else the
 * dock view holding the keys — a shell, a side chat's thread, the review, a panel — else the thread
 * being read. A keystroke is the only thing that knows about the page, because a page swallows it.
 */
export function findTargetFor(state: WorkspaceState, surface: ShortcutSurface): FindTarget {
  const { owner, dock } = frontDock(state);
  /** The page holding the keys is the one the dock is showing, which a run's page never is. */
  const page = dock.browserTabs.find((tab) => tab.id === dock.tab);
  if (surface === "browser" && page) return { kind: "browser", tabId: page.id };
  const thread: FindTarget = { kind: "thread", taskId: state.currentId };
  const tab = state.keyboardTab;
  if (!tab) return thread;
  switch (dockTabKind(state, owner, tab)) {
    case "browser": return { kind: "browser", tabId: tab };
    case "terminal": return { kind: "terminal", terminalId: tab };
    case "side-chat": return { kind: "thread", taskId: tab };
    case "panel": return tab === DIFF_PANEL ? { kind: "review", owner } : { kind: "panel", owner, panel: tab };
    case "picker": return thread;
  }
}

/** The find bar as it is drawn: counted here for a thread, reported by the view for everything else. */
export type FindView = FindState & { matches: number; counting: boolean; hit: FindHit | null };

function findView(state: WorkspaceState, currentTask: Task | undefined): FindView | null {
  const find = state.find;
  if (!find) return null;
  const target = find.target;
  if (target.kind === "thread") {
    /** A side chat is a task like any other, so naming it is all the same search needs. */
    const task = target.taskId === (currentTask?.id ?? null)
      ? currentTask
      : state.tasks.find((item) => item.id === target.taskId);
    const hits = memoizedFindHits(task?.messages ?? [], find.query);
    const index = hits.length ? Math.min(find.index, hits.length - 1) : 0;
    return { ...find, index, matches: hits.length, counting: false, hit: hits[index] ?? null };
  }
  const reported = state.findResults;
  const matches = reported?.matches ?? 0;
  if (searchesItself(find.target)) {
    return { ...find, matches, index: reported?.index ?? 0, counting: false, hit: null };
  }
  /** Nothing reported yet is a view still counting, not a view that found nothing. */
  const counting = reported ? reported.counting ?? false : find.query.trim().length > 0;
  return { ...find, matches, index: matches ? Math.min(find.index, matches - 1) : 0, counting, hit: null };
}

const NO_SUBAGENTS: Subagent[] = [];
const NO_WORKFLOWS: Workflow[] = [];

/** What the thread's engine reports about its run; a feed the engine cannot fill stays empty. */
export function engineFeeds(capabilities: EngineCapabilities, state: WorkspaceState, currentTask: Task | undefined) {
  return {
    subagents: capabilities.subagents ? currentTask?.subagents ?? NO_SUBAGENTS : NO_SUBAGENTS,
    workflows: capabilities.workflows ? (state.currentId ? state.workflows[state.currentId] : undefined) ?? NO_WORKFLOWS : NO_WORKFLOWS,
  };
}

/** The engine in front: what it is called, what it can feed, and whether a picker may still move off it. */
function engineView(state: WorkspaceState, currentTask: Task | undefined) {
  const engine = currentTask?.engine ?? state.draftEngine;
  const capabilities = capabilitiesFor(engine);
  return {
    engine,
    /** The engine's name, for wording that speaks of the agent running this thread. */
    engineLabel: engineLabel(engine),
    /** A thread exists from its first message on, and keeps the engine that message went to. */
    engineLocked: currentTask !== undefined,
    /** Which engines a picker may hand a run to, and why the others cannot be picked. */
    engineAccess: byEngine((candidate): EngineAccess => engineAccessOf(state, candidate)),
    /** Settings that only Claude reads are drawn only while Claude is the engine in front. */
    claudeSettings: engine === "claude",
    /** What the engine can feed, so a panel it cannot is not offered for this thread. */
    capabilities,
    ...engineFeeds(capabilities, state, currentTask),
  };
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
  const orderedTasks = orderTasks(visibleTasks), tasksByWorktree = new Map<string, Task[]>();
  for (const task of orderedTasks) if (task.worktreeId)
    tasksByWorktree.get(task.worktreeId)?.push(task) ?? tasksByWorktree.set(task.worktreeId, [task]);
  const currentRun = state.currentId ? state.activeRuns[state.currentId] : undefined;
  const workspaceId = currentTask
    ? taskWorkspaceId(state, currentTask)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.workspaceId : undefined);
  const environment = (workspaceId ? state.environments[workspaceId] : undefined) ?? null;
  const owner = dockOwner(state);
  const dock = dockFor(state, owner);
  const waitingOn = waitFor(state, currentTask);
  const busy = busyTaskIds(state);
  const blocked = blockedTaskIds(state);
  return {
    ...engineView(state, currentTask),
    tasks: listedTasks,
    projects: orderProjects(state.projects),
    orderedTasks,
    /** The same threads ranked by what wants the user, which is the sidebar's other shape. */
    activityTasks: activitySections(visibleTasks, busy, blocked),
    archivedTasks: listedTasks.filter((task) => task.archivedAt !== undefined).sort((a, b) => b.archivedAt! - a.archivedAt!),
    /** Ranked and stamped by when each chat last did something, so a tick that surfaced nothing moves none of them. */
    recentTasks: visibleTasks.filter((task) => !task.projectId).sort((a, b) => threadActivityAt(b) - threadActivityAt(a)),
    currentTask,
    currentProject,
    folder: currentProject?.root ?? "",
    /** What that folder is called: the name the user gave the project, else the folder's own. */
    folderLabel: currentProject ? projectName(currentProject) : "",
    policy: currentTask?.executionPolicy ?? state.draftPolicy,
    model: currentTask ? currentTask.model ?? defaultModelFor(currentTask.engine) : state.draftModel,
    effort: currentTask ? currentTask.effort ?? defaultEffortFor(currentTask.engine) : state.draftEffort,
    prompt: state.prompts[promptKey(state)] ?? "",
    annotations: annotationsFor(state, promptKey(state)),
    pastes: pastesFor(state, promptKey(state)),
    images: imagesFor(state, promptKey(state)),
    files: filesFor(state, promptKey(state)),
    status: currentRun ? "running" as const : runStatusFor(state, state.currentId),
    compacting: currentRun?.status === "compacting",
    runActive: Boolean(currentRun),
    queuedMessages: (state.currentId ? state.queuedMessages[state.currentId] : undefined) ?? [],
    runningTaskIds: busy,
    blockedTaskIds: blocked,
    approval: currentRun?.status === "awaiting-approval" ? state.approvals[currentRun.runId] as ApprovalView | undefined : undefined,
    backgroundProcesses: (state.currentId ? state.backgroundProcesses[state.currentId] : undefined) ?? [],
    /** The workflow this thread's panel is on, which outlives a move to another thread and back. */
    inspectedWorkflow: workflowById(state, dock.workflowId) ?? null,
    streamingTail: state.currentId ? state.streamingTails[state.currentId] ?? null : null,
    readingPoint: state.currentId ? state.readingPoints[state.currentId] ?? null : null,
    automation: state.automations.find((item) => item.taskId === state.currentId) ?? null,
    schedules: new Map(state.automations.map((automation) => [automation.taskId, automation])),
    /** When a run on this thread last found something, which is what the automation panel reports. */
    lastFoundAt: currentTask?.lastFindingAt ?? null,
    /** What its last silent tick looked at, which is all a schedule that never speaks has to show. */
    lastChecked: currentTask?.lastChecked ?? null,
    worktreeTaskIds: new Set(listedTasks.filter((task) => task.worktreeId).map((task) => task.id)),
    /** The checkouts a project has, each with the threads that claim it. */
    worktreeGroups: state.worktrees.map((worktree): WorktreeGroup => ({
      worktree,
      tasks: tasksByWorktree.get(worktree.id) ?? [],
    })),
    managedWorktrees: worktreeSettingsViews(state, busy),
    worktreeManagementError: state.worktreeManagementError,
    worktreeManagementNotice: state.worktreeManagementNotice,
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
    projectEditor: projectEditorView(state),
    sections: state.sections,
    subagentGroups: state.subagentGroups,
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
    plainEnglish: state.plainEnglish,
    chromeBrowser: state.chromeBrowser,
    computerUse: state.computerUse,
    browserTools: state.browserTools,
    notifications: state.notifications,
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
    currentFolder: currentFolder(state),
    openMenu: state.openMenu,
    find: findView(state, currentTask),
    remote: state.remote,
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
        files: filesFor(state, chat.id),
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
