import { contextBridge, ipcRenderer } from "electron";
import type { AutomationAck, AutomationFire, BrowserPageEvent, ComputerUsePermission, CreateWorktreeRequest, DesktopAPI, ReleaseWorktreeRequest, RunCommand, RunEvent, TerminalDataEvent, TerminalReadOptions, TerminalStartOptions } from "./contracts/ipc";
import type { BrowserAction, BrowserBounds } from "./domain/browser";
import type { TerminalUpdate } from "./domain/terminal";
import type { ThreadRequest, ThreadResponse } from "./contracts/threads";
import type { AutomationDraft, AutomationPatch, AutomationView } from "./domain/automation";

const api: DesktopAPI = {
  openFolder: () => ipcRenderer.invoke("workspace:open"),
  projectlessWorkspace: () => ipcRenderer.invoke("workspace:projectless"),
  commands: (workspaceId: string) => ipcRenderer.invoke("workspace:commands", workspaceId),
  computerUsePermissions: () => ipcRenderer.invoke("computer-use:permissions"),
  enableComputerUse: (permission: ComputerUsePermission) => ipcRenderer.invoke("computer-use:enable", permission),
  restartForComputerUse: () => ipcRenderer.send("computer-use:restart"),
  planUsage: () => ipcRenderer.invoke("usage:plan"),
  send: (command: RunCommand) => ipcRenderer.send("run:command", command),
  onAgentEvent: (listener: (event: RunEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RunEvent) => listener(payload);
    ipcRenderer.on("run:event", handler);
    return () => ipcRenderer.removeListener("run:event", handler);
  },
  changedFiles: (workspaceId: string) => ipcRenderer.invoke("workspace:changed-files", workspaceId),
  branches: (workspaceId: string) => ipcRenderer.invoke("workspace:branches", workspaceId),
  checkoutBranch: (workspaceId: string, branch: string) => ipcRenderer.invoke("workspace:checkout-branch", workspaceId, branch),
  createBranch: (workspaceId: string, branch: string) => ipcRenderer.invoke("workspace:create-branch", workspaceId, branch),
  createWorktree: (request: CreateWorktreeRequest) => ipcRenderer.invoke("worktree:create", request),
  releaseWorktree: (request: ReleaseWorktreeRequest) => ipcRenderer.invoke("worktree:release", request),
  deleteWorktree: (root: string) => ipcRenderer.invoke("worktree:delete", root),
  saveAttachment: (data: string) => ipcRenderer.invoke("attachment:save", data),
  suggestTaskTitle: (text: string, attachments: string[]) => ipcRenderer.invoke("task-title:suggest", text, attachments),
  loadTaskStore: () => ipcRenderer.invoke("task-store:load"),
  persistTaskStore: (delta) => ipcRenderer.invoke("task-store:persist", delta),
  listAutomations: () => ipcRenderer.invoke("automation:list"),
  saveAutomation: (draft: AutomationDraft) => ipcRenderer.invoke("automation:save", draft),
  updateAutomation: (taskId: string, patch: AutomationPatch) => ipcRenderer.invoke("automation:update", taskId, patch),
  deleteAutomation: (taskId: string) => ipcRenderer.invoke("automation:delete", taskId),
  runAutomationNow: (taskId: string) => ipcRenderer.invoke("automation:run-now", taskId),
  onAutomationsChanged: (listener: (automations: AutomationView[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AutomationView[]) => listener(payload);
    ipcRenderer.on("automation:changed", handler);
    return () => ipcRenderer.removeListener("automation:changed", handler);
  },
  onAutomationFire: (listener: (fire: AutomationFire) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AutomationFire) => listener(payload);
    ipcRenderer.on("automation:fire", handler);
    return () => ipcRenderer.removeListener("automation:fire", handler);
  },
  acknowledgeAutomation: (ack: AutomationAck) => ipcRenderer.send("automation:ack", ack),
  onThreadRequest: (listener: (request: ThreadRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ThreadRequest) => listener(payload);
    ipcRenderer.on("thread:request", handler);
    return () => ipcRenderer.removeListener("thread:request", handler);
  },
  answerThreadRequest: (response: ThreadResponse) => ipcRenderer.send("thread:answer", response),
  openBrowserTab: (tabId: string, url?: string) => ipcRenderer.invoke("browser:open", tabId, url),
  navigateBrowser: (tabId: string, url: string) => ipcRenderer.invoke("browser:navigate", tabId, url),
  browserHistory: (tabId: string, delta: -1 | 1) => ipcRenderer.invoke("browser:history", tabId, delta),
  reloadBrowser: (tabId: string) => ipcRenderer.invoke("browser:reload", tabId),
  closeBrowserTab: (tabId: string) => ipcRenderer.invoke("browser:close", tabId),
  showBrowserTab: (tabId: string | null) => ipcRenderer.invoke("browser:show", tabId),
  setBrowserBounds: (bounds: BrowserBounds | null) => ipcRenderer.invoke("browser:bounds", bounds),
  actInBrowser: (tabId: string, action: BrowserAction) => ipcRenderer.invoke("browser:act", tabId, action),
  readBrowserPage: (tabId: string, textLimit: number, timeoutMs: number) => ipcRenderer.invoke("browser:read", tabId, textLimit, timeoutMs),
  clearBrowserData: () => ipcRenderer.invoke("browser:clear"),
  onBrowserEvent: (listener: (event: BrowserPageEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: BrowserPageEvent) => listener(payload);
    ipcRenderer.on("browser:event", handler);
    return () => ipcRenderer.removeListener("browser:event", handler);
  },
  startTerminal: (terminalId: string, options: TerminalStartOptions) => ipcRenderer.invoke("terminal:start", terminalId, options),
  writeTerminal: (terminalId: string, data: string) => ipcRenderer.invoke("terminal:write", terminalId, data),
  resizeTerminal: (terminalId: string, cols: number, rows: number) => ipcRenderer.invoke("terminal:resize", terminalId, cols, rows),
  closeTerminal: (terminalId: string) => ipcRenderer.invoke("terminal:close", terminalId),
  readTerminal: (terminalId: string, options: TerminalReadOptions) => ipcRenderer.invoke("terminal:read", terminalId, options),
  onTerminalData: (listener: (event: TerminalDataEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent) => listener(payload);
    ipcRenderer.on("terminal:data", handler);
    return () => ipcRenderer.removeListener("terminal:data", handler);
  },
  onTerminalEvent: (listener: (update: TerminalUpdate) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalUpdate) => listener(payload);
    ipcRenderer.on("terminal:event", handler);
    return () => ipcRenderer.removeListener("terminal:event", handler);
  },
  onCloseTab: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("window:close-tab", handler);
    return () => ipcRenderer.removeListener("window:close-tab", handler);
  },
  closeWindow: () => ipcRenderer.send("window:close"),
};

contextBridge.exposeInMainWorld("desktop", api);
