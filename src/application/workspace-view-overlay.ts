import { NO_SIMULATORS, type SimulatorState } from "../domain/simulator.js";
import { annotationRevealFor, annotationsFor, filesFor, imagesFor, pastesFor } from "./composer-drafts.js";
import { promptKey, type WorkspaceState } from "./workspace-state.js";
import type { OwnWorkspaceView, SideChatView, ThreadTabView } from "./workspace-view.js";
import { heldViews } from "./view-reuse.js";
import type { WorktreeMenuState } from "./worktree-menu.js";
import type { OverviewFolds } from "../domain/coordination.js";

/**
 * Everything the window paints from its own state whichever computer's thread is on screen: the
 * chrome, the settings, and the lists that merge every computer's threads.
 */
const OWN_VIEW_KEYS = [
  "unreadCount", "sideChatAttention", "threads", "orderedThreads", "projects", "startProjects", "projectSettings", "activityThreads", "threadSlots",
  "runningThreadIds", "monitoringThreadIds", "blockedThreadIds", "stoppableCoordinatorIds", "worktreeThreadIds", "worktreeGroups", "worktreesById", "schedules", "archivedThreads",
  "managedWorktrees", "worktreeSettings", "worktreeManagementError", "worktreeManagementNotice", "worktreeDeleteConfirmation",
  "installedApps", "cli", "planUsage", "computerUsePermissions", "computerUseSetup", "storageError", "hiddenThreads", "restored", "viewingImage", "viewingGallery",
  "projectAdd", "projectEditor", "worktreeMove", "forkName", "archivePrompt", "sections", "subagentGroups", "theme", "themeMode", "uiFont", "monoFont", "readingSize", "terminalSize",
  "activityProject", "sidebarOpen", "sessionPanelOpen", "captureSound", "captureFocus", "chromeBrowser", "computerUse", "browserTools", "memoryProtection", "notifications",
  "favoriteModels", "recentProjects", "shortcuts", "capturingShortcut", "desktopShortcutUnavailable", "composerFocus", "settingsOpen", "settingsSection", "settingsFocus", "usageComputer",
  "openMenu", "jump", "zen", "remote", "remoteChecking", "appUpdate", "visibleToasts", "automationEdits", "canGoBack", "canGoForward", "browserOrigins", "browserImport",
  "computerLinks", "computerUsage", "computerUpkeep", "activeComputer", "computerName", "computerFilter", "computerPairing", "computersFound", "computersSearching", "computersSearchError", "threadHosts", "projectHosts",
  "threadsByCoordinator", "waitingLines", "coordinatorsByComputer", "dictation",
] as const;

type OwnView = Pick<OwnWorkspaceView, (typeof OWN_VIEW_KEYS)[number]>;

const REMOTE_ENGINE_SETTINGS: OwnWorkspaceView["engineSettingsPage"] = { section: "phone", settingId: "phone.computers" };

const reusedSideChats = heldViews<SideChatView>();
const NO_OVERVIEW_FOLDS: OverviewFolds = {};
const reusedThreadTabs = heldViews<ThreadTabView>();

/** Main and side composers both read the drafts typed in this window. */
function localDraft(state: WorkspaceState, key: string) {
  return {
    prompt: state.prompts[key] ?? "",
    annotations: annotationsFor(state, key),
    annotationReveal: annotationRevealFor(state, key),
    pastes: pastesFor(state, key),
    images: imagesFor(state, key),
    files: filesFor(state, key),
  };
}

const REMOTE_SIMULATORS: SimulatorState = { ...NO_SIMULATORS, availability: { status: "unsupported", reason: "The simulator only runs on the computer you are using." } };

/** The window over a paired computer's thread: that computer's view of it, under this window's own chrome and drafts. */
export function overlaidView(state: WorkspaceState, own: OwnWorkspaceView, remote: WorkspaceState, derive: (state: WorkspaceState, window: WorktreeMenuState) => OwnWorkspaceView) {
  /** The location menu opens and is searched here, over the other computer's threads and checkouts. */
  const shown = derive(remote, state);
  const kept = {} as OwnView;
  for (const key of OWN_VIEW_KEYS) (kept as Record<string, unknown>)[key] = own[key];
  const key = promptKey(remote);
  return {
    ...shown,
    ...kept,
    /** Drafts stay where they are typed, so the other computer never hears a keystroke. */
    ...localDraft(state, key),
    sideChats: reusedSideChats(shown.sideChats.map((chat) => ({ ...chat, ...localDraft(state, chat.id) }))),
    threadTabs: reusedThreadTabs(shown.threadTabs.map((tab) => ({ ...tab, ...localDraft(state, tab.id) }))),
    attachmentSends: state.attachmentSends,
    /** Terminal search runs in this window's xterm, using the output it has received. */
    find: own.find?.target.kind === "terminal" ? own.find : shown.find?.target.kind === "terminal" ? null : shown.find,
    readingPoint: shown.currentThread ? state.readingPoints[shown.currentThread.id] ?? null : null,
    /** Folding an Overview is this window's own view of the coordinator, wherever the coordinator runs. */
    overviewFolds: (shown.currentThread ? state.overviewFolds[shown.currentThread.id] : undefined) ?? NO_OVERVIEW_FOLDS,
    /** Browser surfaces still belong to the host's native window. */
    browserTabs: [],
    browserApproval: null,
    /** So do simulators: this Mac cannot stream or tap a device the other computer runs. */
    simulator: REMOTE_SIMULATORS,
    simulatorId: null,
    /** A delete confirmed here may name the other computer's checkout, which only its list has. */
    worktreeDeleteConfirmation: own.worktreeDeleteConfirmation ?? shown.managedWorktrees?.find((item) => item.root === state.worktreeSettings.confirming && !item.deleting) ?? null,
    /** That computer's engines are upgraded from its row on the Computers page, not this one's Engines page. */
    engineSettingsPage: REMOTE_ENGINE_SETTINGS,
    actionError: state.actionError ?? shown.actionError,
    actionErrorPage: state.actionError ? state.actionErrorPage : shown.actionErrorPage,
  };
}
