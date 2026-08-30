import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, net, protocol, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { readFileSync } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACHMENT_SCHEME, attachmentName } from "../application/attachments.js";
import { isAutomationAck, isShortcutOverrides, isThreadResponse, isWindowTheme, type AvailableCommand, type BrowserPageEvent, type ComputerUsePermission, type WindowTheme } from "../contracts/ipc.js";
import { isAutomationDraft, isAutomationPatch } from "../domain/automation.js";
import { isAgentEngine, type AgentEngine } from "../domain/agent-engine.js";
import { isCaptureOptions } from "../domain/capture.js";
import { CLI_URL_SCHEME, projectPathFromArgv, projectPathFromUrl } from "../domain/cli.js";
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { TaskDatabase } from "./task-database.mjs" with { "resolution-mode": "import" };
import type { EngineAccessHost } from "./agent/engine-services.mjs" with { "resolution-mode": "import" };
import { attachmentsDirectory, savedAttachmentPath, writeAttachment } from "./attachment-store.js";
import { browserPageUrl, registerBrowserIpc } from "./browser-ipc.js";
import { cliStatus, installCli, uninstallCli } from "./cli-install.js";
import { computerUseForRun, computerUsePermissions, requestComputerUsePermission, stopComputerUse } from "./computer-use-host.js";
import { serveBadgeCount, serveThreadNotices, type NoticeHost } from "./desktop-notice.js";
import { startKeyboardHost } from "./keyboard-host.js";
import { openInEditor } from "./open-in-editor.js";
import { serveExternalApps } from "./open-in-app.js";
import { installAppMenu } from "./app-menu.js";
import { registerAppImageProtocol } from "./linux-protocol.js";
import { adoptLoginShellPath } from "./login-path.js";
import { startRunHost } from "./run-host.js";
import { registerTerminalIpc } from "./terminal-ipc.js";
import { checkForUpdates, type UpdateHost } from "./updates.js";
import { adoptUserDataFolder } from "./user-data.js";
import { rememberedPlacement, watchWindowPlacement } from "./window-placement.js";
import { windowFrameOptions } from "./platform-capabilities.js";
import { registerWorkspaceIpc } from "./workspace-ipc.js";
import { mobileBridgeHolding, mobileWindowGone, serveMobileBridge, startMobileBridge, stopMobileBridge } from "./mobile/bridge.js";
import * as browser from "./browser-host.js";
import * as terminal from "./terminal-host.js";

app.setName("AI Coding Tool");
/** Ahead of the lock, which writes its own files into the folder and would leave nothing to move onto. */
app.setPath("userData", adoptUserDataFolder(app.getPath("appData"), app.getName()));

