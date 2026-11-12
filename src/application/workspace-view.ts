import { sideChatView, threadTabView, type SideChatView, type ThreadTabView } from "./side-chat-view.js";
import { worktreeMenuView, type WorktreeMenuState } from "./worktree-menu.js";
import type { ApprovalView } from "./thread-run-state.js";
import { runStatus } from "./run-record.js";
import { threadActivity, threadLists, waitingOn } from "./thread-activity.js";
import { compactableSession, reviewableSession } from "./session-operations.js";
import { sidebarLists } from "./sidebar-lists.js";
import { worktreeChoices } from "./worktree-choices.js";
import type { MobileWorktreeChoice } from "../contracts/mobile.js";
import { effortRoleOf, type OverviewFolds } from "../domain/coordination.js";
import { pullRequestFor } from "./pull-request-view.js";
import { AUTOMATION_PANEL, DIFF_PANEL, dockFor, dockOwner, dockSideChats, dockSubject } from "./workspace-dock.js";
import { diffFor } from "./workspace-diff.js";
import { jumpView } from "./workspace-jump.js";
import { shownViewCollections, workspaceViewCollections } from "./workspace-view-collections.js";
import { findView } from "./workspace-find.js";
import { visibleToasts } from "./toasts.js";
import { pairedId, selectedComputer } from "./state/computers.js";
import { overlaidView } from "./workspace-view-overlay.js";
import { workspaceDialogsView } from "./workspace-dialogs.js";
import type { SettingsSection } from "../domain/settings-section.js";
import { shortcutSettings } from "../domain/shortcuts.js";
import type { Workflow } from "../domain/workflow.js";
import { byEngine, capabilitiesFor, defaultEffortFor, effortForModel, threadModel, engineLabel, isAgentEngine, unopenableEngine, type EngineCapabilities, type EngineReadiness } from "../domain/agent-engine.js";
import { catalogOf, engineReadinessOf } from "./state/engines.js";
import type { Subagent } from "../domain/run.js";
import { annotationRevealFor, annotationsFor, filesFor, imagesFor, pastesFor } from "./composer-drafts.js";
import { projectName } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { worktreeName, type Worktree } from "../domain/worktree.js";
import { locationOf, projectFor, threadWorkspaceId, worktreeById } from "./thread-location.js";
import { heldViews } from "./view-reuse.js";
import { linePositions } from "../domain/usage-limit.js";
import { queuedView, workflowById, type QueuedMessageView } from "./state/runs.js";
import { currentFolder, promptKey, reachableVisit, type WorkspaceState } from "./workspace-state.js";

export type { FindView } from "./workspace-find.js";
export type { ArchivePromptView, ProjectEditorView, WorktreeMoveView } from "./workspace-dialogs.js";
export type { AnnotationReveal } from "./composer-drafts.js";
export type { DockConversationView, SideChatView, ThreadTabView } from "./side-chat-view.js";

/** A checkout with the threads working in it, which is how a project offers starting one more there. */
export type WorktreeGroup = {
  worktree: Worktree;
  threads: Thread[];
};

/** The main composer's dictation: whether it can, and what the recording on this draft is doing. */
function dictationView(state: WorkspaceState) {
  const { model, message, progress, session, sends } = state.dictation;
  const here = session && session.key === promptKey(state) ? session : null;
  return { model, message, progress, phase: here?.phase ?? null, handsFree: here?.handsFree === true && here.phase !== "transcribing", sends };
}

/** Each chat's view outlives the derive that built it, so a report elsewhere never redraws one. */
const reusedSideChats = heldViews<SideChatView>();
const reusedThreadTabs = heldViews<ThreadTabView>();

const NO_SUBAGENTS: Subagent[] = [];
const NO_QUEUED: QueuedMessageView[] = [];
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
    /** The models this view's computer can run, for every picker and label drawn from it. */
    models: catalogOf(state),
    /**
     * Why the thread in front can only be read here: it runs on an engine only a newer build on a
     * paired computer knows. Null for any thread this build can work in.
     */
    unopenable: currentThread && !isAgentEngine(currentThread.engine) ? unopenableEngine(currentThread.engine) : null,
    ...engineFeeds(capabilities, state, currentThread),
  };
}

