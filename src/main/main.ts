import { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, net, protocol, session, shell, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACHMENT_SCHEME, attachmentName } from "../application/attachments.js";
import { isAutomationAck, isAutomationRequest, isBackgroundEvent, isBrowserAction, isBrowserBounds, isRunCommand, isRunEvent, isShortcutOverrides, isThreadRequest, isThreadResponse, isWindowTheme, isWorkflowEvent, unreadableRequest, type AgentEvent, type AutomationRequest, type AutomationResponse, type BackgroundEvent, type BrowserPageEvent, type ComputerUsePermission, type CreateWorktreeRequest, type ReleaseWorktreeRequest, type RunCommand, type RunEvent, type StartRunCommand, type WindowTheme } from "../contracts/ipc.js";
import type { ThreadRequest, ThreadResponse } from "../contracts/threads.js";
import { isAutomationDraft, isAutomationPatch, type Automation, type AutomationRunStatus, type TickKind } from "../domain/automation.js";
import { DEFAULT_CAPTURE_OPTIONS, isCaptureOptions } from "../domain/capture.js";
import { CLI_URL_SCHEME, projectPathFromArgv, projectPathFromUrl } from "../domain/cli.js";
import { desktopAccelerator, formatShortcut, keystrokeOf, resolveShortcuts, shortcutFor, type ShortcutBinding, type ShortcutSurface } from "../domain/shortcuts.js";
import { terminalLineLimit } from "../domain/terminal.js";
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };
import { acceptRunEvent, automationFire, AUTOMATION_SETTLE_TIMEOUT, failedEventsForTransportLoss, settledWithin, supersedePendingStarts } from "./run-routing.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { TaskDatabase } from "./task-database.mjs" with { "resolution-mode": "import" };
import { cliStatus, installCli, uninstallCli } from "./cli-install.js";
import { computerUseForRun, computerUsePermissions, requestComputerUsePermission, stopComputerUse } from "./computer-use-host.js";
import { notify, serveThreadNotices, type NoticeHost } from "./desktop-notice.js";
import { openInEditor } from "./open-in-editor.js";
import { serveExternalApps } from "./open-in-app.js";
import { installAppMenu } from "./app-menu.js";
import { checkForUpdates, type UpdateHost } from "./updates.js";
import { adoptUserDataFolder } from "./user-data.js";
import { rememberedPlacement, watchWindowPlacement } from "./window-placement.js";
import { flashWindow } from "./capture-flash.js";
import { captureFrontmostWindow } from "./window-screenshot.js";
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
let agent: Electron.UtilityProcess | null = null;
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
let rendererListening = false;

type RunState = {
  taskId: string;
  runId: string;
  lastSequence: number;
  terminal: boolean;
};

/** A scheduled run is in flight from the moment the renderer is asked until its run reaches a terminal status. */
type AutomationDispatchState = {
  acknowledge?: (started: boolean) => void;
  settle?: (status: AutomationRunStatus) => void;
};

const AUTOMATION_ACK_TIMEOUT = 30_000;
/** Shorter than the agent's own wait, so a lost answer still comes back as a tool error. */
const THREAD_REQUEST_TIMEOUT = 8_000;
/** A wait answers when the thread it names settles, so the relay outlives the wait itself. */
const THREAD_WAIT_SLACK = 5_000;
const runStates = new Map<string, RunState>();
/** Threads the agent process last reported background work for, so its death can take that work off the panel. */
const backgroundThreads = new Set<string>();
const pendingStarts = new Map<string, StartRunCommand>();
const automationDispatches = new Map<string, AutomationDispatchState>();
const threadRequests = new Map<string, ReturnType<typeof setTimeout>>();

function runKey(taskId: string, runId: string) {
  return `${taskId}\u0000${runId}`;
}

function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

function sendToRenderer(event: AgentEvent) {
  if (window && !window.isDestroyed()) window.webContents.send("run:event", event);
}

function recordRun(command: StartRunCommand) {
  const key = runKey(command.taskId, command.runId);
  runStates.set(key, { taskId: command.taskId, runId: command.runId, lastSequence: 0, terminal: false });
  return key;
}