protocol.registerSchemesAsPrivileged([
  { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** The `aic` command opens a folder in the app that is already running, never a second one. */
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  console.log("AI Coding Tool is already running. Bringing that window forward instead of starting a second one.");
  app.exit(0);
}
/** Only the installed app claims the scheme; a run from source would hand it to the bare Electron binary. */
if (app.isPackaged) app.setAsDefaultProtocolClient(CLI_URL_SCHEME);

const icon = path.join(app.getAppPath(), "assets", "icon.png");
let window: BrowserWindow | null = null;
let workspaceService: WorkspaceService | null = null;
let worktreeService: WorktreeService | null = null;
let taskDatabase: TaskDatabase | null = null;
let automationScheduler: AutomationScheduler | null = null;
let quitState: "running" | "stopping" | "ready" = "running";
let restartRequested = false;
let restartIssued = false;
let updateRestartScheduled = false;
let reopenArgs: string[] | null = null;
/** Folders the `aic` command named, held until the window is up and listening for them. */
const pendingProjectOpens: string[] = [];
const pendingMenuCommands: string[] = [];
let rendererListening = false;

function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

function getAutomationScheduler() {
  if (!automationScheduler) throw new Error("Automation scheduler is not ready.");
  return automationScheduler;
}

function getWorkspaceService() {
  if (!workspaceService) throw new Error("Workspace service is not ready.");
  return workspaceService;
}

function getWorktreeService() {
  if (!worktreeService) throw new Error("Worktree service is not ready.");
  return worktreeService;
}

const runs = startRunHost({
  window: () => window,
  running: () => quitState === "running",
  workspaces: getWorkspaceService,
  scheduler: getAutomationScheduler,
  trusted: trustedSender,
  computerUseForRun,
});

const keyboard = startKeyboardHost({ window: () => window, reveal: revealWindow });

async function readCommands(workspaceId: string, engine: AgentEngine): Promise<AvailableCommand[]> {
  const resolution = await getWorkspaceService().resolve(workspaceId);
  if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
  const workspace = { workspaceRoot: resolution.workspace.root, projectless: resolution.workspace.kind === "projectless" };
  const { engineServices } = await import("./agent/engine-services.mjs");
  return engineServices[engine].commands(workspace);
}

/**
 * The theme's canvas and ground, so the window does not flash a colour the user has already left
 * and the platform's own frame is drawn to match. Remembered on disk because the frame exists
 * before the renderer can say which theme it is in.
 */
const DEFAULT_WINDOW_THEME: WindowTheme = { variant: "dark", canvas: "#0e1117" };
let windowTheme = DEFAULT_WINDOW_THEME;

function windowThemePath() {
  return path.join(app.getPath("userData"), "window-theme.v1.json");
}

/** An unreadable file simply means the default, which is what a first launch reads anyway. */
function loadWindowTheme(): WindowTheme {
  try {
    const value: unknown = JSON.parse(readFileSync(windowThemePath(), "utf8"));
    return isWindowTheme(value) ? value : DEFAULT_WINDOW_THEME;
  } catch {
    return DEFAULT_WINDOW_THEME;
  }
}

/**
 * The app's own window loads only bundled content, so it keeps the blanket grant it has always had.
 * It is spelled out here because the font picker asks for `local-fonts`, which Chromium prompts for.
 * The browser panel runs in its own partition and is untouched by this.
 */
function grantAppWindowPermissions() {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
}

function applyWindowTheme(theme: WindowTheme) {
  windowTheme = theme;
  /** Following means leaving the platform to its own appearance, which is what the renderer is reading. */
  nativeTheme.themeSource = theme.follow ? "system" : theme.variant;
  if (window && !window.isDestroyed()) window.setBackgroundColor(theme.canvas);
}

/** Writes queue behind one another, since two overlapping ones leave the tail of the longer. */
let themeWritten: Promise<void> = Promise.resolve();

function rememberWindowTheme(theme: WindowTheme) {
  themeWritten = themeWritten.then(() => writeFile(windowThemePath(), JSON.stringify(theme))).catch(() => undefined);
}

function revealWindow() {
  if (quitState !== "running") return;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  app.focus({ steal: true });
}

function scheduleRestart(args?: string[]) {
  if (restartIssued || updateRestartScheduled || !restartRequested) return;
  restartIssued = true;
  app.relaunch(args ? { args } : undefined);
}

function requestRestart(args?: string[]) {
  restartRequested = true;
  if (args || reopenArgs === null) reopenArgs = args ?? [];
  if (quitState === "ready") scheduleRestart(reopenArgs.length ? reopenArgs : undefined);
}

/** A launch aimed at the old process waits for it to finish rather than racing its teardown. */
function queueReopen(args?: string[]) {
  if (quitState === "running") return false;
  requestRestart(args);
  return true;
}

function argsForReopen(url: string) {
  return [...process.argv.slice(1).filter((argument) => !argument.startsWith(`${CLI_URL_SCHEME}://`)), url];
}

/** Registers each folder the CLI named and hands it to the window, which is the only writer of state. */
async function flushProjectOpens() {
  if (!rendererListening || !workspaceService || !pendingProjectOpens.length) return;
  while (pendingProjectOpens.length) {
    const root = pendingProjectOpens.shift()!;
    try {
      const registration = await getWorkspaceService().registerProject(root);
      if (window && !window.isDestroyed()) window.webContents.send("workspace:open-project", registration.workspace);
    } catch (error) {
      console.error("Could not open the folder the aic command named:", error);
    }
  }
  revealWindow();
}

function flushMenuCommands() {
  if (!rendererListening || !window || window.isDestroyed()) return;
  while (pendingMenuCommands.length) window.webContents.send("window:shortcut", { action: pendingMenuCommands.shift()!, surface: "any" });
}

/** A menu remains usable after macOS closes the last window, so its command waits for the next renderer. */
function sendMenuCommand(action: string) {
  pendingMenuCommands.push(action);
  if (!window || window.isDestroyed()) {
    rendererListening = false;
    void createWindow().then(revealWindow).catch((error) => console.error("Could not reopen the app window:", error));
    return;
  }
  revealWindow();
  flushMenuCommands();
}

function openProjectPath(root: string) {
  pendingProjectOpens.push(root);
  void flushProjectOpens();
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (queueReopen(argsForReopen(url))) return;
  const root = projectPathFromUrl(url);
  if (root) openProjectPath(root);
  else revealWindow();
});

app.on("second-instance", (_event, argv) => {
  const url = argv.find((argument) => argument.startsWith(`${CLI_URL_SCHEME}://`));
  if (queueReopen(url ? argsForReopen(url) : undefined)) return;
  const root = projectPathFromArgv(argv);
  if (root) openProjectPath(root);
  else revealWindow();
});

async function createWindow() {
  const placement = rememberedPlacement();
  window = new BrowserWindow({
    ...placement,
    ...windowFrameOptions(),
    minWidth: 820,
    minHeight: 620,
    fullscreen: placement.fullScreen,
    backgroundColor: windowTheme.canvas,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /** A phone reads this renderer's state while the window is hidden, so it is never throttled. */
      backgroundThrottling: false,
    },
  });
  browser.startBrowserHost(window, {
    onPage: (event: BrowserPageEvent) => {
      if (window && !window.isDestroyed()) window.webContents.send("browser:event", event);
    },
    onFind: (tabId, results) => {
      if (window && !window.isDestroyed()) window.webContents.send("browser:find", { tabId, ...results });
    },
    onKey: (input) => keyboard.handleKey(input, "browser"),
  });
  terminal.startTerminalHost({
    onData: (event) => {
      if (window && !window.isDestroyed()) window.webContents.send("terminal:data", event);
    },
    onUpdate: (update) => {
      if (window && !window.isDestroyed()) window.webContents.send("terminal:event", update);
    },
  });
  /** The window owns no menu shortcut the app wants back; preventing it here is what frees ⌘W. */
  window.webContents.on("before-input-event", (event, input) => {
    if (keyboard.handleKey(input, "any")) event.preventDefault();
  });
  /** A normal link leaves AI Coding Tool. Its context menu offers the browser panel separately. */
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(browserPageUrl(url)).catch((error) => console.error("Could not open link:", error));
    } catch {
      // Chromium asked to open something other than a web page.
    }
    return { action: "deny" };
  });
  if (placement.maximized && !placement.fullScreen) window.maximize();
  watchWindowPlacement(window);
  /** A phone reads the window's own state, so closing it while one is paired only puts it away. */
  window.on("close", (event) => {
    if (quitState !== "running" || !mobileBridgeHolding()) return;
    event.preventDefault();
    window?.hide();
  });
  window.on("closed", () => {
    rendererListening = false;
    mobileWindowGone();
    browser.stopBrowserHost();
    terminal.stopTerminalHost();
  });
  await window.loadFile(path.join(__dirname, "../../renderer/index.html"));
}

