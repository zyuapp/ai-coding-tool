import { annotationsFor, filesFor, imagesFor, pastesFor } from "./composer-drafts.js";
import { promptKey, type OwnWorkspaceView, type WorkspaceState } from "./workspace-state.js";
import type { WorktreeMenuState } from "./worktree-menu.js";

/**
 * Everything the window paints from its own state whichever computer's thread is on screen: the
 * chrome, the settings, and the lists that merge every computer's threads.
 */
const OWN_VIEW_KEYS = [
  "unreadCount", "sideChatAttention", "threads", "orderedThreads", "threadsByProject", "projects", "startProjects", "activityThreads", "recentThreads", "threadSlots",
  "runningThreadIds", "blockedThreadIds", "worktreeThreadIds", "worktreeGroups", "schedules", "archivedThreads",
  "managedWorktrees", "worktreeSettings", "worktreeManagementError", "worktreeManagementNotice", "worktreeDeleteConfirmation",
  "installedApps", "cli", "planUsage", "computerUsePermissions", "computerUseSetup", "storageError", "hiddenThreads", "restored", "viewingImage",
  "expandedProjects", "projectAdd", "projectEditor", "worktreeMove", "sections", "subagentGroups", "theme", "themeMode", "uiFont", "monoFont", "readingSize", "terminalSize",
  "sidebarMode", "sidebarOpen", "sessionPanelOpen", "captureSound", "captureFocus", "chromeBrowser", "conciseReplies", "computerUse", "browserTools", "notifications",
  "favoriteModels", "shortcuts", "capturingShortcut", "desktopShortcutUnavailable", "composerFocus", "settingsOpen", "settingsSection", "settingsFocus",
  "openMenu", "jump", "remote", "remoteChecking", "canGoBack", "canGoForward", "browserOrigins",
  "computerLinks", "activeComputer", "computerName", "computerFilter", "computerPairing", "computersFound", "computersSearching", "computersSearchError", "threadHosts", "projectHosts",
] as const;

type OwnView = Pick<OwnWorkspaceView, (typeof OWN_VIEW_KEYS)[number]>;

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
    prompt: state.prompts[key] ?? "",
    annotations: annotationsFor(state, key),
    pastes: pastesFor(state, key),
    images: imagesFor(state, key),
    files: filesFor(state, key),
    attachmentSends: state.attachmentSends,
    readingPoint: shown.currentThread ? state.readingPoints[shown.currentThread.id] ?? null : null,
    /** A panel needs the shell or the page beside it, which are on the other computer. */
    terminals: [],
    browserTabs: [],
    browserApproval: null,
    /** A delete confirmed here may name the other computer's checkout, which only its list has. */
    worktreeDeleteConfirmation: own.worktreeDeleteConfirmation ?? shown.managedWorktrees?.find((item) => item.root === state.worktreeSettings.confirming && !item.deleting) ?? null,
    actionError: state.actionError ?? shown.actionError,
    actionErrorPage: state.actionError ? state.actionErrorPage : shown.actionErrorPage,
  };
}

