import { runStatusFor, type ApprovalView, type RunTransitionState, type StreamingTail, type TaskRunStatus } from "./task-workspace.js";
import { backfillSortIndex, orderTasks } from "./task-order.js";
import type { ChangedFilesResult } from "../contracts/ipc.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import type { AutomationView } from "../domain/automation.js";
import type { BrowserApproval, BrowserTab } from "../domain/browser.js";
import { findHits, type FindHit, type FindResults, type FindTarget } from "../domain/find.js";
import { shortcutSettings, type ShortcutOverrides, type ShortcutSurface } from "../domain/shortcuts.js";
import type { TerminalSession } from "../domain/terminal.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type AgentEffort, type AgentModel, type ExecutionPolicy } from "../domain/run.js";
import { legacyProjectId, retainedTasks, type Annotation, type Project, type Task, type TaskStoreData } from "../domain/task.js";
import type { Worktree } from "../domain/worktree.js";

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
  /** Composer only: which draft to clear once the run starts. */
  draftKey?: string;
  /** What the user typed, before attachments are appended. Titles a brand new task. */
  text: string;
  prompt: string;
  attachments: string[];
  annotations?: Annotation[];
  detail?: string;
  policy?: ExecutionPolicy;
  automationId?: string;
  /** Queued messages this run is draining, cleared only once the run actually starts. */
  queuedIds?: string[];
};

/** Where a thread's runs happen. */
export type ThreadLocation =
  | { kind: "local" }
  | { kind: "worktree"; worktree: Worktree };

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
  running: boolean;
  compacting: boolean;
  status: TaskRunStatus;
  streamingTail: StreamingTail | null;
  queuedMessages: QueuedMessage[];
  approval?: ApprovalView;
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

/** The branch a thread is to start from. `create` names one the repository does not have yet. */
export type DraftBranch = { name: string; create: boolean };

/**
 * One thread's right dock: whether it is showing, which panels are open as tabs, which tab is on top,
 * and the pages and shells that thread opened. A page and a shell belong to the thread that asked for
 * one, so a run drives its own dock and never the dock of whichever thread the user is looking at.
 * Only the records live here. What a page holds and what a shell has printed never become state.
 */
export type ThreadDock = {
  open: boolean;
  panels: string[];
  tab: string;
  browserTabs: BrowserTab[];
  browserTabId: string | null;
  terminals: TerminalSession[];
  terminalId: string | null;
};

export type WorkspaceState = {
  tasks: Task[];
  projects: Project[];
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
  draftModel: AgentModel;
  draftEffort: AgentEffort;
  prompts: Record<string, string>;
  /** Annotations waiting in each composer, keyed the way `prompts` is. */
  annotations: Record<string, Annotation[]>;
  expandedProjects: Set<string>;
  projectsOpen: boolean;
  recentsOpen: boolean;
  sidebarOpen: boolean;
  sessionPanelOpen: boolean;
  settingsOpen: boolean;
  /** The bindings the user changed, and the action waiting for a keystroke while settings are open. */
  shortcuts: ShortcutOverrides;
  capturingShortcut: string | null;
  /** Bumped whenever something asks for the caret, which is all the composer needs to take it. */
  composerFocus: number;
  /** One dock per thread, keyed by thread id, so moving between threads leaves each one as it was. */
  docks: Record<string, ThreadDock>;
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
};

