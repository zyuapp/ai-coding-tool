/** First, so every module after it is compiled through the cache. */
import { persistCompileCache } from "./compile-cache.js";
import { app, BrowserWindow, dialog, globalShortcut, nativeTheme, powerMonitor, powerSaveBlocker, session, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useMessageImageStore } from "./message-image-store.js";
import { handleImageProtocols, registerAppSchemes } from "./image-protocols.js";
import { guardVisualFrames, handleVisualProtocol } from "./visual-frame-host.js";
import { isVisualFrameUrl } from "../domain/visual-frame.js";
import { isWindowTheme, type BrowserPageEvent, type WindowTheme } from "../contracts/ipc.js";
import { CLI_URL_SCHEME, projectPathFromArgv, projectPathFromUrl } from "../domain/cli.js";
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { TaskDatabaseService } from "./task-database-service.mjs" with { "resolution-mode": "import" };
import type { EngineAccessHost } from "./agent/engine-services.mjs" with { "resolution-mode": "import" };
import { attachmentsDirectory, useAttachmentsDirectory } from "./attachment-store.js";
import { messageThumbnail } from "./message-thumbnails.js";
import { refreshCli } from "./cli-install.js";
import { computerUseForRun, resumeComputerUse, stopComputerUse } from "./computer-use-host.js";
import type { NoticeHost } from "./desktop-notice.js";
import { createDesktopEvents } from "./desktop-events.js";
import { createComputerBridge } from "./computer-bridge.js";
import { createComputerReads } from "./computer-queries.js";
import type { ComputerLinks } from "./computers/computer-links.mjs" with { "resolution-mode": "import" };
import { hostname } from "node:os";
import { createJsonStorage, WINDOW_STORAGE_FILE } from "./json-storage.js";
import { createRuntimeDesktop } from "./runtime-desktop.js";
import { attachmentNames, ORPHAN_ATTACHMENT_MIN_AGE_MS, retireLegacyCodexHome, sweepOrphanAttachments } from "./user-data-sweep.js";
import { startKeyboardHost } from "./keyboard-host.js";
import { installAppMenu, setUpdateChecking } from "./app-menu.js";
import { registerAppImageProtocol } from "./linux-protocol.js";
import { adoptLoginShellPath } from "./login-path.js";
import { startLockAwake, type LockAwake } from "./lock-awake.js";
import { createWorkspaceRuntimeHost } from "./workspace-runtime-host.js";
import { startRunHost } from "./run-host.js";
import { forkAgentProcess } from "./agent-process.js";
import { appPluginPath } from "./app-plugin-path.js";
import { servingProcess } from "./instance-lock.js";
import { startUpdateChecks, type UpdateHost } from "./updates.js";
import { appProfile } from "./user-data.js";
import { readAppLaunch } from "./app-launch.js";
import { rememberedPlacement, watchWindowPlacement } from "./window-placement.js";
import { windowFrameOptions } from "./platform-capabilities.js";
import { serveWindowDesktop } from "./window-desktop.js";
import { recheckMobileBridge, startMobileBridge, stopMobileBridge } from "./mobile/bridge.js";
import * as browser from "./browser-host.js";
import * as terminal from "./terminal-host.js";

const profile = appProfile(app.getPath("appData"), homedir(), app.isPackaged);
app.setName(profile.name);
/** Select and create the profile before Chromium's session and single-instance lock use it. */
mkdirSync(profile.userData, { recursive: true });
app.setPath("userData", profile.userData);
app.setPath("sessionData", profile.userData);
/** The browser panel's page cache otherwise grows with the free disk, well past a gigabyte. */
app.commandLine.appendSwitch("disk-cache-size", String(256 * 1024 * 1024));
useAttachmentsDirectory(app.getPath("userData"));
useMessageImageStore({ directory: path.join(app.getPath("userData"), "message-images"), thumbnail: messageThumbnail });

registerAppSchemes();

/** The `aic` command opens a folder in the app that is already running, never a second one. */
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  console.log(`${profile.name} is already running. Bringing that window forward instead of starting a second one.`);
  app.exit(0);
}
/** `aic serve` on this data would write over what the window writes, so one of them yields. */
const serving = singleInstance ? servingProcess(app.getPath("userData")) : null;
if (serving !== null) {
  dialog.showErrorBox(`${profile.name} is already serving`, `\`aic serve\` is running from this data folder (process ${serving}). Stop it before opening the app.`);
  app.exit(1);
}
/**
 * Read before the window storage is first written, which is what tells an old profile from a new one.
 * A launch that is about to exit leaves the record for the one that opens the window.
 */
