import type { KeyValueStorage } from "../application/task-store.js";
import type { DesktopAPI } from "../contracts/ipc.js";
import type { WorkspaceSurfaceEffect } from "../contracts/workspace-runtime.js";

/**
 * What the runtime asks of the machine it runs on: the desktop API less everything only a window on
 * screen uses, such as file drops, the terminal's own output, and the keystrokes a window hears.
 */
export type RuntimeDesktop = Pick<DesktopAPI,
  | "openFolder" | "registerProject" | "onOpenProject" | "projectlessWorkspace"
  | "cliStatus" | "installCli" | "uninstallCli"
  | "computerUsePermissions" | "enableComputerUse" | "restartForComputerUse" | "planUsage"
  | "send" | "onAgentEvent"
  | "changedFiles" | "diffSummary" | "diffPatch" | "pullRequest" | "checkoutBranch" | "createBranch"
  | "createWorktree" | "listManagedWorktrees" | "revealWorktree" | "releaseWorktree"
  | "saveAttachment" | "preserveMessageImages" | "downloadImage"
  | "suggestTaskTitle" | "engineStatus" | "signInEngine" | "checkForUpdates" | "openSourceLicenses"
  | "loadTaskStore" | "loadThreadMessages" | "persistTaskStore" | "loadSubagentActivity"
  | "listAutomations" | "saveAutomation" | "updateAutomation" | "deleteAutomation" | "runAutomationNow"
  | "onAutomationsChanged" | "onAutomationFire" | "acknowledgeAutomation"
  | "onThreadRequest" | "answerThreadRequest"
  | "mobileState" | "setMobileEnabled" | "createMobilePairingCode" | "revokeMobileDevice" | "refreshTailscale"
  | "onMobileState" | "onMobileRequest" | "answerMobileRequest" | "publishMobileView"
  | "configureBrowserPermissions" | "openBrowserTab" | "navigateBrowser" | "browserHistory" | "reloadBrowser"
  | "closeBrowserTab" | "showBrowserTab" | "actInBrowser" | "readBrowserPage" | "inspectBrowserPage"
  | "captureBrowserPage" | "clearBrowserData" | "onBrowserEvent" | "findInPage" | "stopFindInPage"
  | "focusBrowserTab" | "onBrowserFind"
  | "openFile" | "listApps" | "openFolderInApp"
  | "startTerminal" | "writeTerminal" | "resizeTerminal" | "closeTerminal" | "readTerminal" | "onTerminalEvent"
  | "setCaptureOptions" | "setShortcuts" | "setShortcutCapture"
  | "closeWindow" | "focusWindow" | "announceThread" | "setBadgeCount"
>;

/** Where the runtime runs: the desktop it acts on, where it keeps what a window remembers, and the window itself when there is one. */
export type WorkspaceRuntimeHost = {
  desktop: RuntimeDesktop;
  /** Drafts and view preferences, which outlive the runtime and are read back at the next start. */
  storage: KeyValueStorage;
  /** How wide the window is, which is what the panels default against on a first launch. Absent without a window. */
  viewportWidth?: number;
  /** Carries out an effect that lives in a window's own views. Absent without a window, which drops it. */
  surface?: (effect: WorkspaceSurfaceEffect) => void;
  /**
   * Holds a run's reports until the next paint, so a frame folds them in together. A host without a
   * window has no paint to wait for and gathers them for a moment instead.
   */
  frame?: (flush: () => void) => () => void;
};