const updateHost: UpdateHost = {
  window: () => window,
  onInstall: () => { updateRestartScheduled = true; },
};

/**
 * Worktrees live outside app data: the path has no space in it for a project's own tooling to trip
 * over, no retired brand for the user to read in `git worktree list`, and multi-gigabyte checkouts
 * stay out of the backups app data is swept into.
 */
const WORKTREES_ROOT = path.join(homedir(), ".aicodingtool", "worktrees");

/** Where the app kept worktrees before, still its own: listed and manually removable, never created in. */
function legacyWorktreesRoots(userData: string) {
  return [path.join(userData, "worktrees")].filter((root) => root !== WORKTREES_ROOT);
}

app.whenReady().then(async () => {
  if (!singleInstance) return;
  /** Started before the app spawns anything, and awaited before the first thing that needs it. */
  const searchPath = adoptLoginShellPath();
  const userData = app.getPath("userData");
  if (process.platform === "linux" && app.isPackaged && process.env.APPIMAGE) {
    void registerAppImageProtocol({ appImage: process.env.APPIMAGE, home: homedir(), iconSource: icon, dataHome: process.env.XDG_DATA_HOME })
      .catch((error) => console.error("Could not register the AppImage URL handler:", error));
  }
  grantAppWindowPermissions();
  applyWindowTheme(loadWindowTheme());
  const { WorkspaceService: WorkspaceServiceConstructor } = await import("./workspace/workspace-service.mjs");
  workspaceService = new WorkspaceServiceConstructor({
    registryPath: path.join(userData, "workspaces.v1.json"),
    projectlessRoot: path.join(userData, "projectless"),
  });
  const { WorktreeService: WorktreeServiceConstructor } = await import("./workspace/worktrees.mjs");
  worktreeService = new WorktreeServiceConstructor({ worktreesRoot: WORKTREES_ROOT, legacyRoots: legacyWorktreesRoots(userData), workspaces: workspaceService });
  const { TaskDatabase: TaskDatabaseConstructor } = await import("./task-database.mjs");
  taskDatabase = new TaskDatabaseConstructor(path.join(userData, "tasks.v3.sqlite"), { worktreesRoots: [WORKTREES_ROOT, ...legacyWorktreesRoots(userData)] });
  const { AutomationScheduler: AutomationSchedulerConstructor } = await import("./automation/automation-scheduler.mjs");
  automationScheduler = new AutomationSchedulerConstructor(taskDatabase, runs.dispatchAutomation, {
    onChange: (automations) => {
      if (window && !window.isDestroyed()) window.webContents.send("automation:changed", automations);
    },
  });
  automationScheduler.start();
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    const name = attachmentName(decodeURIComponent(new URL(request.url).pathname));
    if (!/^[A-Za-z0-9-]+\.png$/.test(name)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(path.join(attachmentsDirectory(), name)).toString());
  });
  if (!app.isPackaged) app.dock?.setIcon(icon);
  keyboard.claimDesktopShortcut();
  await searchPath;
  installAppMenu({
    onCheckForUpdates: () => sendMenuCommand("app.check-for-updates"),
    onOpenSourceLicenses: () => sendMenuCommand("app.open-source-licenses"),
  });
  await createWindow();
  void startMobileBridge({ window: () => window, userData, staticRoot: path.join(__dirname, "../../mobile") })
    .catch((error) => console.error("Could not start the phone bridge:", error));
  const launchPath = projectPathFromArgv(process.argv);
  if (launchPath) openProjectPath(launchPath);
  void checkForUpdates(updateHost).catch((error) => console.error("Update check failed:", error));
  app.on("activate", () => {
    if (queueReopen()) return;
    /** A window a paired phone kept alive was hidden rather than destroyed, so it is shown again. */
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    else revealWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * How long the quit Electron runs is given before the process leaves anyway. A quit that arrived as
 * a signal rather than from the menu never reaches `will-quit` on its own, so the app would sit
 * there with no window; everything worth keeping is already on disk by the time this starts.
 */
const QUIT_GRACE = 500;

app.on("before-quit", (event) => {
  if (quitState === "ready") {
    runs.killAgent();
    return;
  }
  event.preventDefault();
  if (quitState === "stopping") return;
  quitState = "stopping";
  automationScheduler?.stop();
  runs.clearPendingStarts();
  runs.killAgent();
  void stopMobileBridge().catch((error) => console.error("Could not stop the phone bridge:", error));
  if (window && !window.isDestroyed()) window.hide();
  void stopComputerUse()
    .catch((error) => console.error("Could not stop computer use:", error))
    .finally(() => {
      quitState = "ready";
      taskDatabase?.close();
      if (restartRequested) scheduleRestart(reopenArgs?.length ? reopenArgs : undefined);
      app.quit();
      setTimeout(() => app.exit(0), QUIT_GRACE).unref();
    });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  automationScheduler?.stop();
  taskDatabase?.close();
});

ipcMain.handle("workspace:open", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const result = await dialog.showOpenDialog(window!, {
    properties: ["openDirectory", "createDirectory"],
    title: "Open a project folder",
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const registration = await getWorkspaceService().registerProject(result.filePaths[0]);
  return registration.workspace;
});

/**
 * A folder the user typed rather than picked. Everything the picker guarantees has to be checked
 * here instead: that it is a directory, and that it is theirs rather than a checkout the app made.
 */
ipcMain.handle("workspace:register", async (event, root: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const { projectFolder } = await import("./project-folder.mjs");
  const folder = await projectFolder(root, [WORKTREES_ROOT, ...legacyWorktreesRoots(app.getPath("userData"))]);
  return (await getWorkspaceService().registerProject(folder)).workspace;
});

ipcMain.handle("workspace:projectless", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return (await getWorkspaceService().getProjectless()).workspace;
});

/** The window says when it can take a folder, so one the CLI named before it was up is not lost. */
ipcMain.on("workspace:open-project-ready", (event) => {
  if (!trustedSender(event)) return;
  rendererListening = true;
  void flushProjectOpens();
  flushMenuCommands();
});

ipcMain.handle("cli:status", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return cliStatus();
});

ipcMain.handle("cli:install", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return installCli();
});

