import { app, BrowserWindow, dialog, ipcMain, net, protocol, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ATTACHMENT_SCHEME, attachmentName } from "../application/attachments.js";
import { isRunCommand, isRunEvent, type ComputerUsePermission, type RunCommand, type RunEvent, type StartRunCommand } from "../contracts/ipc.js";
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import { acceptRunEvent, failedEventsForTransportLoss, supersedePendingStarts } from "./run-routing.js";
import type { TaskDatabase } from "./task-database.mjs" with { "resolution-mode": "import" };
import { computerUseForRun, computerUsePermissions, requestComputerUsePermission, stopComputerUse } from "./computer-use-host.js";

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
let taskDatabase: TaskDatabase | null = null;
let quitting = false;
let quitAfterComputerUseStops = false;

type RunState = {
  taskId: string;
  runId: string;
  lastSequence: number;
  terminal: boolean;
};

const runStates = new Map<string, RunState>();
const pendingStarts = new Map<string, StartRunCommand>();

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
    for (const [oldKey, oldCommand] of supersedePendingStarts(pendingStarts, runKey(payload.taskId, payload.runId), (command) => command.channel === payload.channel)) {
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

async function createWindow() {
  window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 620,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f7f6f2",
    icon,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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

app.whenReady().then(async () => {
  const userData = app.getPath("userData");
  const { WorkspaceService: WorkspaceServiceConstructor } = await import("./workspace/workspace-service.mjs");
  workspaceService = new WorkspaceServiceConstructor({
    registryPath: path.join(userData, "workspaces.v1.json"),
    projectlessRoot: path.join(userData, "projectless"),
  });
  const { TaskDatabase: TaskDatabaseConstructor } = await import("./task-database.mjs");
  taskDatabase = new TaskDatabaseConstructor(path.join(userData, "tasks.v3.sqlite"));
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

ipcMain.handle("computer-use:permissions", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  return computerUsePermissions();
});

ipcMain.handle("computer-use:enable", async (event, permission: ComputerUsePermission) => {
  if (!trustedSender(event)) throw new Error("Untrusted IPC sender.");
  if (permission !== "accessibility" && permission !== "screenRecording") throw new Error("Invalid computer-use permission.");
  return requestComputerUsePermission(permission);
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

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function attachmentsDirectory() {
  return path.join(app.getPath("userData"), "attachments");
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

ipcMain.handle("workspace:changed-files", async (event, workspaceId: unknown) => {
  if (!trustedSender(event)) return { status: "error", message: "Untrusted IPC sender." } as const;
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256) return { status: "error", message: "Invalid workspace ID." } as const;
  try {
    return await readChangedFiles(workspaceId);
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) } as const;
  }
});
