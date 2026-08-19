import { app, BrowserWindow, dialog, ipcMain, net, protocol, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACHMENT_SCHEME, attachmentName } from "../application/attachments.js";
import { isAutomationAck, isAutomationRequest, isBrowserAction, isBrowserBounds, isRunCommand, isRunEvent, isThreadRequest, isThreadResponse, type AutomationFire, type AutomationRequest, type AutomationResponse, type BrowserPageEvent, type ComputerUsePermission, type CreateWorktreeRequest, type ReleaseWorktreeRequest, type RunCommand, type RunEvent, type StartRunCommand } from "../contracts/ipc.js";
import type { ThreadRequest, ThreadResponse } from "../contracts/threads.js";
import { isAutomationDraft, isAutomationPatch, type Automation, type AutomationRunStatus } from "../domain/automation.js";
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { WorktreeService } from "./workspace/worktrees.mjs" with { "resolution-mode": "import" };
import { acceptRunEvent, failedEventsForTransportLoss, supersedePendingStarts } from "./run-routing.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { TaskDatabase } from "./task-database.mjs" with { "resolution-mode": "import" };
import { computerUseForRun, computerUsePermissions, requestComputerUsePermission, stopComputerUse } from "./computer-use-host.js";
import * as browser from "./browser-host.js";

app.setName("Claudex");
const legacyUserData = path.join(app.getPath("appData"), "Threadline");
if (existsSync(legacyUserData)) app.setPath("userData", legacyUserData);

protocol.registerSchemesAsPrivileged([
  { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const icon = path.join(app.getAppPath(), "assets", "icon.png");
let window: BrowserWindow | null = null;
let agent: Electron.UtilityProcess | null = null;
let workspaceService: WorkspaceService | null = null;
let worktreeService: WorktreeService | null = null;
let taskDatabase: TaskDatabase | null = null;
let automationScheduler: AutomationScheduler | null = null;
let quitting = false;
let quitAfterComputerUseStops = false;

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
const pendingStarts = new Map<string, StartRunCommand>();
const automationDispatches = new Map<string, AutomationDispatchState>();
const threadRequests = new Map<string, ReturnType<typeof setTimeout>>();

function runKey(taskId: string, runId: string) {
  return `${taskId}\u0000${runId}`;
}

function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

function sendToRenderer(event: RunEvent) {
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
  }
}

function getAutomationScheduler() {
  if (!automationScheduler) throw new Error("Automation scheduler is not ready.");
  return automationScheduler;
}

/** Hands the tick to the renderer, which owns the transcript, then waits for that run to settle. */
async function dispatchAutomation(automation: Automation): Promise<AutomationRunStatus> {
  if (!window || window.isDestroyed()) return "skipped";
  const runId = randomUUID();
  const dispatch: AutomationDispatchState = {};
  automationDispatches.set(runId, dispatch);
  try {
    const fire: AutomationFire = {
      automationId: automation.id,
      taskId: automation.taskId,
      runId,
      prompt: automation.prompt,
      ...(automation.policy === undefined ? {} : { policy: automation.policy }),
      runNumber: automation.runCount + 1,
    };
    // Armed before the tick leaves main so a run that settles immediately still reports back.
    const settled = new Promise<AutomationRunStatus>((resolve) => { dispatch.settle = resolve; });
    const started = await new Promise<boolean>((resolve) => {
      dispatch.acknowledge = resolve;
      setTimeout(() => resolve(false), AUTOMATION_ACK_TIMEOUT).unref?.();
      window!.webContents.send("automation:fire", fire);
    });
    return started ? await settled : "skipped";
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
    answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: "The Claudex window is not open." });
    return;
  }
  const patience = request.op === "wait"
    ? request.timeoutMs + THREAD_WAIT_SLACK
    : request.op === "browser" && request.read.op === "snapshot"
      ? request.read.timeoutMs + THREAD_WAIT_SLACK
      : THREAD_REQUEST_TIMEOUT;
  const timer = setTimeout(() => {
    threadRequests.delete(request.requestId);
    answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: `Claudex did not answer the thread "${request.op}" request within ${patience}ms.` });
  }, patience);
  timer.unref?.();
  threadRequests.set(request.requestId, timer);
  window.webContents.send("thread:request", request);
}