export function emptyWorkspaceState(storageError: string | null = null): WorkspaceState {
  return {
    tasks: [],
    projects: [],
    lastFolder: null,
    currentId: null,
    history: [],
    historyIndex: -1,
    draftProjectId: null,
    draftPolicy: "confirm",
    draftBranch: null,
    draftWorktree: false,
    draftModel: DEFAULT_MODEL,
    draftEffort: DEFAULT_EFFORT,
    prompts: {},
    annotations: {},
    expandedProjects: new Set(),
    projectsOpen: true,
    recentsOpen: true,
    sidebarOpen: true,
    sessionPanelOpen: false,
    settingsOpen: false,
    shortcuts: {},
    capturingShortcut: null,
    composerFocus: 0,
    docks: {},
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
    projects,
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
  ]);
  const stored = new Set(landing.tasks.map((task) => task.id));
  const arrived: WorkspaceState = {
    ...state,
    tasks: [...landing.tasks, ...state.tasks.filter((task) => held.has(task.id) && !stored.has(task.id))],
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
    sessionPanelOpen: state.sessionPanelOpen,
    sidebarOpen: state.sidebarOpen,
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
  panels: [],
  tab: DOCK_PICKER,
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

export function withDock(state: WorkspaceState, owner: string, patch: Partial<ThreadDock>): WorkspaceState {
  return { ...state, docks: { ...state.docks, [owner]: { ...dockFor(state, owner), ...patch } } };
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

/** The folder a thread works in: its own checkout once it has one, otherwise its project's. */
export function taskWorkspaceRoot(state: WorkspaceState, task: Task | undefined) {
  return task?.worktree?.root ?? projectFor(state, task)?.root;
}

/** Where a thread's runs happen: its own checkout once it has one, otherwise its project's. */
export function taskWorkspaceId(state: WorkspaceState, task: Task | undefined) {
  return task?.worktree?.workspaceId ?? projectFor(state, task)?.workspaceId;
}

export function locationOf(task: Task | undefined): ThreadLocation {
  return task?.worktree ? { kind: "worktree", worktree: task.worktree } : { kind: "local" };
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
  return {
    tasks: listedTasks,
    projects: state.projects,
    orderedTasks: orderTasks(visibleTasks),
    archivedTasks: listedTasks.filter((task) => task.archivedAt !== undefined).sort((a, b) => b.archivedAt! - a.archivedAt!),
    recentTasks: visibleTasks.filter((task) => !task.projectId).sort((a, b) => b.updatedAt - a.updatedAt),
    currentTask,
    currentProject,
    folder: currentProject?.root ?? "",
    policy: currentTask?.executionPolicy ?? state.draftPolicy,
    model: currentTask?.model ?? state.draftModel,
    effort: currentTask?.effort ?? state.draftEffort,
    prompt: state.prompts[promptKey(state)] ?? "",
    annotations: annotationsFor(state, promptKey(state)),
    status: currentRun ? "running" as const : runStatusFor(state, state.currentId),
    compacting: currentRun?.status === "compacting",
    runActive: Boolean(currentRun),
    queuedMessages: (state.currentId ? state.queuedMessages[state.currentId] : undefined) ?? [],
    runningTaskIds: new Set(Object.keys(state.activeRuns)),
    approval: currentRun?.status === "awaiting-approval" ? state.approvals[currentRun.runId] as ApprovalView | undefined : undefined,
    subagents: currentTask?.subagents ?? [],
    backgroundProcesses: (state.currentId ? state.backgroundProcesses[state.currentId] : undefined) ?? [],
    workflows: (state.currentId ? state.workflows[state.currentId] : undefined) ?? [],
    streamingTail: state.currentId ? state.streamingTails[state.currentId] ?? null : null,
    automation: state.automations.find((item) => item.taskId === state.currentId) ?? null,
    automatedTaskIds: new Set(state.automations.map((automation) => automation.taskId)),
    worktreeTaskIds: new Set(listedTasks.filter((task) => task.worktree).map((task) => task.id)),
    location: locationOf(currentTask),
    /** The checkout the current thread works in, which is what Git is read from and moved. */
    workspaceId,
    draftBranch: state.draftBranch,
    draftWorktree: state.draftWorktree,
    environment,
    storageError: state.storageError,
    actionError: state.actionError,
    computerUseSetup: state.computerUseSetup,
    expandedProjects: state.expandedProjects,
    projectsOpen: state.projectsOpen,
    recentsOpen: state.recentsOpen,
    sidebarOpen: state.sidebarOpen,
    sessionPanelOpen: state.sessionPanelOpen,
    shortcuts: shortcutSettings(state.shortcuts),
    capturingShortcut: state.capturingShortcut,
    composerFocus: state.composerFocus,
    /** Asking for computer use opens settings whether or not the user did. */
    settingsOpen: state.settingsOpen || state.computerUseSetup,
    dockOpen: dock.open,
    dockPanels: dock.panels,
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
        running: Boolean(active),
        compacting: active?.status === "compacting",
        status: active ? "running" : runStatusFor(state, chat.id),
        streamingTail: state.streamingTails[chat.id] ?? null,
        queuedMessages: state.queuedMessages[chat.id] ?? [],
        ...(approval ? { approval } : {}),
      }];
    }),
  };
}