ipcMain.handle("cli:uninstall", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return uninstallCli();
});

ipcMain.handle("workspace:commands", async (event, workspaceId: unknown, engine: unknown) => {
  if (!trustedSender(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
  if (!isAgentEngine(engine)) return { status: "error", message: "Invalid engine." } as const;
  try {
    return { status: "available", commands: await readCommands(workspaceId, engine) } as const;
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }
});

ipcMain.handle("task-title:suggest", async (event, text: unknown, attachments: unknown, engine: unknown) => {
  if (!trustedSender(event)) return null;
  if (typeof text !== "string" || !isAgentEngine(engine)) return null;
  const images = (Array.isArray(attachments) ? attachments : [])
    .map((item) => typeof item === "string" ? savedAttachmentPath(item) : null)
    .filter((file): file is string => file !== null);
  if (!text.trim() && images.length === 0) return null;
  try {
    const { engineServices } = await import("./agent/engine-services.mjs");
    return await engineServices[engine].suggestTitle(text, images);
  } catch {
    return null;
  }
});

let engineAccess: Promise<EngineAccessHost> | null = null;

/** Made on first ask, since an engine it asks is a process of its own. */
function engineAccessHost() {
  return engineAccess ??= import("./agent/engine-services.mjs").then(({ EngineAccessHost }) => new EngineAccessHost());
}

ipcMain.handle("engine:status", async (event, refresh: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return (await engineAccessHost()).read(refresh === true);
});

ipcMain.handle("engine:sign-in", async (event, engine: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!isAgentEngine(engine)) throw new Error("Invalid engine.");
  return (await engineAccessHost()).signIn(engine, (url) => shell.openExternal(url));
});

ipcMain.handle("computer-use:permissions", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return computerUsePermissions();
});