const launchedUpdate = singleInstance && serving === null ? readAppLaunch(profile.userData, app.getVersion()) : null;
/** Only the installed app claims the scheme; a run from source would hand it to the bare Electron binary. */
if (app.isPackaged) app.setAsDefaultProtocolClient(CLI_URL_SCHEME);

const icon = path.join(app.getAppPath(), "assets", "icon.png");
let window: BrowserWindow | null = null;
let workspaceService: WorkspaceService | null = null;
let worktreeService: WorktreeService | null = null;
let taskDatabase: TaskDatabaseService | null = null;
let automationScheduler: AutomationScheduler | null = null;
let lockAwake: LockAwake | null = null;
let quitState: "running" | "stopping" | "ready" = "running";
let restartRequested = false;
let restartIssued = false;
let updateRestartScheduled = false;
let reopenArgs: string[] | null = null;
/** Folders the `aic` command named, held until the window is up and listening for them. */
const pendingProjectOpens: string[] = [];
let runtimeListening = false;
let markServicesReady!: () => void;
/** The window opens beside startup; what it asks of the services before they are up waits for this. */
const servicesReady = new Promise<void>((resolve) => { markServicesReady = resolve; });

function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

/** Everything main pushes at the runtime, raised in this process rather than sent to a window. */
const events = createDesktopEvents();

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
  publish: (event) => { events.emit("run:event", event); },
  fire: (fire) => events.emit("automation:fire", fire),
  ask: (request) => events.emit("thread:request", request),
  running: () => quitState === "running",
  workspaces: getWorkspaceService,
  scheduler: getAutomationScheduler,
  computerUseForRun,
  agent: forkAgentProcess,
});

const keyboard = startKeyboardHost({ window: () => window, reveal: revealWindow });

/** Where a thread's notice goes when the window is not the place the user is looking. */
const noticeHost: NoticeHost = { window: () => window, reveal: revealWindow };

const updateHost: UpdateHost = {
  window: () => window,
  onInstall: () => { updateRestartScheduled = true; },
  onChecking: setUpdateChecking,
  onState: (update) => { events.emit("update:changed", update); },
};

let engineAccess: Promise<EngineAccessHost> | null = null;

/** Made on first ask, since an engine it asks is a process of its own. */
function engineAccessHost() {
  return engineAccess ??= import("./agent/engine-services.mjs").then(({ EngineAccessHost }) => new EngineAccessHost());
}

/** What this computer calls itself until the user picks a name: the machine's own. */
const machineName = () => hostname().replace(/\.local$/, "");

let computerLinks: ComputerLinks | null = null;

function getComputerLinks() {
  if (!computerLinks) throw new Error("Computers are not ready.");
  return computerLinks;
}

const computerReads = createComputerReads({
  threads: (query) => workspaceRuntime.runtime.queryThreads(query),
  workspaces: getWorkspaceService,
  state: () => workspaceRuntime.runtime.getState(),
  links: () => computerLinks,
});

const runtimeDesktop = createRuntimeDesktop({
  window: () => window,
  launchedUpdate,
  notices: noticeHost,
  updates: updateHost,
  events,
  reads: computerReads,
  keyboard,
  runs,
  workspaces: getWorkspaceService,
  worktrees: getWorktreeService,
  taskDatabase: () => {
    if (!taskDatabase) throw new Error("Task database is not ready.");
    return taskDatabase;
  },
  scheduler: getAutomationScheduler,
  engineAccess: engineAccessHost,
  worktreesRoots: () => [WORKTREES_ROOT, ...legacyWorktreesRoots(app.getPath("userData"))],
  restart: () => requestRestart(),
  /** The window can ask before the links are made, so it waits for them rather than failing. */
  computers: async () => {
    await servicesReady;
    return getComputerLinks();
  },
});

