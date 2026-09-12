import { app, dialog, shell, type BrowserWindow } from "electron";
import type { AgentEngine } from "../domain/agent-engine.js";
import { terminalLineLimit } from "../domain/terminal.js";
import type { PlanUsage } from "../domain/plan-usage.js";
import type { PullRequestAnswer } from "../domain/pull-request.js";
import type { RunCommand } from "../contracts/ipc.js";
import type { RuntimeDesktop } from "../host/runtime-desktop.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { EngineAccessHost } from "./agent/engine-services.mjs" with { "resolution-mode": "import" };
import type { TaskDatabaseService } from "./task-database-service.mjs" with { "resolution-mode": "import" };
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };
import { readAttachmentContext, savedAttachmentPath, writeAttachment } from "./attachment-store.js";
import { cliStatus, installCli, uninstallCli } from "./cli-install.js";
import { computerUsePermissions, requestComputerUsePermission } from "./computer-use-host.js";
import { announceThread, type NoticeHost } from "./desktop-notice.js";
import type { DesktopEvents } from "./desktop-events.js";
import { downloadImage } from "./image-download.js";
import type { KeyboardBridge } from "./keyboard-host.js";
import { openSourceLicenses } from "./license-window.js";
import { preserveMessageImages } from "./message-image-store.js";
import { mobileBridge } from "./mobile/bridge.js";
import { listInstalledApps, openFolderInApp } from "./open-in-app.js";
import { openInEditor } from "./open-in-editor.js";
import type { RunBridge } from "./run-host.js";
import { checkForUpdates, type UpdateHost } from "./updates.js";
import * as browser from "./browser-host.js";
import * as terminal from "./terminal-host.js";

/** What the desktop takes to answer the runtime: the services, and the window the answers sometimes need. */
export type RuntimeDesktopHost = {
  window: () => BrowserWindow | null;
  notices: NoticeHost;
  updates: UpdateHost;
  events: DesktopEvents;
  keyboard: KeyboardBridge;
  runs: RunBridge;
  workspaces: () => WorkspaceService;
  worktrees: () => WorktreeService;
  taskDatabase: () => TaskDatabaseService;
  scheduler: () => AutomationScheduler;
  engineAccess: () => Promise<EngineAccessHost>;
  /** The roots the app keeps checkouts under, which a folder the user names may not be inside. */
  worktreesRoots: () => string[];
  restart: () => void;
};