/** The model in front and the effort a run on it gets, which for a coordinator is never one that hands work to the engine's agents. */
function modelView(state: WorkspaceState, currentThread: Thread | undefined) {
  const engine = currentThread?.engine ?? state.draftEngine;
  const model = currentThread ? threadModel(catalogOf(state), currentThread) : state.draftModel;
  const role = effortRoleOf(currentThread, state.draftRole);
  const effort = currentThread ? currentThread.effort ?? defaultEffortFor(engine) : state.draftEffort;
  return { model, coordinating: role === "coordinator", effort: model === undefined ? effort : effortForModel(catalogOf(state), engine, model, effort, role) };
}

/** What the thread in front waits on, and what its composer offers, which is nothing while a run is going or on its way. */
function waitView(state: WorkspaceState, currentThread: Thread | undefined, running: boolean) {
  const waiting = waitingOn(state, currentThread?.id, promptKey(state));
  const settled = currentThread && !running && waiting === null ? currentThread : undefined;
  return {
    waitingOn: waiting,
    canCompact: settled !== undefined && compactableSession(state, settled),
    canReview: settled !== undefined && reviewableSession(state, settled),
  };
}

/**
 * The threads ⌘1 through ⌘9 reach, read straight from state so each keystroke follows the current
 * visible order.
 */
export function threadSlots(state: WorkspaceState): string[] {
  const { ranked, blocked } = threadActivity(state);
  return sidebarLists(state, state.projects, threadLists(state).visibleThreads, ranked, blocked).threadSlots;
}

const NO_OVERVIEW_FOLDS: OverviewFolds = {};

/** The settings page an engine notice opens, and the setting it lands on. */
const ENGINE_SETTINGS: { section: SettingsSection; settingId: string | null } = { section: "engines", settingId: null };

/** Everything the UI reads, derived in one place so components never reach into raw state. */
export function deriveView(state: WorkspaceState) {
  const own = deriveOwnView(state);
  const remote = selectedComputer(state)?.state;
  if (remote) return overlaidView(state, own, remote, (shown, window) => deriveOwnView(shown, window, shownViewCollections));
  shownViewCollections.release();
  return own;
}

const NO_WORKTREE_CHOICES: MobileWorktreeChoice[] = [];

export type OwnWorkspaceView = ReturnType<typeof deriveOwnView>;