const workspaceRuntime = createWorkspaceRuntimeHost({
  view: () => window,
  trusted: trustedSender,
  storage: createJsonStorage(path.join(app.getPath("userData"), WINDOW_STORAGE_FILE)),
  desktop: runtimeDesktop,
});

const workspaceHooks = createComputerBridge({
  publisher: workspaceRuntime.publisher,
  reads: computerReads,
  name: () => computerLinks?.name() ?? machineName(),
});

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
 * The browser panel runs in its own partition, which grants pages far less. A visual's frame is an
 * agent's markup rather than the app's, so it is granted nothing.
 */
function grantAppWindowPermissions() {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback, details) => callback(!isVisualFrameUrl(details.requestingUrl)));
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

/** Registers each folder the CLI named and hands it to the workspace runtime. */
async function flushProjectOpens() {
  if (!runtimeListening || !workspaceService || !pendingProjectOpens.length) return;
  while (pendingProjectOpens.length) {
    const root = pendingProjectOpens.shift()!;
    try {
      const registration = await getWorkspaceService().registerProject(root);
      events.emit("workspace:open-project", registration.workspace);
    } catch (error) {
      console.error("Could not open the folder the aic command named:", error);
    }
  }
  revealWindow();
}

/** Menu actions use the same runtime as buttons; a closed window is reopened to show their result. */
function sendMenuCommand(type: "app.check-for-updates" | "app.open-source-licenses") {
  void (async () => {
    if (!window || window.isDestroyed()) await createWindow();
    revealWindow();
    const result = await workspaceRuntime.dispatch({ type });
    if (!result.ok) throw new Error(result.message);
  })().catch((error) => console.error("App menu command failed:", error));
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

/** A link the window follows outward, which only ever names a web page. */
function webPageUrl(value: string) {
  if (value.length > 8_192) throw new Error("Invalid page URL.");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only web pages open outside the app.");
  return value;
}

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
      /** Hidden terminal views still consume output while their dock is closed. */
      backgroundThrottling: false,
    },
  });
  if (process.platform === "linux") {
    /** Keep native accelerators, but never reveal a menu strip (including on Alt). */
    window.setAutoHideMenuBar(false);
    window.setMenuBarVisibility(false);
  }
  browser.startBrowserHost(window, {
    onPage: (event: BrowserPageEvent) => { events.emit("browser:event", event); },
    onFind: (tabId, results) => { events.emit("browser:find", { tabId, ...results }); },
    onKey: (input) => keyboard.handleKey(input, "browser"),
  });
  terminal.startTerminalHost({
    onData: (event) => {
      if (window && !window.isDestroyed()) window.webContents.send("terminal:data", event);
    },
    onUpdate: (update) => { events.emit("terminal:event", update); },
  });
  /** The window owns no menu shortcut the app wants back; preventing it here is what frees ⌘W. */
  window.webContents.on("before-input-event", (event, input) => {
    if (keyboard.handleKey(input, "any")) event.preventDefault();
  });
  guardVisualFrames(window.webContents);
  /** A normal link leaves AI Coding Tool. Its context menu offers the browser panel separately. */
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(webPageUrl(url)).catch((error) => console.error("Could not open link:", error));
    } catch {
      // Chromium asked to open something other than a web page.
    }
    return { action: "deny" };
  });
  if (placement.maximized && !placement.fullScreen) window.maximize();
  watchWindowPlacement(window);
  window.on("closed", () => {
    browser.stopBrowserHost();
    terminal.stopTerminalHost();
    if (quitState === "running") {
      void workspaceRuntime.dispatch({ type: "view.closed" })
        .catch((error) => console.error("Could not release closed window panels:", error));
    }
  });
  await window.loadFile(path.join(__dirname, "../../renderer/index.html"));
}

/**
 * Phones and computers are answered by the runtime in this process, not by the window, so the bridge
 * runs from launch to quit: closing the window on a Mac leaves this computer reachable.
 */
function startPhoneBridge() {
  return startMobileBridge({ events, workspace: workspaceHooks, userData: app.getPath("userData"), staticRoot: path.join(__dirname, "../../mobile"), ...(!app.isPackaged ? { developmentRoot: app.getAppPath() } : {}) })
    .catch((error) => console.error("Could not start the phone bridge:", error));
}

