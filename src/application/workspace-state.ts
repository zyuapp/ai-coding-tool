import { runStatusFor, type ApprovalView, type RunTransitionState, type StreamingTail, type ThreadRunStatus } from "./thread-run-state.js";
import { backfillProjectSortIndex } from "./project-order.js";
import { sidebarLists } from "./sidebar-lists.js";
import { backfillSortIndex, orderThreads } from "./thread-order.js";
import type { ChangedFilesResult, DesktopShortcutRefusal } from "../contracts/ipc.js";
import type { ReadingPoint } from "../contracts/commands.js";
import type { ReviewTarget } from "../domain/review.js";
import type { ActiveGoal } from "../domain/goal.js";

export type { ReadingPoint };
import { DIFF_PANEL, dockFor, dockOwner, dockSideChats, dockTabKind, frontDock, type ThreadDock } from "./workspace-dock.js";
export {
  DIFF_PANEL, DOCK_PICKER, DRAFT_DOCK, EMPTY_DOCK, WORKFLOW_PANEL, activeBrowserTab, activeTerminal, browserTarget,
  dockFor, dockHoldsTab, dockOwner, dockSideChats, dockTabAfterClosing, dockTabIds, dockTabKind, frontDock,
  keyboardTerminalId, ownerOfBrowserTab, ownerOfTerminal, terminalTarget, withDock,
} from "./workspace-dock.js";
export type { ThreadDock } from "./workspace-dock.js";
import { diffFor, type DiffState } from "./workspace-diff.js";
import { jumpView } from "./workspace-jump.js";
import { unreadView } from "./thread-attention.js";
import { findView } from "./workspace-find.js";
export type { FindView } from "./workspace-find.js";
export { EMPTY_DIFF, diffFor, diffMatches, foldedOnLoad, retainedViews, withDiff } from "./workspace-diff.js";
export type { DiffState } from "./workspace-diff.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import type { AutomationView } from "../domain/automation.js";
import { emptyMobileServerState, type MobileServerState } from "../domain/mobile.js";
import type { BrowserApproval } from "../domain/browser.js";
import { memoizedFindHits, searchesItself, type FindHit, type FindResults, type FindTarget } from "../domain/find.js";
import { shortcutSettings, type ShortcutOverrides, type ShortcutSurface } from "../domain/shortcuts.js";
import type { SettingsSection } from "../domain/settings-section.js";
import { OPEN_SIDEBAR_SECTIONS, type SidebarMode, type SidebarSections } from "../domain/sidebar.js";
import { DEFAULT_THEME, DEFAULT_THEME_MODE, type ThemeMode } from "../domain/theme.js";
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, READING_SIZE, TERMINAL_SIZE } from "../domain/typography.js";
import type { Workflow } from "../domain/workflow.js";
import { DEFAULT_ENGINE, DEFAULT_MODEL, byEngine, capabilitiesFor, defaultEffortFor, defaultModelFor, engineLabel, type AgentEngine, type AgentModel, type EngineCapabilities, type EngineReadiness, type EngineStatus } from "../domain/agent-engine.js";
import { engineReadinessOf } from "./engine-access.js";
import { DEFAULT_EFFORT, OPEN_SUBAGENT_GROUPS, type AgentEffort, type ExecutionPolicy, type Subagent, type SubagentGroups } from "../domain/run.js";
import { annotationsFor, filesFor, imagesFor, pastesFor } from "./composer-drafts.js";
import type { Annotation, AttachedFile, PastedText, StagedImage } from "../domain/conversation.js";
import { legacyProjectId, projectName, type Project } from "../domain/project.js";
import { retainedThreads } from "../domain/thread-retention.js";
import type { ThreadStoreData } from "../domain/thread-storage.js";
import { threadActivityAt, type Thread } from "../domain/thread.js";
import { worktreeName, type ManagedWorktree, type Worktree } from "../domain/worktree.js";
import {
  leavingThreadIds,
  locationOf,
  projectFor,
  threadWorkspaceId,
  threadWorkspaceRoot,
  worktreeById,
  worktreeClaimants,
  worktreeFor,
} from "./thread-location.js";
import { worktreeSettingsViews } from "./worktree-settings.js";
import { heldViews } from "./view-reuse.js";
export type { WorktreeSettingsView } from "./worktree-settings.js";
export {
  locationOf,
  projectFor,
  worktreeById,
  worktreeClaimants,
  worktreeFor,
} from "./thread-location.js";
export type { ThreadLocation } from "./thread-location.js";

