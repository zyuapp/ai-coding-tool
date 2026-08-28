import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AgentEngine } from "./domain/agent-engine";
import type { CaptureOptions } from "./domain/capture";
import type { AgentEvent, AutomationAck, AutomationFire, BrowserFindEvent, BrowserPageEvent, ComputerUsePermission, CreateWorktreeRequest, DesktopAPI, ThreadNotice, ReleaseWorktreeRequest, RunCommand, ShortcutInvocation, TerminalDataEvent, TerminalReadOptions, TerminalStartOptions, WindowScreenshot, WindowTheme } from "./contracts/ipc";
import type { BrowserAction, BrowserBounds } from "./domain/browser";
import type { WorkspaceRecord } from "./domain/workspace";
import type { ShortcutOverrides } from "./domain/shortcuts";
import type { TerminalUpdate } from "./domain/terminal";
import type { ThreadRequest, ThreadResponse } from "./contracts/threads";
import type { MobileRequest, MobileResponse, MobileViewUpdate } from "./contracts/mobile";
import type { MobileServerState } from "./domain/mobile";
import type { AutomationDraft, AutomationPatch, AutomationView } from "./domain/automation";

const api: DesktopAPI = {
  openFolder: () => ipcRenderer.invoke("workspace:open"),
  registerProject: (root: string) => ipcRenderer.invoke("workspace:register", root),
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
  commands: (workspaceId: string, engine: string) => ipcRenderer.invoke("workspace:commands", workspaceId, engine),
  computerUsePermissions: () => ipcRenderer.invoke("computer-use:permissions"),
  enableComputerUse: (permission: ComputerUsePermission) => ipcRenderer.invoke("computer-use:enable", permission),
  restartForComputerUse: () => ipcRenderer.send("computer-use:restart"),
  planUsage: (engine: AgentEngine) => ipcRenderer.invoke("usage:plan", engine),
  send: (command: RunCommand) => ipcRenderer.send("run:command", command),
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on("run:event", handler);
    return () => ipcRenderer.removeListener("run:event", handler);
  },
  changedFiles: (workspaceId: string) => ipcRenderer.invoke("workspace:changed-files", workspaceId),
  branches: (workspaceId: string) => ipcRenderer.invoke("workspace:branches", workspaceId),
  pullRequest: (workspaceId: string) => ipcRenderer.invoke("workspace:pull-request", workspaceId),
  diffSummary: (workspaceId: string, range: unknown, ignoreWhitespace?: boolean) => ipcRenderer.invoke("workspace:diff-summary", workspaceId, range, ignoreWhitespace),
  diffPatch: (workspaceId: string, range: unknown, path: string, previousPath?: string, ignoreWhitespace?: boolean) => ipcRenderer.invoke("workspace:diff-patch", workspaceId, range, path, previousPath, ignoreWhitespace),
  checkoutBranch: (workspaceId: string, branch: string) => ipcRenderer.invoke("workspace:checkout-branch", workspaceId, branch),
  createBranch: (workspaceId: string, branch: string) => ipcRenderer.invoke("workspace:create-branch", workspaceId, branch),
  createWorktree: (request: CreateWorktreeRequest) => ipcRenderer.invoke("worktree:create", request),
  listManagedWorktrees: () => ipcRenderer.invoke("worktree:list"),
  revealWorktree: (root: string) => ipcRenderer.invoke("worktree:reveal", root),
  releaseWorktree: (request: ReleaseWorktreeRequest) => ipcRenderer.invoke("worktree:release", request),
  saveAttachment: (data: string) => ipcRenderer.invoke("attachment:save", data),
  readAttachment: (file: string) => ipcRenderer.invoke("attachment:read", file),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  describeFiles: (paths: string[]) => ipcRenderer.invoke("file:describe", paths),
  suggestTaskTitle: (text: string, attachments: string[], engine: AgentEngine) => ipcRenderer.invoke("task-title:suggest", text, attachments, engine),
  engineStatus: () => ipcRenderer.invoke("engine:status"),
  signInEngine: (engine: AgentEngine) => ipcRenderer.invoke("engine:sign-in", engine),
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
  mobileState: () => ipcRenderer.invoke("mobile:state"),
  setMobileEnabled: (enabled: boolean) => ipcRenderer.invoke("mobile:set-enabled", enabled),
  setMobileLanExposed: (exposed: boolean) => ipcRenderer.invoke("mobile:set-lan", exposed),
  createMobilePairingCode: () => ipcRenderer.invoke("mobile:pair-code"),
  revokeMobileDevice: (deviceId: string) => ipcRenderer.invoke("mobile:revoke", deviceId),
  setTailscaleServe: (enabled: boolean) => ipcRenderer.invoke("mobile:tailscale-serve", enabled),
  refreshTailscale: () => ipcRenderer.invoke("mobile:tailscale-refresh"),
  onMobileState: (listener: (state: MobileServerState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: MobileServerState) => listener(payload);
    ipcRenderer.on("mobile:changed", handler);
    return () => ipcRenderer.removeListener("mobile:changed", handler);
  },
  onMobileRequest: (listener: (request: MobileRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: MobileRequest) => listener(payload);
    ipcRenderer.on("mobile:request", handler);
    return () => ipcRenderer.removeListener("mobile:request", handler);
  },
  answerMobileRequest: (response: MobileResponse) => ipcRenderer.send("mobile:answer", response),
  publishMobileView: (update: MobileViewUpdate) => ipcRenderer.send("mobile:publish", update),
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
  openFile: (roots: string[], path: string, line: number | null) => ipcRenderer.invoke("file:open", roots, path, line),
  listApps: () => ipcRenderer.invoke("apps:list"),
  openFolderInApp: (appId: string, root: string) => ipcRenderer.invoke("apps:open", appId, root),
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
  onWindowScreenshot: (listener: (shot: WindowScreenshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: WindowScreenshot) => listener(payload);
    ipcRenderer.on("window:screenshot", handler);
    return () => ipcRenderer.removeListener("window:screenshot", handler);
  },
  onDesktopShortcutRefused: (listener: (binding: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: string) => listener(payload);
    ipcRenderer.on("window:shortcut-refused", handler);
    return () => ipcRenderer.removeListener("window:shortcut-refused", handler);
  },
  setCaptureOptions: (options: CaptureOptions) => ipcRenderer.send("capture:set-options", options),
  setTheme: (theme: WindowTheme) => ipcRenderer.send("theme:set", theme),
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
  announceThread: (notice: ThreadNotice) => ipcRenderer.send("thread:announce", notice),
  setBadgeCount: (count: number) => ipcRenderer.send("badge:set", count),
  onOpenThread: (listener: (taskId: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: string) => listener(payload);
    ipcRenderer.on("window:open-thread", handler);
    return () => ipcRenderer.removeListener("window:open-thread", handler);
  },
};

contextBridge.exposeInMainWorld("desktop", api);