/**
 * Worktrees live outside app data: the path has no space in it for a project's own tooling to trip
 * over, no retired brand for the user to read in `git worktree list`, and multi-gigabyte checkouts
 * stay out of the backups app data is swept into.
 */
const WORKTREES_ROOT = profile.worktreesRoot;

/** Where the app kept worktrees before, still its own: listed and manually removable, never created in. */
/** Housekeeping the window never waits for: retired data goes to the Trash, unused attachments go. */
async function sweepUserData(userData: string, database: TaskDatabaseService) {
  if (await retireLegacyCodexHome(userData, (target) => shell.trashItem(target))) console.log("Moved the retired Codex home to the Trash.");
  const referenced = attachmentNames(await database.attachmentPaths());
  const swept = await sweepOrphanAttachments(attachmentsDirectory(), referenced, { now: Date.now(), minAgeMs: ORPHAN_ATTACHMENT_MIN_AGE_MS });
  if (swept.files) console.log(`Removed ${swept.files} unused attachment file(s), ${Math.round(swept.bytes / 1024 / 1024)} MB.`);
}

function legacyWorktreesRoots(userData: string) {
  return [path.join(userData, "worktrees")].filter((root) => root !== WORKTREES_ROOT);
}

const startup = app.whenReady().then(async () => {
  if (!singleInstance) return;
  // Development Electron has no packaged app to serve and must not replace the installed launcher.
  if (app.isPackaged) {
    void refreshCli().catch((error) => console.error("Could not refresh the aic command:", error));
  }
  if (process.platform === "darwin") lockAwake = startLockAwake(powerMonitor, powerSaveBlocker);
  /** Started before the app spawns anything, and awaited before the first thing that needs it. */
  const searchPath = adoptLoginShellPath();
  const userData = app.getPath("userData");
  const { PRIVATE_CODEX_HOME_ENV } = await import("./codex/codex-home.mjs");
  process.env[PRIVATE_CODEX_HOME_ENV] = path.join(userData, "codex-private");
  const { setAppPluginRoot } = await import("./app-plugin.mjs");
  setAppPluginRoot(appPluginPath(app.isPackaged, process.resourcesPath, app.getAppPath()));
  if (process.platform === "linux" && app.isPackaged && process.env.APPIMAGE) {
    void registerAppImageProtocol({ appImage: process.env.APPIMAGE, home: homedir(), iconSource: icon, dataHome: process.env.XDG_DATA_HOME })
      .catch((error) => console.error("Could not register the AppImage URL handler:", error));
  }
  grantAppWindowPermissions();
  applyWindowTheme(loadWindowTheme());
  handleImageProtocols(computerReads);
  handleVisualProtocol();
  const windowCreated = createWindow().catch((error) => console.error("Could not open the window:", error));
  const { WorkspaceService: WorkspaceServiceConstructor } = await import("./workspace/workspace-service.mjs");
  workspaceService = new WorkspaceServiceConstructor({
    registryPath: path.join(userData, "workspaces.v1.json"),
    projectlessRoot: path.join(userData, "projectless"),
  });
  const { WorktreeService: WorktreeServiceConstructor } = await import("./workspace/worktrees.mjs");
  worktreeService = new WorktreeServiceConstructor({ worktreesRoot: WORKTREES_ROOT, legacyRoots: legacyWorktreesRoots(userData), workspaces: workspaceService });
  const { TaskDatabaseService } = await import("./task-database-service.mjs");
  taskDatabase = await TaskDatabaseService.open(path.join(userData, "tasks.v3.sqlite"), {
    worktreesRoots: [WORKTREES_ROOT, ...legacyWorktreesRoots(userData)],
    workerURL: pathToFileURL(path.join(__dirname, "task-database-worker.mjs")),
  });
  const { AutomationScheduler: AutomationSchedulerConstructor } = await import("./automation/automation-scheduler.mjs");
  automationScheduler = new AutomationSchedulerConstructor(taskDatabase, runs.dispatchAutomation, {
    onChange: (automations) => { events.emit("automation:changed", automations); },
  });
  await automationScheduler.start();
  if (!app.isPackaged) app.dock?.setIcon(icon);
  keyboard.claimDesktopShortcut();
  await searchPath;
  await workspaceRuntime.start();
  runtimeListening = true;
  void flushProjectOpens();
  const { createComputerLinks } = await import("./computers/computer-links.mjs");
  computerLinks = createComputerLinks({
    file: path.join(userData, "computers.v1.json"),
    deviceName: machineName(),
    onChanged: (links) => { events.emit("computers:changed", { name: getComputerLinks().name(), links }); },
    onState: (id, state) => { events.emit("computer:state", { id, state }); },
    onNotice: (id, notice) => { events.emit("computer:notice", { id, notice }); },
  });
  computerLinks.start();
  /** A machine that slept has lines that only look open, and computers that came back while it was away. */
  powerMonitor.on("resume", () => computerLinks?.reconnect());
  markServicesReady();
  void startPhoneBridge();
  /** Tailscale may have been reset or handed to another copy of the app while the machine slept. */
  powerMonitor.on("resume", recheckMobileBridge);
  installAppMenu({
    onCheckForUpdates: () => sendMenuCommand("app.check-for-updates"),
    onOpenSourceLicenses: () => sendMenuCommand("app.open-source-licenses"),
  });
  await windowCreated;
  persistCompileCache();
  const launchPath = projectPathFromArgv(process.argv);
  if (launchPath) openProjectPath(launchPath);
  startUpdateChecks(updateHost);
  void sweepUserData(userData, taskDatabase).catch((error) => console.error("Could not sweep unused app data:", error));
  app.on("activate", () => {
    if (queueReopen()) return;
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    else revealWindow();
  });
});