/** A desktop-wide binding whose action this session cannot safely perform on the active platform. */
export type DesktopShortcutUnavailable = Extract<DesktopShortcutRefusal, { reason: "unsupported" }>;

/**
 * A run the user or the scheduler asked for that is still resolving its workspace. It lives in state
 * rather than in a closure so the reducer can re-check the thread when resolution lands.
 */
export type PendingRun = {
  id: string;
  runId: string;
  origin: "composer" | "automation";
  operation?: { type: "compact" } | { type: "review"; target: ReviewTarget };
  taskId?: string;
  projectId?: string;
  /** The checkout the run was told to happen in, for a thread that does not exist yet to claim. */
  worktreeId?: string;
  /** Agent choices carried atomically by a new thread request instead of changing the shared draft. */
  model?: AgentModel;
  effort?: AgentEffort;
  /** Composer only: which draft to clear once the run starts. */
  draftKey?: string;
  /** What the user typed, before attachments are appended. Titles a brand new thread. */
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

/** What a thread is waiting on before it can work: a checkout being made or removed, or a run finding one. */
export type ThreadWait = "worktree" | "worktree-release" | "run";

/** A checkout with the threads working in it, which is how a project offers starting one more there. */
export type WorktreeGroup = {
  worktree: Worktree;
  threads: Thread[];
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
 * One forked conversation. Its thread is an ordinary thread in `threads`, so everything keyed by a
 * thread id reaches it too: drafts, queued messages, approvals, and steering. This record only marks
 * the thread as one that is never persisted and never listed.
 */
export type SideChat = {
  id: string;
  sourceThreadId: string;
  error: string | null;
};

export type SideChatView = SideChat & {
  title: string;
  thread: Thread;
  prompt: string;
  annotations: Annotation[];
  pastes: PastedText[];
  images: StagedImage[];
  files: AttachedFile[];
  running: boolean;
  compacting: boolean;
  status: ThreadRunStatus;
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

/**
 * The jump panel: the name being searched for, and the row the user moved to. Which threads that
 * name matches is derived, so a thread renamed while the panel is open moves with the query.
 */
export type JumpState = { query: string; index: number };

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

/** The native review picker follows the thread it was opened from and never persists. */
export type ReviewPicker = {
  taskId: string;
  step: "targets" | "base" | "commit" | "custom";
};

export type WorkspaceState = {
  threads: Thread[];
  /** Native goals live only as long as this app session. */
  goals: Record<string, ActiveGoal>;
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
  /** What main has said about the engines' access; null until it has been asked. */
  engineStatus: EngineStatus | null;
  /** True while main is running the engine commands, which the Engines page says out loud. */
  engineChecking: boolean;
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
  /** The move the confirmation is open on: the thread asked to move, and where it would go. */
  worktreeMove: { taskId: string; worktree: boolean } | null;
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
  /** Whether a run reaches the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  /** Whether Claude threads answer under the concise ruleset. */
  conciseReplies: boolean;
  /** Whether a run may see and operate other applications. */
  computerUse: boolean;
  /** Whether a run may drive the browser panel. The user's own tabs stay usable either way. */
  browserTools: boolean;
  /** Whether a thread that needs the user is announced on the desktop. Off leaves it to the sidebar alone. */
  notifications: boolean;
  settingsOpen: boolean;
  /** The page settings opens on, when something opened it on one. Null lets it open where it opens. */
  settingsSection: SettingsSection | null;
  /** The control on that page to scroll to and mark, when something named one. */
  settingsFocus: string | null;
  /** The bindings the user changed, and the action waiting for a keystroke while settings are open. */
  shortcuts: ShortcutOverrides;
  capturingShortcut: string | null;
  /** A capability refusal belongs beside its affected setting, not in the workspace error banner. */
  desktopShortcutUnavailable: DesktopShortcutUnavailable | null;
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
  /** The jump panel, open on the name the user is searching for. */
  jump: JumpState | null;
  /** Which dock tab the keyboard is in, so ⌘F knows whether it means that view or the thread. */
  keyboardTab: string | null;
  /** The origins a run may reach without asking. Visiting a site adds it. */
  browserOrigins: string[];
  browserApproval: BrowserApproval | null;
  openMenu: string | null;
  reviewPicker: ReviewPicker | null;
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
  /** Latest run per thread, so a reply from a superseded run can be dropped. */
  lastRunIds: Record<string, string>;
  /** The bridge a phone reaches this Mac through, as the main process last reported it. */
  remote: MobileServerState;
  /** True while main is reading Tailscale, which the Phone page says out loud. */
  remoteChecking: boolean;
  focused: boolean;
} & RunTransitionState & {
  /** `hiddenThreads` counts the threads on disk this build cannot read, which stay there untouched. */
  storageError: string | null; hiddenThreads: number;
  actionError: string | null;
  /** The settings page that clears the error above, when one does. */
  actionErrorPage: SettingsSection | null;
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

/** The pending move as the confirmation draws it: where it goes, and what the thread is holding. */
export type WorktreeMoveView = {
  worktree: boolean;
  /** Uncommitted files in the checkout the thread is leaving, which the move commits first. */
  changes: number;
  /** Threads left in the worktree once this one goes, so the text can say whether it stays. */
  others: number;
};

function worktreeMoveView(state: WorkspaceState): WorktreeMoveView | null {
  const move = state.worktreeMove;
  const thread = move && state.threads.find((item) => item.id === move.taskId);
  if (!move || !thread) return null;
  const workspaceId = threadWorkspaceId(state, thread);
  const environment = workspaceId ? state.environments[workspaceId] : undefined;
  const worktree = worktreeFor(state, thread);
  return {
    worktree: move.worktree,
    changes: environment?.status === "available" ? environment.files.length : 0,
    others: worktree ? Math.max(worktreeClaimants(state, worktree.id).length - 1, 0) : 0,
  };
}

export function withoutWorktreeRoot(state: Pick<WorkspaceState, "deletingWorktrees">, root: string) {
  return state.deletingWorktrees.filter((item) => item !== root);
}

export function emptyWorkspaceState(storageError: string | null = null): WorkspaceState {
  return {
    threads: [],
    goals: {},
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
    engineStatus: null,
    engineChecking: false,
    prompts: {},
    annotations: {},
    pastes: {},
    images: {},
    files: {},
    expandedProjects: new Set(),
    projectEdit: null,
    worktreeMove: null,
    sections: OPEN_SIDEBAR_SECTIONS,
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
    chromeBrowser: false,
    conciseReplies: false,
    computerUse: true,
    browserTools: true,
    notifications: true,
    settingsOpen: false,
    settingsSection: null,
    settingsFocus: null,
    shortcuts: {},
    capturingShortcut: null,
    desktopShortcutUnavailable: null,
    composerFocus: 0,
    dockFocus: null,
    docks: {},
    diffs: {},
    readingPoints: {},
    find: null,
    findResults: null,
    jump: null,
    keyboardTab: null,
    browserOrigins: [],
    browserApproval: null,
    openMenu: null,
    reviewPicker: null,
    environments: {},
    computerUseSetup: false,
    automations: [],
    pendingRuns: {},
    queuedMessages: {},
    sideChats: [],
    sideChatSequence: 0,
    lastRunIds: {},
    remote: emptyMobileServerState(),
    remoteChecking: false,
    focused: true,
    activeRuns: {},
    runStatuses: {},
    approvals: {},
    streamingTails: {},
    backgroundProcesses: {},
    workflows: {},
    subagents: {},
    storageError, hiddenThreads: 0,
    actionError: null,
    actionErrorPage: null,
    writable: storageError === null,
    restored: false,
  };
}

export function stateFromData(data: ThreadStoreData, storageError: string | null = null): WorkspaceState {
  const projects = data.lastFolder && !data.projects.some((project) => project.root === data.lastFolder)
    ? [...data.projects, { id: legacyProjectId(data.lastFolder), root: data.lastFolder }]
    : data.projects;
  const stored = retainedThreads(data.tasks, Date.now());
  const subagents: Record<string, Subagent[]> = {};
  const threads = stored.map(({ subagents: delegated, ...thread }) => {
    if (delegated?.length) subagents[thread.id] = delegated;
    return thread;
  });
  const firstThread = threads[0];
  const firstProject = firstThread?.projectId ?? (firstThread ? null : projects.find((project) => project.root === data.lastFolder)?.id ?? null);
  return {
    ...emptyWorkspaceState(storageError),
    threads: backfillSortIndex(threads),
    subagents,
    projects: backfillProjectSortIndex(projects),
    /** A store answering from an older build has no checkouts to hand over. */
    worktrees: data.worktrees ?? [],
    lastFolder: data.lastFolder,
    currentId: firstThread?.id ?? null,
    history: firstThread ? [firstThread.id] : [],
    historyIndex: firstThread ? 0 : -1,
    draftProjectId: firstProject,
    draftPolicy: firstThread?.executionPolicy ?? "confirm",
    draftEngine: firstThread?.engine ?? DEFAULT_ENGINE,
    draftModel: firstThread?.model ?? DEFAULT_MODEL,
    draftEffort: firstThread?.effort ?? DEFAULT_EFFORT,
    expandedProjects: new Set(firstProject ? [firstProject] : []),
  };
}

/**
 * The store answering the load a session opened with. The window is live and typed into while the
 * store is read, so threads and projects arrive into the session rather than replacing it: a draft,
 * an annotation, a run on its way out and a run already going all outlive the arrival.
 */
export function withStoreData(state: WorkspaceState, data: ThreadStoreData): WorkspaceState {
  const landing = stateFromData(data);
  /** Threads the answer cannot know about: a fork, which is never stored, and one just started here. */
  const held = sideChatIds(state);
  for (const taskId in state.activeRuns) held.add(taskId);
  for (const pendingId in state.pendingRuns) if (state.pendingRuns[pendingId]!.taskId) held.add(state.pendingRuns[pendingId]!.taskId!);
  for (const taskId of state.creatingWorktrees) held.add(taskId);
  const stored = new Set<string>(); for (const thread of landing.threads) stored.add(thread.id);
  const threads = [...landing.threads, ...state.threads.filter((thread) => held.has(thread.id) && !stored.has(thread.id))];
  const landingWorktreeIds = new Set<string>(); for (const worktree of landing.worktrees) landingWorktreeIds.add(worktree.id);
  const claimedWorktreeIds = new Set<string>(); for (const thread of threads) if (thread.worktreeId) claimedWorktreeIds.add(thread.worktreeId);
  /** A checkout the store has yet to hear about is still claimed here, so the session keeps its record. */
  const arrived: WorkspaceState = {
    ...state,
    threads,
    /** A thread the session is already following keeps its live feed; the rest take the stored one. */
    subagents: { ...landing.subagents, ...state.subagents },
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
  return (state.currentId !== null && state.threads.some((thread) => thread.id === state.currentId))
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
  const thread = state.threads.find((item) => item.id === state.currentId);
  const draft = state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.root : undefined;
  return threadWorkspaceRoot(state, thread) ?? draft ?? state.lastFolder;
}

/**
 * Threads that are working, which is more than the threads with a run in them: a send still finding
 * its checkout, and a checkout being made, are both work the thread is waiting on.
 */
export function busyThreadIds(state: WorkspaceState): Set<string> {
  const busy = new Set(Object.keys(state.activeRuns));
  for (const pending of Object.values(state.pendingRuns)) if (pending.taskId) busy.add(pending.taskId);
  for (const taskId of state.creatingWorktrees) busy.add(taskId);
  /** A checkout on its way out is ground about to move, so every thread standing on it waits. */
  for (const taskId of leavingThreadIds(state)) busy.add(taskId);
  return busy;
}

/** Threads stopped on a question only the user can answer, which outranks any work they were doing. */
export function blockedThreadIds(state: WorkspaceState): Set<string> {
  return new Set(Object.values(state.activeRuns).filter((run) => run.status === "awaiting-approval").map((run) => run.taskId));
}

/** What the current thread is waiting on, if anything: its own checkout, or where a send will run. */
export function waitFor(state: WorkspaceState, currentThread: Thread | undefined): ThreadWait | null {
  if (currentThread && state.creatingWorktrees.includes(currentThread.id)) return "worktree";
  if (currentThread && leavingThreadIds(state).has(currentThread.id)) return "worktree-release";
  const key = promptKey(state);
  const resolving = Object.values(state.pendingRuns).find((pending) =>
    (currentThread !== undefined && pending.taskId === currentThread.id) || pending.draftKey === key);
  if (!resolving) return null;
  return resolving.creatingWorktree ? "worktree" : "run";
}

/** Composer drafts live per thread, with one draft per project for the not-yet-created thread. */
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
    if (reachable ? reachable.has(id) : state.threads.some((thread) => thread.id === id && thread.archivedAt === undefined)) return index;
    /** Short gaps are common. Index only once a long gap repays the allocation. */
    if (++misses === 128) reachable = new Set(state.threads.filter((thread) => thread.archivedAt === undefined).map((thread) => thread.id));
  }
  return null;
}

/** Remembers where the app took the user, dropping the forward entries the way a browser does. */
export function recordVisit(state: WorkspaceState, threadId: string): WorkspaceState {
  const history = state.history.slice(0, state.historyIndex + 1);
  if (history[history.length - 1] !== threadId) history.push(threadId);
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

/** Each chat's view outlives the derive that built it, so a report elsewhere never redraws one. */
const reusedSideChats = heldViews<SideChatView>();

const NO_SUBAGENTS: Subagent[] = [];
const NO_QUEUED: QueuedMessage[] = [];
const NO_WORKFLOWS: Workflow[] = [];

/** What the thread's engine reports about its run; a feed the engine cannot fill stays empty. */
export function engineFeeds(capabilities: EngineCapabilities, state: WorkspaceState, currentThread: Thread | undefined) {
  return {
    subagents: capabilities.subagents && currentThread ? state.subagents[currentThread.id] ?? NO_SUBAGENTS : NO_SUBAGENTS,
    workflows: capabilities.workflows ? (state.currentId ? state.workflows[state.currentId] : undefined) ?? NO_WORKFLOWS : NO_WORKFLOWS,
  };
}

/** The engine in front: what it is called, what it can feed, and whether a picker may still move off it. */
function engineView(state: WorkspaceState, currentThread: Thread | undefined) {
  const engine = currentThread?.engine ?? state.draftEngine;
  const capabilities = capabilitiesFor(engine);
  return {
    engine,
    /** The engine's name, for wording that speaks of the agent running this thread. */
    engineLabel: engineLabel(engine),
    /** A thread exists from its first message on, and keeps the engine that message went to. */
    engineLocked: currentThread !== undefined,
    /** Which engines a picker may hand a run to, why the others cannot be picked, and how to fix it. */
    engineAccess: byEngine((candidate): EngineReadiness => engineReadinessOf(state, candidate)),
    /** What the engine can feed, so a panel it cannot is not offered for this thread. */
    capabilities,
    ...engineFeeds(capabilities, state, currentThread),
  };
}

export type WorkspaceView = ReturnType<typeof deriveView>;

/**
 * The threads ⌘1 through ⌘9 reach, read straight from state so each keystroke follows the current
 * visible order.
 */
export function threadSlots(state: WorkspaceState): string[] {
  const forked = sideChatIds(state);
  const visible = state.threads.filter((thread) => !forked.has(thread.id) && thread.archivedAt === undefined);
  return sidebarLists(state, state.projects, visible, busyThreadIds(state), blockedThreadIds(state)).threadSlots;
}

/** Everything the UI reads, derived in one place so components never reach into raw state. */
export function deriveView(state: WorkspaceState) {
  const currentThread = state.threads.find((thread) => thread.id === state.currentId);
  const draftWorktree = worktreeById(state, state.draftWorktreeId ?? undefined);
  const currentProject = currentThread
    ? projectFor(state, currentThread)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
  const forked = sideChatIds(state);
  const listedThreads = state.threads.filter((thread) => !forked.has(thread.id));
  const visibleThreads = listedThreads.filter((thread) => thread.archivedAt === undefined);
  const busy = busyThreadIds(state), blocked = blockedThreadIds(state);
  const lists = sidebarLists(state, state.projects, visibleThreads, busy, blocked);
  const { orderedThreads } = lists, threadsByWorktree = new Map<string, Thread[]>();
  for (const thread of orderedThreads) if (thread.worktreeId)
    threadsByWorktree.get(thread.worktreeId)?.push(thread) ?? threadsByWorktree.set(thread.worktreeId, [thread]);
  const currentRun = state.currentId ? state.activeRuns[state.currentId] : undefined;
  const workspaceId = currentThread
    ? threadWorkspaceId(state, currentThread)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.workspaceId : undefined);
  const environment = (workspaceId ? state.environments[workspaceId] : undefined) ?? null;
  const owner = dockOwner(state), dock = dockFor(state, owner);
  const waitingOn = waitFor(state, currentThread);
  return {
    ...engineView(state, currentThread),
    ...unreadView(state, listedThreads),
    ...lists,
    threads: listedThreads,
    archivedThreads: listedThreads.filter((thread) => thread.archivedAt !== undefined).sort((a, b) => b.archivedAt! - a.archivedAt!),
    currentThread,
    goal: state.currentId ? state.goals[state.currentId] ?? null : null,
    currentProject,
    folder: currentProject?.root ?? "",
    /** What that folder is called: the name the user gave the project, else the folder's own. */
    folderLabel: currentProject ? projectName(currentProject) : "",
    policy: currentThread?.executionPolicy ?? state.draftPolicy,
    model: currentThread ? currentThread.model ?? defaultModelFor(currentThread.engine) : state.draftModel,
    effort: currentThread ? currentThread.effort ?? defaultEffortFor(currentThread.engine) : state.draftEffort,
    prompt: state.prompts[promptKey(state)] ?? "",
    annotations: annotationsFor(state, promptKey(state)),
    pastes: pastesFor(state, promptKey(state)),
    images: imagesFor(state, promptKey(state)),
    files: filesFor(state, promptKey(state)),
    status: currentRun ? "running" as const : runStatusFor(state, state.currentId),
    compacting: currentRun?.status === "compacting",
    runActive: Boolean(currentRun),
    queuedMessages: (state.currentId ? state.queuedMessages[state.currentId] : undefined) ?? NO_QUEUED,
    runningThreadIds: busy,
    blockedThreadIds: blocked,
    approval: currentRun?.status === "awaiting-approval" ? state.approvals[currentRun.runId] as ApprovalView | undefined : undefined,
    backgroundProcesses: (state.currentId ? state.backgroundProcesses[state.currentId] : undefined) ?? [],
    /** The workflow this thread's panel is on, which outlives a move to another thread and back. */
    inspectedWorkflow: workflowById(state, dock.workflowId) ?? null,
    streamingTail: state.currentId ? state.streamingTails[state.currentId] ?? null : null,
    readingPoint: state.currentId ? state.readingPoints[state.currentId] ?? null : null,
    automation: state.automations.find((item) => item.taskId === state.currentId) ?? null,
    schedules: new Map(state.automations.map((automation) => [automation.taskId, automation])),
    /** When a run on this thread last found something, which is what the automation panel reports. */
    lastFoundAt: currentThread?.lastFindingAt ?? null,
    /** What its last silent tick looked at, which is all a schedule that never speaks has to show. */
    lastChecked: currentThread?.lastChecked ?? null,
    worktreeThreadIds: new Set(listedThreads.filter((thread) => thread.worktreeId).map((thread) => thread.id)),
    /** The checkouts a project has, each with the threads that claim it. */
    worktreeGroups: state.worktrees.map((worktree): WorktreeGroup => ({
      worktree,
      threads: threadsByWorktree.get(worktree.id) ?? [],
    })),
    managedWorktrees: worktreeSettingsViews(state, busy),
    worktreeManagementError: state.worktreeManagementError,
    worktreeManagementNotice: state.worktreeManagementNotice,
    location: locationOf(state, currentThread),
    waitingOn,
    /** The checkout the current thread works in, which is what Git is read from and moved. */
    workspaceId,
    draftBranch: state.draftBranch,
    draftWorktree: state.draftWorktree,
    draftWorktreeId: state.draftWorktreeId,
    /** What the composer calls the checkout a draft starts in, when the user picked one. */
    draftWorktreeName: draftWorktree ? worktreeName(draftWorktree) : null,
    environment,
    storageError: state.storageError, hiddenThreads: state.hiddenThreads,
    actionError: state.actionError,
    actionErrorPage: state.actionErrorPage,
    restored: state.restored,
    computerUseSetup: state.computerUseSetup,
    expandedProjects: state.expandedProjects,
    projectEditor: projectEditorView(state),
    worktreeMove: worktreeMoveView(state),
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
    chromeBrowser: state.chromeBrowser, conciseReplies: state.conciseReplies,
    computerUse: state.computerUse,
    browserTools: state.browserTools,
    notifications: state.notifications,
    shortcuts: shortcutSettings(state.shortcuts),
    capturingShortcut: state.capturingShortcut, desktopShortcutUnavailable: state.desktopShortcutUnavailable,
    composerFocus: state.composerFocus,
    /** Only the dock on screen can take the keys, so a request in another thread's dock is not drawn. */
    dockFocus: state.dockFocus?.owner === owner ? state.dockFocus : null,
    /** Asking for computer use opens settings whether or not the user did. */
    settingsOpen: state.settingsOpen || state.computerUseSetup,
    settingsSection: state.computerUseSetup ? "computer-use" : state.settingsSection,
    settingsFocus: state.computerUseSetup ? null : state.settingsFocus,
    engineChecking: state.engineChecking,
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
    reviewPicker: currentThread && state.reviewPicker?.taskId === currentThread.id && !busy.has(currentThread.id) ? state.reviewPicker : null,
    find: findView(state, currentThread),
    jump: jumpView(state, busy),
    remote: state.remote,
    remoteChecking: state.remoteChecking,
    canGoBack: reachableVisit(state, -1) !== null,
    canGoForward: reachableVisit(state, 1) !== null,
    sideChats: reusedSideChats(dockSideChats(state, owner).flatMap((chat): SideChatView[] => {
      const thread = state.threads.find((item) => item.id === chat.id);
      if (!thread) return [];
      const active = state.activeRuns[chat.id];
      const approval = active?.status === "awaiting-approval" ? state.approvals[active.runId] as ApprovalView | undefined : undefined;
      return [{
        ...chat,
        title: thread.title,
        thread,
        prompt: state.prompts[chat.id] ?? "",
        annotations: annotationsFor(state, chat.id),
        pastes: pastesFor(state, chat.id),
        images: imagesFor(state, chat.id),
        files: filesFor(state, chat.id),
        running: Boolean(active),
        compacting: active?.status === "compacting",
        status: active ? "running" : runStatusFor(state, chat.id),
        streamingTail: state.streamingTails[chat.id] ?? null,
        queuedMessages: state.queuedMessages[chat.id] ?? NO_QUEUED,
        readingPoint: state.readingPoints[chat.id] ?? null,
        ...(approval ? { approval } : {}),
      }];
    })),
  };
}