ipcMain.handle("computer-use:enable", async (event, permission: ComputerUsePermission) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (permission !== "accessibility" && permission !== "screenRecording") throw new Error("Invalid computer-use permission.");
  return requestComputerUsePermission(permission);
});

ipcMain.handle("usage:plan", async (event, engine: unknown) => {
  if (!trustedSender(event)) return { status: "unavailable", message: "Untrusted IPC sender." } as const;
  if (!isAgentEngine(engine)) return { status: "unavailable", message: "Invalid engine." } as const;
  try {
    const { engineServices } = await import("./agent/engine-services.mjs");
    return await engineServices[engine].planUsage();
  } catch (cause) {
    return { status: "unavailable", message: cause instanceof Error ? cause.message : String(cause) } as const;
  }
});

ipcMain.on("updates:check", (event) => {
  if (!trustedSender(event)) return;
  void checkForUpdates(updateHost, { userRequested: true }).catch((error) => console.error("Update check failed:", error));
});

ipcMain.handle("licenses:open", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const notices = app.isPackaged
    ? path.join(process.resourcesPath, "legal", "THIRD-PARTY-NOTICES.txt")
    : path.join(app.getAppPath(), "assets", "legal", "THIRD-PARTY-NOTICES.txt");
  const failure = await shell.openPath(notices);
  if (failure) throw new Error(failure);
});