/** `window` is whose menu the location row draws: this window's when the thread is a paired computer's. */
function deriveOwnView(state: WorkspaceState, window: WorktreeMenuState = state, collectionsOf = workspaceViewCollections) {
  const currentThread = state.threads.find((thread) => thread.id === state.currentId);
  const draftWorktree = worktreeById(state, state.draftWorktreeId ?? undefined);
  const currentProject = currentThread
    ? projectFor(state, currentThread)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
  const collections = collectionsOf(state);
  const { listedThreads, visibleThreads, busy, blocked, managedWorktrees, lists } = collections;
  const currentRun = state.currentId ? state.activeRuns[state.currentId] : undefined;
  const workspaceId = currentThread
    ? threadWorkspaceId(state, currentThread)
    : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.workspaceId : undefined);
  const environment = (workspaceId ? state.environments[workspaceId] : undefined) ?? null;
  const owner = dockOwner(state), dock = dockFor(state, owner);
  return {
    ...engineView(state, currentThread),
    sideChatAttention: collections.sideChatAttention,
    unreadCount: collections.unreadCount,
    ...lists,
    startProjects: collections.startProjects,
    projectSettings: collections.projectSettings,
    threads: listedThreads,
    archivedThreads: collections.archivedThreads,
    currentThread,
    coordination: collections.coordination, coordinatorsByComputer: collections.coordinatorsByComputer, memberPullRequests: collections.memberPullRequests, memberWorktrees: collections.memberWorktrees,
    overviewFolds: (state.currentId ? state.overviewFolds[state.currentId] : undefined) ?? NO_OVERVIEW_FOLDS,
    goal: state.currentId ? state.goals[state.currentId] ?? null : null,
    currentProject,
    folder: currentProject?.root ?? "",
    /** What that folder is called: the name the user gave the project, else the folder's own. */
    folderLabel: currentProject ? projectName(currentProject) : "",
    policy: currentThread?.executionPolicy ?? state.draftPolicy,
    ...modelView(state, currentThread),
    fastMode: capabilitiesFor(currentThread?.engine ?? state.draftEngine).fastMode && (currentThread ? currentThread.fastMode ?? false : state.draftFastMode),
    prompt: state.prompts[promptKey(state)] ?? "", dictation: dictationView(state),
    annotations: annotationsFor(state, promptKey(state)), annotationReveal: annotationRevealFor(state, promptKey(state)),
    pastes: pastesFor(state, promptKey(state)),
    images: imagesFor(state, promptKey(state)),
    files: filesFor(state, promptKey(state)),
    status: runStatus(state, state.currentId),
    compacting: currentRun?.status === "compacting",
    retrying: currentRun?.retry ?? null,
    /** The usage limit the thread is waiting out, and its place in line. */
    limitPause: currentThread?.limitPause ? { ...currentThread.limitPause, position: linePositions(state.threads).get(currentThread.id) ?? null } : null,
    limitPositions: linePositions(state.threads),
    runActive: Boolean(currentRun),
    question: currentRun?.questions?.[0],
    queuedMessages: (state.currentId ? queuedView(state, state.currentId) : undefined) ?? NO_QUEUED,
    runningThreadIds: collections.everyBusy, monitoringThreadIds: collections.everyMonitoring,
    blockedThreadIds: collections.everyBlocked, stoppableCoordinatorIds: collections.everyStoppable,
    approval: currentRun?.status === "awaiting-approval" ? state.approvals[currentRun.runId] as ApprovalView | undefined : undefined,
    backgroundProcesses: (state.currentId ? state.backgroundProcesses[state.currentId] : undefined) ?? [],
    /** The workflow this thread's panel is on, which outlives a move to another thread and back. */
    inspectedWorkflow: workflowById(state, dock.workflowId) ?? null,
    streamingTail: state.currentId ? state.streamingTails[state.currentId] ?? null : null,
    readingPoint: state.currentId ? state.readingPoints[state.currentId] ?? null : null,
    automation: state.automations.find((item) => item.taskId === state.currentId) ?? null, automationEdits: state.automationEdits,
    schedules: collections.schedules,
    /** When a run on this thread last found something, which is what the automation panel reports. */
    lastFoundAt: currentThread?.lastFindingAt ?? null,
    /** What its last silent tick looked at, which is all a schedule that never speaks has to show. */
    lastChecked: currentThread?.lastChecked ?? null,
    worktreeThreadIds: collections.worktreeThreadIds,
    /** The checkouts a project has, each with the threads that claim it, and each by id for the rows that name one. */
    worktreeGroups: collections.worktreeGroups, worktreesById: collections.worktreesById,
    managedWorktrees,
    worktreeSettings: collections.worktreeSettings,
    worktreeManagementError: state.worktreeManagementError,
    worktreeManagementNotice: state.worktreeManagementNotice,
    location: locationOf(state, currentThread),
    worktreeMenu: worktreeMenuView(state, currentThread, visibleThreads, window),
    worktreeDeleteConfirmation: managedWorktrees?.find((item) => item.root === state.worktreeSettings.confirming && !item.deleting) ?? null,
    ...waitView(state, currentThread, Boolean(currentRun)),
    /** The checkout the current thread works in, which is what Git is read from and moved. */
    workspaceId,
    draftBranch: state.draftBranch, draftWorktree: state.draftWorktree, draftWorktreeId: state.draftWorktreeId, draftRole: state.draftRole,
    /** What the composer calls the checkout a draft starts in, when the user picked one. */
    draftWorktreeName: draftWorktree ? worktreeName(draftWorktree) : null,
    /** The project's existing checkouts a draft can start in instead. */
    draftWorktreeChoices: !currentThread && currentProject ? worktreeChoices(state, currentProject.id, state.draftWorktreeId ?? undefined) : NO_WORKTREE_CHOICES,
    environment,
    /** The pull request that checkout's work belongs to, drawn only while the answer is still its own. */
    pullRequest: pullRequestFor(state.pullRequest, workspaceId, environment),
    attachmentSends: state.attachmentSends,
    installedApps: state.installedApps, cli: state.cli, planUsage: state.planUsage,
    /** The limits of the account the thread on screen runs on, which is the paired computer's own for a thread there. */
    threadPlanUsage: state.planUsage,
    computerUsePermissions: state.computerUsePermissions,
    storageError: state.storageError, hiddenThreads: state.hiddenThreads,
    actionError: state.actionError,
    viewingImage: state.viewingImage, viewingGallery: state.viewingGallery,
    actionErrorPage: state.actionErrorPage,
    restored: state.restored,
    computerUseSetup: state.computerUseSetup,
    ...workspaceDialogsView(state),
    sections: state.sections,
    subagentGroups: state.subagentGroups,
    theme: state.theme,
    themeMode: state.themeMode,
    uiFont: state.uiFont,
    monoFont: state.monoFont,
    readingSize: state.readingSize,
    terminalSize: state.terminalSize,
    sidebarOpen: state.sidebarOpen,
    sessionPanelOpen: state.sessionPanelOpen,
    captureSound: state.captureSound,
    captureFocus: state.captureFocus,
    chromeBrowser: state.chromeBrowser,
    computerUse: state.computerUse,
    browserTools: state.browserTools,
    notifications: state.notifications,
    favoriteModels: state.favoriteModels, recentProjects: state.recentProjects, shortcuts: shortcutSettings(state.shortcuts),
    capturingShortcut: state.capturingShortcut, desktopShortcutUnavailable: state.desktopShortcutUnavailable,
    composerFocus: state.composerFocus,
    /** Only the dock on screen can take the keys, so a request in another thread's dock is not drawn. */
    dockFocus: state.dockFocus?.owner === owner ? state.dockFocus : null,
    /** Asking for computer use opens settings whether or not the user did. */
    settingsOpen: state.settingsOpen || state.computerUseSetup,
    settingsSection: state.computerUseSetup ? "computer-use" : state.settingsSection,
    settingsFocus: state.computerUseSetup ? null : state.settingsFocus, usageComputer: pairedId(state.computers, state.usageComputer),
    engineChecking: state.engineChecking,
    engineUpdating: state.engineUpdating,
    /** Where the composer's engine notice sends the user to fix it. */
    engineSettingsPage: ENGINE_SETTINGS,
    agentSettingsReload: state.agentSettingsReload,
    dockOpen: dock.open,
    dockExpanded: dock.expanded,
    dockPanels: dock.panels,
    /** The thread tabs the review and the automation panel show in place of the dock's own thread. */
    reviewSubject: dockSubject(state, owner, DIFF_PANEL),
    automationSubject: dockSubject(state, owner, AUTOMATION_PANEL),
    /** The review this thread has open, whether or not the panel drawing it is the tab in front. */
    diff: diffFor(state, owner),
    dockTab: dock.tab,
    browserTabs: dock.browserTabs,
    browserApproval: state.browserApproval,
    browserOrigins: state.browserOrigins, browserImport: state.browserImport,
    /** The simulators, and the one this dock's panel shows. */
    simulator: state.simulator, simulatorId: dock.simulatorId,
    terminals: dock.terminals,
    currentFolder: currentFolder(state),
    openMenu: state.openMenu,
    reviewPicker: currentThread && state.reviewPicker?.taskId === currentThread.id && !busy.has(currentThread.id) ? state.reviewPicker : null,
    find: findView(state, currentThread),
    jump: jumpView(state, busy), zen: state.zen, zenAvailable: Boolean(currentThread?.messages.length),
    remote: state.remote,
    remoteChecking: state.remoteChecking,
    appUpdate: state.appUpdate,
    visibleToasts: visibleToasts(state),
    /** The paired computers as the chrome draws them, and the one whose thread is on screen. */
    computerLinks: collections.computerLinks,
    /** Each paired computer's own plan limits, beside this computer's `planUsage`. */
    computerUsage: collections.computerUsage,
    /** Each paired computer's version, and what moves it or its engines to a newer one. */
    computerUpkeep: collections.computerUpkeep,
    activeComputer: collections.computerLinks.find((link) => link.id === state.computers.active) ?? null,
    computerName: state.computers.name,
    computerFilter: state.computers.filter,
    computerPairing: state.computers.pairing,
    computersFound: state.computers.found,
    computersSearching: state.computers.searching,
    computersSearchError: state.computers.searchError,
    threadHosts: collections.remote.threadHosts,
    projectHosts: collections.remote.projectHosts,
    canGoBack: reachableVisit(state, -1) !== null,
    canGoForward: reachableVisit(state, 1) !== null,
    sideChats: reusedSideChats(dockSideChats(state, owner).flatMap((chat) => sideChatView(state, chat))),
    threadTabs: reusedThreadTabs(dock.threadTabs.flatMap((taskId) => threadTabView(state, taskId, busy, blocked))),
  };
}