/** The window decides what ⌘W closes, because it is the only side that knows what is in front. */
function requestCloseTab() {
  if (window && !window.isDestroyed()) window.webContents.send("window:close-tab");
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
    serviceName: "Claudex Agent",
    stdio: "pipe",
  });
  agent.on("message", (event: unknown) => {
    if (isRunEvent(event)) publishRunEvent(event);
    else if (isAutomationRequest(event)) void handleAutomationRequest(event);
    else if (isThreadRequest(event)) handleThreadRequest(event);
  });
  agent.on("exit", (code) => {
    agent = null;
    if (!quitting) {
      pendingStarts.clear();
      const message = `Agent process exited${code === null ? "" : ` with code ${code}`}.`;
      for (const event of failedEventsForTransportLoss(runStates.values(), message)) publishRunEvent(event);
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
  const [resolution, computerUse] = await Promise.all([getWorkspaceService().resolve(command.workspaceId), computerUseForRun()]);
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
    const state = runStates.get(runKey(command.taskId, command.runId));
    if (state && !state.terminal) {
      publishRunEvent({
        type: "run.status",
        taskId: command.taskId,
        runId: command.runId,
        sequence: state.lastSequence + 1,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
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
  if (!trustedSender(event) || !isRunCommand(payload)) return;
  if (payload.type === "start") {
    if (runStates.has(runKey(payload.taskId, payload.runId))) return;
    for (const [oldKey, oldCommand] of supersedePendingStarts(pendingStarts, runKey(payload.taskId, payload.runId), (command) => command.taskId === payload.taskId)) {
      if (runStates.get(oldKey)?.terminal) continue;
      emitSyntheticTerminal(oldCommand, "cancelled", "The run was superseded before it started.");
    }
    void dispatchStart(payload);
    return;
  }
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

/** The renderer's --canvas, so the window does not flash a different colour before it paints. */
const CANVAS = "#0e1117";

async function createWindow() {
  window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    titleBarStyle: "hiddenInset",
    backgroundColor: CANVAS,
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
    onCloseTab: requestCloseTab,
  });
  /** The window owns no menu shortcut the app wants back; preventing it here is what frees ⌘W. */
  window.webContents.on("before-input-event", (event, input) => {
    if (!browser.isCloseTab(input)) return;
    event.preventDefault();
    requestCloseTab();
  });
  window.on("closed", () => browser.stopBrowserHost());
  await window.loadFile(path.join(__dirname, "../../renderer/index.html"));
}

async function checkForUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = (await import("electron-updater")).default;
  autoUpdater.autoDownload = false;
  autoUpdater.on("error", (error) => console.error("Update error:", error));
  autoUpdater.on("update-available", async ({ version }) => {
    if (!window || window.isDestroyed()) return;
    const result = await dialog.showMessageBox(window, {
      type: "info",
      title: "Update available",
      message: `Claudex ${version} is available.`,
      detail: "Download it now? You can keep working while it downloads.",
      buttons: ["Download update", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) await autoUpdater.downloadUpdate().catch((error) => console.error("Update download failed:", error));
  });
  autoUpdater.on("update-downloaded", async ({ version }) => {
    if (!window || window.isDestroyed()) return;
    const result = await dialog.showMessageBox(window, {
      type: "info",
      title: "Update ready",
      message: `Claudex ${version} is ready to install.`,
      detail: "Restart Claudex to finish the update.",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) autoUpdater.quitAndInstall(false, true);
  });
  await autoUpdater.checkForUpdates();
}

/**
 * Brings the worktrees on disk back in line with the threads that claim them, before the window can
 * read either. A checkout no thread claims is reaped, and a thread claiming a checkout that is gone
 * becomes local again, so neither side is left pointing at something that is not there.
 */
async function reconcileWorktrees(database: TaskDatabase, worktrees: WorktreeService) {
  try {
    const claimed = database.claimedWorktrees();
    /** A store too damaged to read still must not stop the checkouts on disk from being tidied. */
    const repositories = (() => {
      try {
        return database.load()?.projects.map((project) => project.root) ?? [];
      } catch {
        return [];
      }
    })();
    const { reaped } = await worktrees.reconcile({ claimed, repositories });
    const missing = claimed.filter((root) => !existsSync(root));
    const forgotten = database.forgetWorktrees(missing);
    if (reaped.length || forgotten) console.log(`Reconciled worktrees: reaped ${reaped.length}, released ${forgotten}.`);
  } catch (error) {
    console.error("Could not reconcile worktrees:", error);
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const { WorkspaceService: WorkspaceServiceConstructor } = await import("./workspace/workspace-service.mjs");
  workspaceService = new WorkspaceServiceConstructor({
    registryPath: path.join(userData, "workspaces.v1.json"),
    projectlessRoot: path.join(userData, "projectless"),
  });
  const { WorktreeService: WorktreeServiceConstructor } = await import("./workspace/worktrees.mjs");
  const worktreesRoot = path.join(userData, "worktrees");
  worktreeService = new WorktreeServiceConstructor({ worktreesRoot, workspaces: workspaceService });
  const { TaskDatabase: TaskDatabaseConstructor } = await import("./task-database.mjs");
  taskDatabase = new TaskDatabaseConstructor(path.join(userData, "tasks.v3.sqlite"), { worktreesRoot });
  await reconcileWorktrees(taskDatabase, worktreeService);
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
  app.dock?.setIcon(icon);
  startAgent();
  await createWindow();
  void checkForUpdates().catch((error) => console.error("Update check failed:", error));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (!quitAfterComputerUseStops) {
    event.preventDefault();
    quitAfterComputerUseStops = true;
    void stopComputerUse().finally(() => app.quit());
    return;
  }
  quitting = true;
  agent?.kill();
});

app.on("will-quit", () => {
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

ipcMain.handle("workspace:projectless", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return (await getWorkspaceService().getProjectless()).workspace;
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
  app.relaunch();
  app.quit();
});

ipcMain.handle("task-store:load", (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!taskDatabase) throw new Error("Task database is not ready.");
  return taskDatabase.load();
});

ipcMain.handle("task-store:persist", (event, delta) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (!taskDatabase) throw new Error("Task database is not ready.");
  taskDatabase.persist(delta);
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

ipcMain.on("window:close", (event) => {
  if (!trustedSender(event)) return;
  window?.close();
});

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

ipcMain.handle("browser:clear", (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return browser.clearData();
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

ipcMain.handle("attachment:save", async (event, data: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (typeof data !== "string" || data.length === 0 || data.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment is empty or too large.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Attachment payload is not base64.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength === 0) throw new Error("Attachment is empty or too large.");
  const directory = attachmentsDirectory();
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${randomUUID()}.png`);
  await writeFile(file, bytes);
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

ipcMain.handle("worktree:release", async (event, request: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  const fields = worktreeRequest(request);
  const release = fields.release === "evicted" ? "evicted" : "returned-to-local";
  return getWorktreeService().release({
    worktreeId: worktreePath(fields.worktreeId),
    root: worktreePath(fields.root),
    taskId: worktreePath(fields.taskId),
    title: typeof fields.title === "string" ? fields.title : "",
    release,
  } satisfies ReleaseWorktreeRequest);
});

ipcMain.handle("worktree:delete", async (event, root: unknown) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  await getWorktreeService().delete(worktreePath(root));
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