function publishRunEvent(event: RunEvent) {
  if (!isRunEvent(event)) return;
  const key = runKey(event.taskId, event.runId);
  let state = runStates.get(key);
  if (!state && event.type === "run.started") {
    state = { taskId: event.taskId, runId: event.runId, lastSequence: 0, terminal: false };
    runStates.set(key, state);
  }
  if (!state || event.sequence <= state.lastSequence) return;
  if (!acceptRunEvent(state, event)) return;
  sendToRenderer(event);
  if (event.type === "run.status" && (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled")) {
    automationDispatches.get(event.runId)?.settle?.(event.status);
    runStates.delete(key);
  }
}

/** Kept apart from the run gate: what the set says outlives whichever run started the work. */
function publishBackgroundEvent(event: BackgroundEvent) {
  if (event.processes.length) backgroundThreads.add(event.taskId);
  else backgroundThreads.delete(event.taskId);
  sendToRenderer(event);
}

function getAutomationScheduler() {
  if (!automationScheduler) throw new Error("Automation scheduler is not ready.");
  return automationScheduler;
}

/** Hands the tick to the renderer, which owns the transcript, then waits for that run to settle. */
async function dispatchAutomation(automation: Automation, tick: TickKind): Promise<AutomationRunStatus> {
  if (!window || window.isDestroyed()) return "skipped";
  const runId = randomUUID();
  const dispatch: AutomationDispatchState = {};
  automationDispatches.set(runId, dispatch);
  try {
    const fire = automationFire(automation, runId, tick);
    // Armed before the tick leaves main so a run that settles immediately still reports back.
    const settled = new Promise<AutomationRunStatus>((resolve) => { dispatch.settle = resolve; });
    const started = await new Promise<boolean>((resolve) => {
      dispatch.acknowledge = resolve;
      setTimeout(() => resolve(false), AUTOMATION_ACK_TIMEOUT).unref?.();
      window!.webContents.send("automation:fire", fire);
    });
    return started ? await settledWithin(settled, AUTOMATION_SETTLE_TIMEOUT) : "skipped";
  } finally {
    automationDispatches.delete(runId);
  }
}

async function handleAutomationRequest(request: AutomationRequest) {
  let response: AutomationResponse;
  try {
    const scheduler = getAutomationScheduler();
    const result = request.op === "read"
      ? scheduler.forTask(request.taskId)
      : request.op === "list"
        ? scheduler.list()
        : request.op === "save"
          ? scheduler.save({ ...request.draft, taskId: request.taskId })
          : request.op === "update"
            ? scheduler.update(request.taskId, request.patch)
            : scheduler.remove(request.taskId);
    response = { type: "automation.response", requestId: request.requestId, ok: true, result };
  } catch (error) {
    response = { type: "automation.response", requestId: request.requestId, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  agent?.postMessage(response);
}

/** The window owns workspace state, so thread requests are relayed to it rather than answered here. */
function handleThreadRequest(request: ThreadRequest) {
  if (!window || window.isDestroyed()) {
    answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: "The AI Coding Tool window is not open." });
    return;
  }
  const patience = request.op === "wait"
    ? request.timeoutMs + THREAD_WAIT_SLACK
    : request.op === "browser" && request.read.op === "snapshot"
      ? request.read.timeoutMs + THREAD_WAIT_SLACK
      : THREAD_REQUEST_TIMEOUT;
  const timer = setTimeout(() => {
    threadRequests.delete(request.requestId);
    answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: `AI Coding Tool did not answer the thread "${request.op}" request within ${patience}ms.` });
  }, patience);
  timer.unref?.();
  threadRequests.set(request.requestId, timer);
  window.webContents.send("thread:request", request);
}

/**
 * The keyboard. Matching happens here rather than in the window, because a page in the browser panel
 * swallows every keystroke it is given, and the window decides what each action means once it lands.
 */
let shortcuts: ShortcutBinding[] = resolveShortcuts({});
/** While settings wait for a keystroke, every keystroke goes to them instead of to an action. */
let capturingShortcut = false;

function sendToWindow(channel: string, payload?: unknown) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

/** Whether the app took the keystroke, which is also whether the page or the menu must not see it. */
function handleKey(input: Electron.Input, surface: ShortcutSurface): boolean {
  if (input.type !== "keyDown") return false;
  const stroke = keystrokeOf(input, process.platform === "darwin");
  if (!stroke) return false;
  if (capturingShortcut) {
    if (stroke.key === "Escape") sendToWindow("window:shortcut-captured", null);
    else if (stroke.mod || stroke.ctrl || stroke.alt) sendToWindow("window:shortcut-captured", formatShortcut(stroke));
    else return false;
    return true;
  }
  const binding = shortcutFor(shortcuts, stroke, surface);
  if (!binding) return false;
  sendToWindow("window:shortcut", { action: binding.action, surface });
  return true;
}