function failed(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Folders, checkouts, and what Git and GitHub say about them. */
function workspaceDesktop(host: RuntimeDesktopHost) {
  const { events } = host;
  async function resolved(workspaceId: string) {
    const resolution = await host.workspaces().resolve(workspaceId);
    if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
    return resolution.workspace.root;
  }
  return {
    openFolder: async () => {
      const window = host.window();
      const result = await (window ? dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"], title: "Open a project folder" }) : dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], title: "Open a project folder" }));
      if (result.canceled || !result.filePaths[0]) return null;
      return (await host.workspaces().registerProject(result.filePaths[0])).workspace;
    },
    registerProject: async (root) => {
      const { projectFolder } = await import("./project-folder.mjs");
      return (await host.workspaces().registerProject(await projectFolder(root, host.worktreesRoots()))).workspace;
    },
    onOpenProject: (listener) => events.on("workspace:open-project", listener),
    projectlessWorkspace: async () => (await host.workspaces().getProjectless()).workspace,
    cliStatus,
    installCli,
    uninstallCli,
    computerUsePermissions,
    enableComputerUse: requestComputerUsePermission,
    restartForComputerUse: () => {
      host.restart();
      app.quit();
    },
    planUsage: async (engine: AgentEngine): Promise<PlanUsage> => {
      try {
        const { engineServices } = await import("./agent/engine-services.mjs");
        return await engineServices[engine].planUsage();
      } catch (cause) {
        return { status: "unavailable", message: failed(cause) };
      }
    },
    send: (command: RunCommand) => host.runs.submit(command),
    onAgentEvent: (listener) => events.on("run:event", listener),
    changedFiles: async (workspaceId) => {
      try {
        const { changedFiles } = await import("./workspace/git-changes.mjs");
        return await changedFiles(workspaceId, host.workspaces());
      } catch (error) {
        return { status: "error", message: failed(error) };
      }
    },
    diffSummary: async (workspaceId, range, ignoreWhitespace) => {
      try {
        const { diffSummary } = await import("./workspace/git-diff.mjs");
        return await diffSummary(workspaceId, range, host.workspaces(), ignoreWhitespace === true);
      } catch (error) {
        return { status: "error", message: failed(error) };
      }
    },
    diffPatch: async (workspaceId, range, filePath, previousPath, ignoreWhitespace) => {
      try {
        const { diffPatch } = await import("./workspace/git-diff.mjs");
        return await diffPatch(workspaceId, range, filePath, host.workspaces(), previousPath, ignoreWhitespace === true);
      } catch (error) {
        return { status: "error", message: failed(error) };
      }
    },
    pullRequest: async (workspaceId): Promise<PullRequestAnswer> => {
      try {
        const resolution = await host.workspaces().resolve(workspaceId);
        if (resolution.status !== "available") return { status: "none" };
        const { pullRequestFor } = await import("./workspace/github.mjs");
        return await pullRequestFor(resolution.workspace.root);
      } catch {
        return { status: "none" };
      }
    },
    checkoutBranch: async (workspaceId, branch) => {
      const { checkoutBranch } = await import("./workspace/git.mjs");
      await checkoutBranch(await resolved(workspaceId), branch);
    },
    createBranch: async (workspaceId, branch) => {
      const { createBranch } = await import("./workspace/git.mjs");
      await createBranch(await resolved(workspaceId), branch);
    },
    createWorktree: (request) => host.worktrees().create(request),
    listManagedWorktrees: () => host.worktrees().list(),
    revealWorktree: async (root) => { shell.showItemInFolder(await host.worktrees().ownedPath(root)); },
    releaseWorktree: (request) => host.worktrees().release(request),
  } satisfies Partial<RuntimeDesktop>;
}

/** Files on disk, the engines, storage, schedules, and the phone bridge. */
function serviceDesktop(host: RuntimeDesktopHost) {
  const { events } = host;
  return {
    saveAttachment: async (data, original) => {
      if (original !== undefined && !savedAttachmentPath(original)) throw new Error("That image is not one this app is keeping.");
      const context = original === undefined ? null : await readAttachmentContext(original);
      return writeAttachment(data, context);
    },
    preserveMessageImages: (files, root, messageId) => preserveMessageImages(files, root, messageId),
    downloadImage: async (source) => {
      const window = host.window();
      if (!window) throw new Error("There is no window to save into.");
      await downloadImage(window, source);
    },
    suggestTaskTitle: async (text, attachments, engine) => {
      const images = attachments.map((item) => savedAttachmentPath(item)).filter((file): file is string => file !== null);
      if (!text.trim() && images.length === 0) return null;
      try {
        const { engineServices } = await import("./agent/engine-services.mjs");
        return await engineServices[engine].suggestTitle(text, images);
      } catch {
        return null;
      }
    },
    engineStatus: async (refresh) => (await host.engineAccess()).read(refresh === true),
    signInEngine: async (engine) => (await host.engineAccess()).signIn(engine, (url) => shell.openExternal(url)),
    checkForUpdates: () => { void checkForUpdates(host.updates, { userRequested: true }).catch((error) => console.error("Update check failed:", error)); },
    openSourceLicenses: () => openSourceLicenses(host.window()),
    loadTaskStore: () => host.taskDatabase().loadSummaries(),
    loadThreadMessages: (taskId) => host.taskDatabase().loadThreadMessages(taskId),
    persistTaskStore: (delta) => host.taskDatabase().persist(delta),
    loadSubagentActivity: (taskId, subagentId) => host.taskDatabase().subagentActivity(taskId, subagentId),
    listAutomations: async () => host.scheduler().list(),
    saveAutomation: (draft) => host.scheduler().save(draft),
    updateAutomation: (taskId, patch) => host.scheduler().update(taskId, patch),
    deleteAutomation: (taskId) => host.scheduler().remove(taskId),
    runAutomationNow: (taskId) => host.scheduler().runNow(taskId),
    onAutomationsChanged: (listener) => events.on("automation:changed", listener),
    onAutomationFire: (listener) => events.on("automation:fire", listener),
    acknowledgeAutomation: (ack) => host.runs.acknowledgeAutomation(ack.runId, ack.started),
    onThreadRequest: (listener) => events.on("thread:request", listener),
    answerThreadRequest: (response) => host.runs.answerThread(response),
    mobileState: () => mobileBridge.state(),
    setMobileEnabled: (enabled) => mobileBridge.setEnabled(enabled),
    createMobilePairingCode: () => mobileBridge.createPairingCode(),
    revokeMobileDevice: (deviceId) => mobileBridge.revokeDevice(deviceId),
    refreshTailscale: () => mobileBridge.refreshTailscale(),
    onMobileState: (listener) => events.on("mobile:changed", listener),
    onMobileRequest: (listener) => events.on("mobile:request", listener),
    answerMobileRequest: (response) => mobileBridge.answer(response),
    publishMobileView: (update) => mobileBridge.publish(update),
  } satisfies Partial<RuntimeDesktop>;
}

/** The browser and terminal panels, whose pages and shells live in this process. */
function panelDesktop(host: RuntimeDesktopHost) {
  const { events } = host;
  return {
    configureBrowserPermissions: async (permissions) => browser.configurePermissions(permissions),
    openBrowserTab: async (tabId, url, taskId) => browser.openTab(tabId, url, taskId),
    navigateBrowser: async (tabId, url, taskId) => browser.navigate(tabId, url, taskId),
    browserHistory: async (tabId, delta, taskId) => browser.goHistory(tabId, delta, taskId),
    reloadBrowser: async (tabId, taskId) => browser.reload(tabId, taskId),
    closeBrowserTab: async (tabId) => browser.closeTab(tabId),
    showBrowserTab: async (tabId) => browser.showTab(tabId),
    actInBrowser: (tabId, action, taskId) => browser.act(tabId, action, taskId),
    readBrowserPage: (tabId, textLimit, timeoutMs, taskId) => browser.readPage(tabId, textLimit, timeoutMs, taskId),
    inspectBrowserPage: (tabId, inspection, taskId) => browser.inspectPage(tabId, inspection, taskId),
    captureBrowserPage: (tabId, fullPage, timeoutMs, taskId) => browser.capturePage(tabId, fullPage, timeoutMs, taskId),
    clearBrowserData: () => browser.clearData(),
    onBrowserEvent: (listener) => events.on("browser:event", listener),
    findInPage: async (tabId, query, forward, findNext) => browser.findInPage(tabId, query, { forward, findNext }),
    stopFindInPage: async (tabId) => browser.stopFindInPage(tabId),
    focusBrowserTab: async (tabId) => browser.focusTab(tabId),
    onBrowserFind: (listener) => events.on("browser:find", listener),
    openFile: async (roots, candidate, line) => {
      const { openableFile } = await import("./path-policy.mjs");
      await openInEditor(await openableFile(roots, candidate), line);
    },
    listApps: () => listInstalledApps(),
    openFolderInApp: async (appId, root) => {
      const { fileInCheckout } = await import("./path-policy.mjs");
      await openFolderInApp(appId, await fileInCheckout(root, "."));
    },
    startTerminal: async (terminalId, options) => terminal.startTerminal(terminalId, options.cwd),
    writeTerminal: async (terminalId, data) => terminal.writeTerminal(terminalId, data),
    resizeTerminal: async (terminalId, cols, rows) => terminal.resizeTerminal(terminalId, cols, rows),
    closeTerminal: async (terminalId) => terminal.closeTerminal(terminalId),
    readTerminal: (terminalId, options) => terminal.readTerminal(terminalId, { lines: terminalLineLimit(options.lines), ...(options.match ? { match: options.match } : {}) }),
    onTerminalEvent: (listener) => events.on("terminal:event", listener),
  } satisfies Partial<RuntimeDesktop>;
}

/** The window itself, its keys, and the desktop around it. */
function windowDesktop(host: RuntimeDesktopHost) {
  return {
    setCaptureOptions: (options) => host.keyboard.setCaptureOptions(options),
    setShortcuts: (overrides) => {
      host.keyboard.setShortcuts(overrides);
      host.keyboard.claimDesktopShortcut();
    },
    setShortcutCapture: (capturing) => {
      host.keyboard.setCapturing(capturing);
      /** A keystroke the desktop is holding never reaches the window, so settings cannot read it back. */
      if (capturing) host.keyboard.releaseDesktopShortcut();
      else host.keyboard.claimDesktopShortcut();
    },
    closeWindow: () => host.window()?.close(),
    /** A page in the panel holds the keyboard until the window asks for it back. */
    focusWindow: () => host.window()?.webContents.focus(),
    announceThread: (notice) => announceThread(host.notices, notice),
    setBadgeCount: (count) => app.setBadgeCount(count),
  } satisfies Partial<RuntimeDesktop>;
}

/** The runtime's desktop, answered in the process that owns every service it names. */
export function createRuntimeDesktop(host: RuntimeDesktopHost): RuntimeDesktop {
  return { ...workspaceDesktop(host), ...serviceDesktop(host), ...panelDesktop(host), ...windowDesktop(host) };
}