ipcMain.on("computer-use:restart", (event) => {
  if (!trustedSender(event)) return;
  requestRestart();
  app.quit();
});

ipcMain.handle("task-store:load", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!taskDatabase) throw new Error("Task database is not ready.");
  return taskDatabase.load();
});

ipcMain.handle("task-store:persist", (event, delta) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!taskDatabase) throw new Error("Task database is not ready.");
  taskDatabase.persist(delta);
});

ipcMain.handle("subagent-activity:load", (event, taskId: string, subagentId: string) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!taskDatabase) throw new Error("Task database is not ready.");
  return taskDatabase.subagentActivity(taskId, subagentId);
});

ipcMain.on("run:command", runs.handleRunCommand);

ipcMain.handle("automation:list", (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return getAutomationScheduler().list();
});

ipcMain.handle("automation:save", (event, draft: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!isAutomationDraft(draft)) throw new Error("Invalid automation.");
  return getAutomationScheduler().save(draft);
});

ipcMain.handle("automation:update", (event, taskId: unknown, patch: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (typeof taskId !== "string" || !taskId || taskId.length > 256 || !isAutomationPatch(patch)) throw new Error("Invalid automation change.");
  return getAutomationScheduler().update(taskId, patch);
});

ipcMain.handle("automation:delete", (event, taskId: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (typeof taskId !== "string" || !taskId || taskId.length > 256) throw new Error("Invalid task ID.");
  return getAutomationScheduler().remove(taskId);
});

ipcMain.handle("automation:run-now", (event, taskId: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (typeof taskId !== "string" || !taskId || taskId.length > 256) throw new Error("Invalid task ID.");
  return getAutomationScheduler().runNow(taskId);
});

ipcMain.on("automation:ack", (event, ack: unknown) => {
  if (!trustedSender(event) || !isAutomationAck(ack)) return;
  runs.acknowledgeAutomation(ack.runId, ack.started);
});

ipcMain.on("theme:set", (event, theme: unknown) => {
  if (!trustedSender(event) || !isWindowTheme(theme)) return;
  if (theme.variant === windowTheme.variant && theme.canvas === windowTheme.canvas && Boolean(theme.follow) === Boolean(windowTheme.follow)) return;
  applyWindowTheme(theme);
  rememberWindowTheme(theme);
});