/** The window is already up by the time a later step can fail, so the failure is shown and the app quits rather than leaving it hung. */
startup.catch((error: unknown) => {
  console.error("Could not start:", error);
  dialog.showErrorBox("Could not start", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/**
 * How long the quit Electron runs is given before the process leaves anyway. A quit that arrived as
 * a signal rather than from the menu never reaches `will-quit` on its own, so the app would sit
 * there with no window. Persistence is drained before this final exit is scheduled.
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
  if (window && !window.isDestroyed()) window.hide();
  void finishShutdown();
});

async function finishShutdown() {
  let servicesStopped = false;
  /** A quit during startup lets it finish rather than racing the store's open and the runtime's start. */
  await startup.catch(() => undefined);
  try {
    await workspaceRuntime.flush();
    servicesStopped = true;
    lockAwake?.stop();
    lockAwake = null;
    automationScheduler?.stop();
    runs.clearPendingStarts();
    runs.killAgent();
    computerLinks?.stop();
    await stopMobileBridge().catch((error) => console.error("Could not stop the phone bridge:", error));
    await stopComputerUse().catch((error) => console.error("Could not stop computer use:", error));
    await workspaceRuntime.flush();
    await themeWritten;
    await automationScheduler?.flush();
    await taskDatabase?.close();
    quitState = "ready";
    workspaceRuntime.close();
    if (restartRequested) scheduleRestart(reopenArgs?.length ? reopenArgs : undefined);
    app.quit();
    setTimeout(() => app.exit(0), QUIT_GRACE).unref();
  } catch (error) {
    quitState = "running";
    if (servicesStopped) {
      computerLinks?.start();
      resumeComputerUse();
      if (process.platform === "darwin") lockAwake = startLockAwake(powerMonitor, powerSaveBlocker);
      await automationScheduler?.start().catch((failure) => console.error("Could not restart schedules:", failure));
      await startPhoneBridge();
    }
    revealWindow();
    dialog.showErrorBox("Could not save the workspace", error instanceof Error ? error.message : String(error));
  }
}

app.on("will-quit", () => {
  lockAwake?.stop();
  lockAwake = null;
  globalShortcut.unregisterAll();
  automationScheduler?.stop();
  void taskDatabase?.close().catch((error) => console.error("Could not close task storage:", error));
  workspaceRuntime.close();
});

/** The frame follows the window's theme, and remembers it for the next launch's first paint. */
function setWindowTheme(theme: WindowTheme) {
  if (theme.variant === windowTheme.variant && theme.canvas === windowTheme.canvas && Boolean(theme.follow) === Boolean(windowTheme.follow)) return;
  applyWindowTheme(theme);
  rememberWindowTheme(theme);
}

serveWindowDesktop({ desktop: runtimeDesktop, reads: computerReads, setTheme: setWindowTheme, ready: servicesReady }, trustedSender);