/** How a grab announces itself. The window owns the choice and hands it over as the user changes it. */
let captureOptions = DEFAULT_CAPTURE_OPTIONS;

async function captureWindowToComposer() {
  const shot = await captureFrontmostWindow(captureOptions.sound);
  if (shot.status === "captured") {
    try {
      const file = await writeAttachment(shot.png);
      sendToWindow("window:screenshot", { app: shot.app, title: shot.title, path: file });
      /** Only ever after the capture: neither the flash nor coming forward belongs in the shot. */
      if (captureOptions.focus) {
        flashWindow(shot.frame);
        revealWindow();
      } else notify("Screenshot attached", `${shot.app} — waiting in AI Coding Tool`);
    } catch (error) {
      notify("Could not keep the screenshot", error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (shot.status === "denied") {
    notify("AI Coding Tool needs Screen Recording", "Grant it in System Settings → Privacy & Security, then try again.");
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    return;
  }
  if (shot.status === "no-window") notify("Nothing to capture", `${shot.app} has no window on screen.`);
  else notify("Could not capture the window", shot.message);
}

/** What the desktop is currently holding for us, so an unchanged binding is never re-registered. */
let desktopBinding: string | null = null;

function releaseDesktopShortcut() {
  globalShortcut.unregisterAll();
  desktopBinding = null;
}

/**
 * Claims the capture keystroke from the whole desktop. Carbon registers it without activating us, so
 * the app the user is in keeps the keyboard and stays the app the capture describes.
 */
function claimDesktopShortcut() {
  if (process.platform !== "darwin") return;
  const wanted = shortcuts.find((binding) => binding.surface === "desktop" && binding.action === "window.capture");
  const accelerator = wanted ? desktopAccelerator(wanted.binding) : null;
  if (accelerator === desktopBinding) return;
  releaseDesktopShortcut();
  desktopBinding = accelerator;
  if (!accelerator) return;
  if (!globalShortcut.register(accelerator, () => void captureWindowToComposer())) {
    desktopBinding = null;
    sendToWindow("window:shortcut-refused", wanted!.binding);
  }
}

function answerThreadRequest(response: ThreadResponse) {
  agent?.postMessage(response);
}

function emitSyntheticTerminal(command: StartRunCommand, status: "failed" | "cancelled", message: string) {
  const key = runKey(command.taskId, command.runId);
  const state = runStates.get(key) ?? { taskId: command.taskId, runId: command.runId, lastSequence: 0, terminal: false };
  runStates.set(key, state);
  if (state.lastSequence === 0) publishRunEvent({ type: "run.started", taskId: command.taskId, runId: command.runId, sequence: 1 });
  publishRunEvent({ type: "run.status", taskId: command.taskId, runId: command.runId, sequence: state.lastSequence + 1, status, message });
}

function startAgent() {
  if (agent) return;
  agent = utilityProcess.fork(path.join(__dirname, "agent-worker.mjs"), [], {
    serviceName: "AI Coding Tool Agent",
    stdio: "pipe",
  });
  agent.on("message", (event: unknown) => {
    if (isRunEvent(event)) publishRunEvent(event);
    /** No run to gate them: a workflow, a shell and a monitor all outlive the run that started them. */
    else if (isWorkflowEvent(event)) sendToRenderer(event);
    else if (isBackgroundEvent(event)) publishBackgroundEvent(event);
    else if (isAutomationRequest(event)) void handleAutomationRequest(event);
    else if (isThreadRequest(event)) handleThreadRequest(event);
    /** A request no guard could read is answered rather than dropped: a dropped one hangs the tool call. */
    else { const refusal = unreadableRequest(event); if (refusal) agent?.postMessage(refusal); }
  });
  agent.on("exit", (code) => {
    agent = null;
    if (quitState === "running") {
      pendingStarts.clear();
      const message = `Agent process exited${code === null ? "" : ` with code ${code}`}.`;
      for (const event of failedEventsForTransportLoss(runStates.values(), message)) publishRunEvent(event);
      /** The processes died with it, and no session is left to say so. */
      for (const taskId of backgroundThreads) sendToRenderer({ type: "background.changed", taskId, processes: [] });
      backgroundThreads.clear();
    }
  });
  agent.stderr?.on("data", (chunk) => console.error(String(chunk)));
}

function getWorkspaceService() {
  if (!workspaceService) throw new Error("Workspace service is not ready.");
  return workspaceService;
}

function getWorktreeService() {
  if (!worktreeService) throw new Error("Worktree service is not ready.");
  return worktreeService;
}

async function resolveStart(command: StartRunCommand) {
  const { installPlainEnglishStyle } = await import("./agent/output-style-install.mjs");
  const [resolution, computerUse] = await Promise.all([
    getWorkspaceService().resolve(command.workspaceId),
    computerUseForRun(),
    /** The style has to be on disk before the run names it, or the CLI resolves the name to nothing. */
    installPlainEnglishStyle(command.outputStyle),
  ]);
  if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
  return {
    ...command,
    workspaceRoot: resolution.workspace.root,
    projectless: resolution.workspace.kind === "projectless",
    computerUse,
  };
}

async function readChangedFiles(workspaceId: string) {
  const { changedFiles } = await import("./workspace/git-changes.mjs");
  return changedFiles(workspaceId, getWorkspaceService());
}

async function readCommands(workspaceId: string) {
  const resolution = await getWorkspaceService().resolve(workspaceId);
  if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
  const { discoverClaudeCommands } = await import("./agent/claude-agent-provider.mjs");
  return discoverClaudeCommands(resolution.workspace.root, resolution.workspace.kind === "projectless");
}

function postCommand(command: RunCommand) {
  try {
    if (!agent) startAgent();
    if (!agent) throw new Error("Agent process is unavailable.");
    agent.postMessage(command);
  } catch (error) {
    /** A stop belongs to no run, so a failure to send it has no run to report against. */
    if (command.type === "stop-process") return;
    const state = runStates.get(runKey(command.taskId, command.runId));
    const message = error instanceof Error ? error.message : String(error);
    if (state && !state.terminal) {
      publishRunEvent({ type: "run.status", taskId: command.taskId, runId: command.runId, sequence: state.lastSequence + 1, status: "failed", message });
    }
  }
}

async function dispatchStart(command: StartRunCommand) {
  const key = recordRun(command);
  pendingStarts.set(key, command);
  try {
    const internal = await resolveStart(command);
    if (!pendingStarts.has(key)) return;
    pendingStarts.delete(key);
    startAgent();
    agent?.postMessage(internal);
  } catch (error) {
    pendingStarts.delete(key);
    emitSyntheticTerminal(command, "failed", error instanceof Error ? error.message : String(error));
  }
}

function handleRunCommand(event: IpcMainEvent, payload: unknown) {
  if (quitState !== "running" || !trustedSender(event) || !isRunCommand(payload)) return;
  if (payload.type === "start") {
    if (runStates.has(runKey(payload.taskId, payload.runId))) return;
    for (const [oldKey, oldCommand] of supersedePendingStarts(pendingStarts, runKey(payload.taskId, payload.runId), (command) => command.taskId === payload.taskId)) {
      if (runStates.get(oldKey)?.terminal) continue;
      emitSyntheticTerminal(oldCommand, "cancelled", "The run was superseded before it started.");
    }
    void dispatchStart(payload);
    return;
  }
  /** A stop names the thread's session, which outlives its runs, so no run has to be live to send it. */
  if (payload.type === "stop-process") return postCommand(payload);
  const key = runKey(payload.taskId, payload.runId);
  const pending = pendingStarts.get(key);
  if (pending && payload.type === "cancel") {
    pendingStarts.delete(key);
    emitSyntheticTerminal(pending, "cancelled", "The run was cancelled before it started.");
    return;
  }
  const state = runStates.get(key);
  if (!state || state.terminal) return;
  postCommand(payload);
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
    minWidth: 820,
    minHeight: 620,
    fullscreen: placement.fullScreen,
    titleBarStyle: "hiddenInset",
    backgroundColor: windowTheme.canvas,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browser.startBrowserHost(window, {
    onPage: (event: BrowserPageEvent) => {
      if (window && !window.isDestroyed()) window.webContents.send("browser:event", event);
    },
    onFind: (tabId, results) => {
      if (window && !window.isDestroyed()) window.webContents.send("browser:find", { tabId, ...results });
    },
    onKey: (input) => handleKey(input, "browser"),
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
    if (handleKey(input, "any")) event.preventDefault();
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
  window.on("closed", () => {
    rendererListening = false;
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
  const userData = app.getPath("userData");
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
  automationScheduler = new AutomationSchedulerConstructor(taskDatabase, dispatchAutomation, {
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
  claimDesktopShortcut();
  installAppMenu(() => void checkForUpdates(updateHost, { userRequested: true }).catch((error) => console.error("Update check failed:", error)));
  await createWindow();
  const launchPath = projectPathFromArgv(process.argv);
  if (launchPath) openProjectPath(launchPath);
  void checkForUpdates(updateHost).catch((error) => console.error("Update check failed:", error));
  app.on("activate", () => {
    if (queueReopen()) return;
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
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
    agent?.kill();
    return;
  }
  event.preventDefault();
  if (quitState === "stopping") return;
  quitState = "stopping";
  automationScheduler?.stop();
  pendingStarts.clear();
  agent?.kill();
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

ipcMain.handle("workspace:commands", async (event, workspaceId: unknown) => {
  if (!trustedSender(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
  try {
    return { status: "available", commands: await readCommands(workspaceId) } as const;
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }
});

ipcMain.handle("task-title:suggest", async (event, text: unknown, attachments: unknown) => {
  if (!trustedSender(event)) return null;
  if (typeof text !== "string") return null;
  const images = (Array.isArray(attachments) ? attachments : [])
    .map((item) => typeof item === "string" ? savedAttachmentPath(item) : null)
    .filter((file): file is string => file !== null);
  if (!text.trim() && images.length === 0) return null;
  try {
    const { suggestTaskTitle } = await import("./agent/title-writer.mjs");
    return await suggestTaskTitle(text, images);
  } catch {
    return null;
  }
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

ipcMain.handle("usage:plan", async (event) => {
  if (!trustedSender(event)) return { status: "unavailable", message: "Untrusted IPC sender." } as const;
  try {
    const { readPlanUsage } = await import("./agent/plan-usage.mjs");
    return await readPlanUsage();
  } catch (error) {
    return { status: "unavailable", message: error instanceof Error ? error.message : String(error) } as const;
  }
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

ipcMain.on("run:command", handleRunCommand);

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
  automationDispatches.get(ack.runId)?.acknowledge?.(ack.started);
});

ipcMain.on("theme:set", (event, theme: unknown) => {
  if (!trustedSender(event) || !isWindowTheme(theme)) return;
  if (theme.variant === windowTheme.variant && theme.canvas === windowTheme.canvas && Boolean(theme.follow) === Boolean(windowTheme.follow)) return;
  applyWindowTheme(theme);
  rememberWindowTheme(theme);
});

ipcMain.on("shortcuts:set", (event, overrides: unknown) => {
  if (!trustedSender(event) || !isShortcutOverrides(overrides)) return;
  shortcuts = resolveShortcuts(overrides);
  claimDesktopShortcut();
});

ipcMain.on("capture:set-options", (event, options: unknown) => {
  if (!trustedSender(event) || !isCaptureOptions(options)) return;
  captureOptions = options;
});

ipcMain.on("shortcuts:capture", (event, capturing: unknown) => {
  if (!trustedSender(event) || typeof capturing !== "boolean") return;
  capturingShortcut = capturing;
  /** A keystroke the desktop is holding never reaches the window, so settings cannot read it back. */
  if (capturing) releaseDesktopShortcut();
  else claimDesktopShortcut();
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
serveExternalApps(trustedSender);

ipcMain.on("thread:answer", (event, response: unknown) => {
  if (!trustedSender(event) || !isThreadResponse(response)) return;
  const timer = threadRequests.get(response.requestId);
  if (!timer) return;
  clearTimeout(timer);
  threadRequests.delete(response.requestId);
  answerThreadRequest(response);
});

const MAX_URL_LENGTH = 8_192;

function browserTabId(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid browser tab ID.");
  return value;
}

function browserPageUrl(value: unknown) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) throw new Error("Invalid page URL.");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The browser panel only opens web pages.");
  return value;
}

ipcMain.handle("browser:open", (event, tabId: unknown, url: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  browser.openTab(browserTabId(tabId), url === undefined ? undefined : browserPageUrl(url));
});

ipcMain.handle("browser:navigate", (event, tabId: unknown, url: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  browser.navigate(browserTabId(tabId), browserPageUrl(url));
});

ipcMain.handle("browser:history", (event, tabId: unknown, delta: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (delta !== 1 && delta !== -1) throw new Error("Invalid history step.");
  browser.goHistory(browserTabId(tabId), delta);
});

ipcMain.handle("browser:reload", (event, tabId: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  browser.reload(browserTabId(tabId));
});

ipcMain.handle("browser:close", (event, tabId: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  browser.closeTab(browserTabId(tabId));
});

ipcMain.handle("browser:show", (event, tabId: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  browser.showTab(tabId === null ? null : browserTabId(tabId));
});

ipcMain.handle("browser:bounds", (event, bounds: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (bounds !== null && !isBrowserBounds(bounds)) throw new Error("Invalid panel bounds.");
  browser.setBounds(bounds);
});

ipcMain.handle("browser:act", (event, tabId: unknown, action: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!isBrowserAction(action)) throw new Error("Invalid browser action.");
  return browser.act(browserTabId(tabId), action);
});

ipcMain.handle("browser:read", (event, tabId: unknown, textLimit: unknown, timeoutMs: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (typeof textLimit !== "number" || typeof timeoutMs !== "number") throw new Error("Invalid page read.");
  return browser.readPage(browserTabId(tabId), textLimit, timeoutMs);
});

ipcMain.handle("browser:find", (event, tabId: unknown, query: unknown, forward: unknown, findNext: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (typeof query !== "string" || !query || query.length > MAX_FIND_QUERY) throw new Error("Invalid search.");
  if (typeof forward !== "boolean" || typeof findNext !== "boolean") throw new Error("Invalid search.");
  browser.findInPage(browserTabId(tabId), query, { forward, findNext });
});

ipcMain.handle("browser:stop-find", (event, tabId: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  browser.stopFindInPage(browserTabId(tabId));
});

ipcMain.handle("browser:focus", (event, tabId: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  browser.focusTab(browserTabId(tabId));
});

ipcMain.handle("browser:clear", (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return browser.clearData();
});

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

/** Longer than anything anyone searches for, and still bounded. */
const MAX_FIND_QUERY = 1_000;

const MAX_TERMINAL_INPUT = 64 * 1024;
const MAX_TERMINAL_DIMENSION = 1_000;

function terminalId(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid terminal ID.");
  return value;
}

function terminalDimension(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TERMINAL_DIMENSION) throw new Error("Invalid terminal size.");
  return value;
}

ipcMain.handle("terminal:start", (event, id: unknown, options: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const cwd = (options as { cwd?: unknown } | null)?.cwd;
  if (typeof cwd !== "string" || !cwd) throw new Error("Invalid terminal folder.");
  terminal.startTerminal(terminalId(id), cwd);
});

ipcMain.handle("terminal:write", (event, id: unknown, data: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (typeof data !== "string" || data.length > MAX_TERMINAL_INPUT) throw new Error("Invalid terminal input.");
  terminal.writeTerminal(terminalId(id), data);
});

ipcMain.handle("terminal:resize", (event, id: unknown, cols: unknown, rows: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  terminal.resizeTerminal(terminalId(id), terminalDimension(cols), terminalDimension(rows));
});

ipcMain.handle("terminal:close", (event, id: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  terminal.closeTerminal(terminalId(id));
});

ipcMain.handle("terminal:read", (event, id: unknown, options: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const read = options as { lines?: unknown; match?: unknown } | null;
  if (typeof read?.lines !== "number" || !Number.isFinite(read.lines)) throw new Error("Invalid terminal read.");
  if (read.match !== undefined && typeof read.match !== "string") throw new Error("Invalid terminal filter.");
  return terminal.readTerminal(terminalId(id), { lines: terminalLineLimit(read.lines), ...(read.match ? { match: read.match } : {}) });
});

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function attachmentsDirectory() {
  return path.join(app.getPath("userData"), "attachments");
}

/** A renderer may only name files this app wrote into the attachments directory; anything else is null. */
function savedAttachmentPath(file: string) {
  const name = attachmentName(file);
  if (!/^[A-Za-z0-9-]+\.png$/.test(name)) return null;
  const saved = path.join(attachmentsDirectory(), name);
  return path.resolve(file) === saved ? saved : null;
}

/** Puts base64 PNG bytes in the attachments directory under a name of this app's own making. */
async function writeAttachment(data: string) {
  if (data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment is empty or too large.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Attachment payload is not base64.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0) throw new Error("Attachment is empty or too large.");
  const directory = attachmentsDirectory();
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.png`);
  await writeFile(file, bytes);
  return file;
}

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

function worktreeRequest(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid worktree request.");
  return value as Record<string, unknown>;
}

function worktreePath(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 4_096) throw new Error("Invalid worktree path.");
  return value;
}

ipcMain.handle("workspace:branches", async (event, workspaceId: unknown) => {
  if (!trustedSender(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
  try {
    const resolution = await getWorkspaceService().resolve(worktreePath(workspaceId));
    if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
    const { listBranches } = await import("./workspace/git.mjs");
    return { status: "available", ...(await listBranches(resolution.workspace.root)) } as const;
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }
});

/** Best effort throughout: a checkout with no answer is one whose row is simply not drawn. */
ipcMain.handle("workspace:pull-request", async (event, workspaceId: unknown) => {
  if (!trustedSender(event)) return null;
  try {
    const resolution = await getWorkspaceService().resolve(worktreePath(workspaceId));
    if (resolution.status !== "available") return null;
    const { pullRequestFor } = await import("./workspace/github.mjs");
    return await pullRequestFor(resolution.workspace.root);
  } catch {
    return null;
  }
});

ipcMain.handle("workspace:checkout-branch", async (event, workspaceId: unknown, branch: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const resolution = await getWorkspaceService().resolve(worktreePath(workspaceId));
  if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
  const { checkoutBranch } = await import("./workspace/git.mjs");
  await checkoutBranch(resolution.workspace.root, worktreePath(branch));
});

ipcMain.handle("workspace:create-branch", async (event, workspaceId: unknown, branch: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const resolution = await getWorkspaceService().resolve(worktreePath(workspaceId));
  if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
  const { createBranch } = await import("./workspace/git.mjs");
  await createBranch(resolution.workspace.root, worktreePath(branch));
});

ipcMain.handle("worktree:create", async (event, request: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const fields = worktreeRequest(request);
  return getWorktreeService().create({
    projectRoot: worktreePath(fields.projectRoot),
    carryChanges: fields.carryChanges === true,
    ...(typeof fields.branch === "string" && fields.branch ? { branch: fields.branch } : {}),
  } satisfies CreateWorktreeRequest);
});

ipcMain.handle("worktree:list", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return getWorktreeService().list();
});

ipcMain.handle("worktree:reveal", async (event, root: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  shell.showItemInFolder(await getWorktreeService().ownedPath(worktreePath(root)));
});

ipcMain.handle("worktree:release", async (event, request: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const fields = worktreeRequest(request);
  const release = fields.release === "deleted" ? "deleted" : "returned-to-local";
  return getWorktreeService().release({
    worktreeId: worktreePath(fields.worktreeId),
    root: worktreePath(fields.root),
    taskId: typeof fields.taskId === "string" ? worktreePath(fields.taskId) : null,
    title: typeof fields.title === "string" ? fields.title : "",
    release,
  } satisfies ReleaseWorktreeRequest);
});

ipcMain.handle("workspace:changed-files", async (event, workspaceId: unknown) => {
  if (!trustedSender(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
  try {
    return await readChangedFiles(workspaceId);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }
});

ipcMain.handle("workspace:diff-summary", async (event, workspaceId: unknown, range: unknown) => {
  if (!trustedSender(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
  const { isDiffRange } = await import("../domain/diff.js");
  if (!isDiffRange(range)) return { status: "error", message: "Invalid comparison." } as const;
  try {
    const { diffSummary } = await import("./workspace/git-diff.mjs");
    return await diffSummary(workspaceId, range, getWorkspaceService());
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }
});

ipcMain.handle("workspace:diff-patch", async (event, workspaceId: unknown, range: unknown, filePath: unknown, previousPath: unknown) => {
  if (!trustedSender(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 4_096) return { status: "error", message: "Invalid path." } as const;
  if (previousPath !== undefined && (typeof previousPath !== "string" || previousPath.length === 0 || previousPath.length > 4_096)) return { status: "error", message: "Invalid path." } as const;
  const { isDiffRange } = await import("../domain/diff.js");
  if (!isDiffRange(range)) return { status: "error", message: "Invalid comparison." } as const;
  try {
    const { diffPatch } = await import("./workspace/git-diff.mjs");
    return await diffPatch(workspaceId, range, filePath, getWorkspaceService(), previousPath);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }
});