ipcMain.on("shortcuts:set", (event, overrides: unknown) => {
  if (!trustedSender(event) || !isShortcutOverrides(overrides)) return;
  keyboard.setShortcuts(overrides);
  keyboard.claimDesktopShortcut();
});

ipcMain.on("capture:set-options", (event, options: unknown) => {
  if (!trustedSender(event) || !isCaptureOptions(options)) return;
  keyboard.setCaptureOptions(options);
});

ipcMain.on("shortcuts:capture", (event, capturing: unknown) => {
  if (!trustedSender(event) || typeof capturing !== "boolean") return;
  keyboard.setCapturing(capturing);
  /** A keystroke the desktop is holding never reaches the window, so settings cannot read it back. */
  if (capturing) keyboard.releaseDesktopShortcut();
  else keyboard.claimDesktopShortcut();
});

ipcMain.on("window:close", (event) => {
  if (!trustedSender(event)) return;
  window?.close();
});

/** A page in the panel holds the keyboard until the window asks for it back. */
ipcMain.on("window:focus", (event) => {
  if (!trustedSender(event) || !window || window.isDestroyed()) return;
  window.webContents.focus();
});

/** Where a thread's notice goes when the window is not the place the user is looking. */
const noticeHost: NoticeHost = { window: () => window, reveal: revealWindow };
serveThreadNotices(noticeHost, trustedSender);
serveBadgeCount(trustedSender);
serveExternalApps(trustedSender);
serveMobileBridge(trustedSender);

ipcMain.on("thread:answer", (event, response: unknown) => {
  if (!trustedSender(event) || !isThreadResponse(response)) return;
  runs.answerThread(response);
});

registerBrowserIpc(trustedSender);

/** Bigger than any file anyone reads, and still small enough that no editor chokes on the argument. */
const MAX_FILE_LINE = 10_000_000;

ipcMain.handle("file:open", async (event, roots: unknown, candidate: unknown, line: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (line !== null && line !== undefined && (typeof line !== "number" || !Number.isInteger(line) || line < 1 || line > MAX_FILE_LINE)) {
    throw new Error("Invalid file line.");
  }
  const { openableFile } = await import("./path-policy.mjs");
  await openInEditor(await openableFile(roots, candidate), typeof line === "number" ? line : null);
});

registerTerminalIpc(trustedSender);

/** Hands back an image this app wrote, for a composer that has to draw on it rather than show it. */
ipcMain.handle("attachment:read", async (event, file: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const saved = typeof file === "string" ? savedAttachmentPath(file) : null;
  if (!saved) throw new Error("That image is not one this app is keeping.");
  return (await readFile(saved)).toString("base64");
});

/** How many paths one drop may name, and how long each may be. */
const MAX_DESCRIBED_FILES = 20;
const MAX_DESCRIBED_PATH = 4_096;

/** What the window dropped: the name to show, and whether the path is a folder. */
ipcMain.handle("file:describe", async (event, paths: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!Array.isArray(paths)) return [];
  const named = paths
    .filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_DESCRIBED_PATH)
    .slice(0, MAX_DESCRIBED_FILES);
  const described = await Promise.all(named.map(async (candidate) => {
    const entry = await stat(candidate).catch(() => null);
    if (!entry || (!entry.isFile() && !entry.isDirectory())) return null;
    const resolved = path.resolve(candidate);
    return { path: resolved, name: path.basename(resolved), ...(entry.isDirectory() ? { folder: true as const } : {}) };
  }));
  return described.filter((item) => item !== null);
});

ipcMain.handle("attachment:save", async (event, data: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (typeof data !== "string") throw new Error("Attachment is empty or too large.");
  const file = await writeAttachment(data);
  return file;
});

registerWorkspaceIpc({ workspaces: getWorkspaceService, worktrees: getWorktreeService }, trustedSender);
