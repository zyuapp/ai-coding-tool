import { app, BrowserWindow, dialog, ipcMain, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentEvent, AgentRequest } from "../shared";

app.setName("Threadline");

const execFileAsync = promisify(execFile);
let window: BrowserWindow | null = null;
let agent: Electron.UtilityProcess | null = null;
const icon = path.join(app.getAppPath(), "assets", "icon.png");

function sendToRenderer(event: AgentEvent) {
  if (window && !window.isDestroyed()) window.webContents.send("agent:event", event);
}

function startAgent() {
  agent = utilityProcess.fork(path.join(__dirname, "agent-worker.mjs"), [], {
    serviceName: "Threadline Agent",
    stdio: "pipe",
  });
  agent.on("message", (event) => sendToRenderer(event as AgentEvent));
  agent.on("exit", (code) => {
    if (code) sendToRenderer({ type: "error", message: `Agent process exited with code ${code}.` });
    agent = null;
  });
  agent.stderr?.on("data", (chunk) => console.error(String(chunk)));
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

app.whenReady().then(() => {
  app.dock?.setIcon(icon);
  startAgent();
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => agent?.kill());

ipcMain.handle("folder:open", async () => {
  const result = await dialog.showOpenDialog(window!, {
    properties: ["openDirectory", "createDirectory"],
    title: "Open a project folder",
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.on("agent:request", (_event, request: AgentRequest) => {
  if (!agent) startAgent();
  agent?.postMessage(request);
});

ipcMain.handle("git:changed-files", async (_event, folder: string) => {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--short"], {
      cwd: folder,
      timeout: 5_000,
    });
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
});
