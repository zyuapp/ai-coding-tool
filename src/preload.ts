import { contextBridge, ipcRenderer } from "electron";
import type { AutomationAck, AutomationFire, BrowserFindEvent, BrowserPageEvent, ComputerUsePermission, CreateWorktreeRequest, DesktopAPI, ReleaseWorktreeRequest, RunCommand, RunEvent, ShortcutInvocation, TerminalDataEvent, TerminalReadOptions, TerminalStartOptions } from "./contracts/ipc";
import type { BrowserAction, BrowserBounds } from "./domain/browser";
import type { WorkspaceRecord } from "./domain/workspace";
import type { ShortcutOverrides } from "./domain/shortcuts";
import type { TerminalUpdate } from "./domain/terminal";
import type { ThreadRequest, ThreadResponse } from "./contracts/threads";
import type { AutomationDraft, AutomationPatch, AutomationView } from "./domain/automation";

const api: DesktopAPI = {
  openFolder: () => ipcRenderer.invoke("workspace:open"),
  onOpenProject: (listener: (workspace: WorkspaceRecord) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: WorkspaceRecord) => listener(payload);
    ipcRenderer.on("workspace:open-project", handler);
    ipcRenderer.send("workspace:open-project-ready");
    return () => ipcRenderer.removeListener("workspace:open-project", handler);
  },
  cliStatus: () => ipcRenderer.invoke("cli:status"),
  installCli: () => ipcRenderer.invoke("cli:install"),
  uninstallCli: () => ipcRenderer.invoke("cli:uninstall"),
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
  diffSummary: (workspaceId: string, range: unknown) => ipcRenderer.invoke("workspace:diff-summary", workspaceId, range),
  diffPatch: (workspaceId: string, range: unknown, path: string) => ipcRenderer.invoke("workspace:diff-patch", workspaceId, range, path),
  checkoutBranch: (workspaceId: string, branch: string) => ipcRenderer.invoke("workspace:checkout-branch", workspaceId, branch),
  createBranch: (workspaceId: string, branch: string) => ipcRenderer.invoke("workspace:create-branch", workspaceId, branch),
  createWorktree: (request: CreateWorktreeRequest) => ipcRenderer.invoke("worktree:create", request),
  releaseWorktree: (request: ReleaseWorktreeRequest) => ipcRenderer.invoke("worktree:release", request),
  deleteWorktree: (root: string) => ipcRenderer.invoke("worktree:delete", root),
  saveAttachment: (data: string) => ipcRenderer.invoke("attachment:save", data),
  suggestTaskTitle: (text: string, attachments: string[]) => ipcRenderer.invoke("task-title:suggest", text, attachments),
  loadTaskStore: () => ipcRenderer.invoke("task-store:load"),
  persistTaskStore: (delta) => ipcRenderer.invoke("task-store:persist", delta),
  loadSubagentActivity: (taskId: string, subagentId: string) => ipcRenderer.invoke("subagent-activity:load", taskId, subagentId),
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
  findInPage: (tabId: string, query: string, forward: boolean, findNext: boolean) => ipcRenderer.invoke("browser:find", tabId, query, forward, findNext),
  stopFindInPage: (tabId: string) => ipcRenderer.invoke("browser:stop-find", tabId),
  focusBrowserTab: (tabId: string) => ipcRenderer.invoke("browser:focus", tabId),
  onBrowserFind: (listener: (event: BrowserFindEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: BrowserFindEvent) => listener(payload);
    ipcRenderer.on("browser:find", handler);
    return () => ipcRenderer.removeListener("browser:find", handler);
  },
  openFile: (root: string, path: string, line: number | null) => ipcRenderer.invoke("file:open", root, path, line),
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
  setShortcuts: (overrides: ShortcutOverrides) => ipcRenderer.send("shortcuts:set", overrides),
  setShortcutCapture: (capturing: boolean) => ipcRenderer.send("shortcuts:capture", capturing),
  onShortcut: (listener: (invocation: ShortcutInvocation) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ShortcutInvocation) => listener(payload);
    ipcRenderer.on("window:shortcut", handler);
    return () => ipcRenderer.removeListener("window:shortcut", handler);
  },
  onShortcutCaptured: (listener: (binding: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: string | null) => listener(payload);
    ipcRenderer.on("window:shortcut-captured", handler);
    return () => ipcRenderer.removeListener("window:shortcut-captured", handler);
  },
  closeWindow: () => ipcRenderer.send("window:close"),
  focusWindow: () => ipcRenderer.send("window:focus"),
};

contextBridge.exposeInMainWorld("desktop", api);
