import assert from "node:assert/strict";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import { engineDesktopStub, mobileDesktopStub } from "./mobile-desktop.mts";

export const automationView = (overrides: Partial<AutomationView> = {}): AutomationView => ({
  id: "automation-1",
  taskId: "task-1",
  prompt: "Check whether the PR is approved",
  schedule: "*/5 * * * *",
  paused: false,
  createdAt: 1,
  updatedAt: 1,
  runCount: 2,
  lastRunAt: Date.parse("2026-08-17T09:30:00Z"),
  lastStatus: "succeeded",
  nextRunAt: Date.now() + 120_000,
  ...overrides,
});

export type FakeDesktop = DesktopAPI & {
  sent: RunCommand[];
  persisted: TaskStoreDelta[];
  acknowledged: Array<Parameters<DesktopAPI["acknowledgeAutomation"]>[0]>;
  automationChanges: Array<{ taskId: string; patch?: AutomationPatch; deleted?: true }>;
  listener: Parameters<DesktopAPI["onAgentEvent"]>[0];
  automationsChanged: Parameters<DesktopAPI["onAutomationsChanged"]>[0];
  fireAutomation: Parameters<DesktopAPI["onAutomationFire"]>[0];
  grabWindow: Parameters<DesktopAPI["onWindowScreenshot"]>[0];
  refuseShortcut: Parameters<DesktopAPI["onDesktopShortcutRefused"]>[0];
  threadAnswers: ThreadResponse[];
  askThreads: (request: ThreadRequest) => void;
  openProjectFromCli: (workspace: WorkspaceRecord) => void;
  unsubscribed: boolean;
  browserCalls: unknown[][];
  browserEvent: Parameters<DesktopAPI["onBrowserEvent"]>[0];
  terminalCalls: unknown[][];
  terminalEvent: Parameters<DesktopAPI["onTerminalEvent"]>[0];
  shortcuts: Array<Parameters<DesktopAPI["setShortcuts"]>[0]>;
  themes: Array<Parameters<DesktopAPI["setTheme"]>[0]>;
  captures: boolean[];
  captureOptions: Array<Parameters<DesktopAPI["setCaptureOptions"]>[0]>;
  appCalls: unknown[][];
  pressShortcut: (action: string, surface?: Parameters<Parameters<DesktopAPI["onShortcut"]>[0]>[0]["surface"]) => void;
  captureShortcut: (binding: string | null) => void;
};

export function fakeDesktop(overrides: Partial<DesktopAPI> = {}): FakeDesktop {
  const sent: RunCommand[] = [];
  const persisted: TaskStoreDelta[] = [];
  const acknowledged: Array<Parameters<DesktopAPI["acknowledgeAutomation"]>[0]> = [];
  const automationChanges: Array<{ taskId: string; patch?: AutomationPatch; deleted?: true }> = [];
  const browserCalls: unknown[][] = [];
  const terminalCalls: unknown[][] = [];
  const shortcuts: Array<Parameters<DesktopAPI["setShortcuts"]>[0]> = [];
  const themes: Array<Parameters<DesktopAPI["setTheme"]>[0]> = [];
  const captures: boolean[] = [];
  const captureOptions: Array<Parameters<DesktopAPI["setCaptureOptions"]>[0]> = [];
  const appCalls: unknown[][] = [];
  let browserEvent: Parameters<DesktopAPI["onBrowserEvent"]>[0] | undefined;
  let terminalEvent: Parameters<DesktopAPI["onTerminalEvent"]>[0] | undefined;
  let shortcutPressed: Parameters<DesktopAPI["onShortcut"]>[0] | undefined;
  let shortcutCaptured: Parameters<DesktopAPI["onShortcutCaptured"]>[0] | undefined;
  let windowGrabbed: Parameters<DesktopAPI["onWindowScreenshot"]>[0] | undefined;
  let shortcutRefused: Parameters<DesktopAPI["onDesktopShortcutRefused"]>[0] | undefined;
  let listener: Parameters<DesktopAPI["onAgentEvent"]>[0] | undefined;
  let automationsChanged: Parameters<DesktopAPI["onAutomationsChanged"]>[0] | undefined;
  let fireAutomation: Parameters<DesktopAPI["onAutomationFire"]>[0] | undefined;
  let threadRequested: Parameters<DesktopAPI["onThreadRequest"]>[0] | undefined;
  let openProject: Parameters<DesktopAPI["onOpenProject"]>[0] | undefined;
  let openThread: Parameters<DesktopAPI["onOpenThread"]>[0] | undefined;
  const threadAnswers: ThreadResponse[] = [];
  let unsubscribed = false;
  const api: DesktopAPI = {
    ...mobileDesktopStub, ...engineDesktopStub, openFolder: async () => null,
    registerProject: async (root) => ({ id: root, kind: "project", root }),
    onOpenProject: (next) => { openProject = next; return () => {}; },
    onOpenThread: (next) => { openThread = next; return () => {}; },
    cliStatus: async () => ({ state: "missing", path: "/usr/local/bin/aic" }),
    installCli: async () => ({ state: "installed", path: "/usr/local/bin/aic" }),
    uninstallCli: async () => ({ state: "missing", path: "/usr/local/bin/aic" }),
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/scratch" }),
    commands: async () => ({ status: "available", commands: [] }),
    computerUsePermissions: async () => ({ accessibility: true, screenRecording: true }),
    planUsage: async () => ({ status: "not-applicable" }),
    enableComputerUse: async () => ({ accessibility: false, screenRecording: false }),
    restartForComputerUse() {},
    changedFiles: async () => ({ status: "available", files: [], branch: "main", baseline: null, additions: 0, deletions: 0 }),
    branches: async () => ({ status: "available", branches: ["main", "fix-loader", "feature-x"], remotes: ["origin/main"], current: "main" }),
    pullRequest: async () => ({ status: "none" }) as const,
    diffSummary: async (_workspaceId, range, ignoreWhitespace = false) => ({ status: "available", range, ignoreWhitespace, files: [], additions: 0, deletions: 0 }),
    diffPatch: async () => ({ status: "available", patch: "" }),
    checkoutBranch: async () => {},
    createBranch: async () => {},
    createWorktree: async () => ({ id: "wt1", root: "/worktrees/repo-wt1", workspaceId: "worktree-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 }),
    listManagedWorktrees: async () => [], revealWorktree: async () => {}, releaseWorktree: async () => ({ commit: null, shortCommit: null, ref: null }),
    saveAttachment: async () => "/tmp/aicodingtool-attachments/pasted.png",
    readAttachment: async () => "iVBORw0KGgo=", preserveMessageImages: async () => undefined,
    pathForFile: () => "", describeFiles: async () => [],
    suggestTaskTitle: async () => null,
    checkForUpdates: () => {},
    loadTaskStore: async () => null,
    loadSubagentActivity: async () => [],
    persistTaskStore: async (delta) => { persisted.push(delta); },
    send: (command) => sent.push(command),
    onAgentEvent: (next) => { listener = next; return () => { unsubscribed = true; }; },
    listAutomations: async () => [],
    saveAutomation: async (draft) => ({ ...draft, id: "automation-1", paused: false, createdAt: 1, updatedAt: 1, runCount: 0, nextRunAt: 2 }),
    updateAutomation: async (taskId, patch) => { automationChanges.push({ taskId, patch }); return automationView({ taskId, ...patch, updatedAt: 2 }); },
    deleteAutomation: async (taskId) => { automationChanges.push({ taskId, deleted: true }); return true; },
    runAutomationNow: async () => "succeeded",
    onAutomationsChanged: (next) => { automationsChanged = next; return () => {}; },
    onAutomationFire: (next) => { fireAutomation = next; return () => {}; },
    acknowledgeAutomation: (ack) => acknowledged.push(ack),
    onThreadRequest: (next) => { threadRequested = next; return () => {}; },
    answerThreadRequest: (response) => threadAnswers.push(response),
    openBrowserTab: async (tabId, url) => { browserCalls.push(["open", tabId, url]); },
    navigateBrowser: async (tabId, url) => { browserCalls.push(["navigate", tabId, url]); },
    browserHistory: async (tabId, delta) => { browserCalls.push(["history", tabId, delta]); },
    reloadBrowser: async (tabId) => { browserCalls.push(["reload", tabId]); },
    closeBrowserTab: async (tabId) => { browserCalls.push(["close", tabId]); },
    showBrowserTab: async (tabId) => { browserCalls.push(["show", tabId]); },
    setBrowserBounds: async (bounds) => { browserCalls.push(["bounds", bounds]); },
    actInBrowser: async (tabId, action) => { browserCalls.push(["act", tabId, action]); return "Clicked"; },
    readBrowserPage: async (tabId, textLimit, timeoutMs) => {
      browserCalls.push(["read", tabId, textLimit, timeoutMs]);
      return { tabId, url: "https://example.com/", title: "Example", loading: false, text: "Hello", elements: [{ ref: "1", role: "button", name: "Go" }] };
    },
    captureBrowserPage: async (tabId, fullPage, timeoutMs) => { browserCalls.push(["capture", tabId, fullPage, timeoutMs]); return { tabId, url: "https://example.com/", title: "Example", path: "/tmp/shot.png", width: 1_200, height: 800 }; },
    clearBrowserData: async () => { browserCalls.push(["clear"]); },
    findInPage: async (tabId, query, forward, findNext) => { browserCalls.push(["find", tabId, query, forward, findNext]); },
    stopFindInPage: async (tabId) => { browserCalls.push(["stop-find", tabId]); },
    focusBrowserTab: async (tabId) => { browserCalls.push(["focus", tabId]); },
    onBrowserEvent: (next) => { browserEvent = next; return () => {}; },
    onBrowserFind: () => () => {},
    openFile: async (root, path, line) => { browserCalls.push(["open-file", root, path, line]); },
    listApps: async () => [
      { id: "cursor", label: "Cursor", kind: "editor", icon: "data:image/png;base64,AAA" },
      { id: "terminal", label: "Terminal", kind: "terminal", icon: null },
      { id: "finder", label: "Finder", kind: "files", icon: null },
    ],
    openFolderInApp: async (appId, root) => { appCalls.push([appId, root]); },
    startTerminal: async (terminalId, options) => { terminalCalls.push(["start", terminalId, options]); },
    writeTerminal: async (terminalId, data) => { terminalCalls.push(["write", terminalId, data]); },
    resizeTerminal: async (terminalId, cols, rows) => { terminalCalls.push(["resize", terminalId, cols, rows]); },
    closeTerminal: async (terminalId) => { terminalCalls.push(["close", terminalId]); },
    readTerminal: async (terminalId, options) => {
      terminalCalls.push(["read", terminalId, options]);
      return { lines: ["ready in 412 ms"], omitted: 0 };
    },
    onTerminalData: () => () => {},
    onTerminalEvent: (next) => { terminalEvent = next; return () => {}; },
    setShortcuts: (next) => { shortcuts.push(next); },
    setCaptureOptions: (options) => { captureOptions.push(options); },
    setTheme: (theme) => { themes.push(theme); },
    setShortcutCapture: (capturing) => { captures.push(capturing); },
    onShortcut: (next) => { shortcutPressed = next; return () => {}; },
    onShortcutCaptured: (next) => { shortcutCaptured = next; return () => {}; },
    onWindowScreenshot: (next) => { windowGrabbed = next; return () => {}; },
    onDesktopShortcutRefused: (next) => { shortcutRefused = next; return () => {}; },
    closeWindow: () => { browserCalls.push(["close-window"]); }, focusWindow: () => { browserCalls.push(["focus-window"]); },
    announceThread: () => {},
    setBadgeCount: () => {},
    ...overrides,
  };
  const desktop = api as FakeDesktop;
  Object.assign(desktop, {
    sent,
    persisted,
    acknowledged,
    automationChanges,
    threadAnswers,
    browserCalls,
    terminalCalls,
    shortcuts,
    themes,
    captures,
    captureOptions,
    appCalls,
    askThreads(request: ThreadRequest) { assert.ok(threadRequested); return threadRequested(request); },
    openProjectFromCli(workspace: WorkspaceRecord) { assert.ok(openProject); return openProject(workspace); },
    pressShortcut(action: string, surface: Parameters<Parameters<DesktopAPI["onShortcut"]>[0]>[0]["surface"] = "any") { assert.ok(shortcutPressed); shortcutPressed({ action, surface }); },
    captureShortcut(binding: string | null) { assert.ok(shortcutCaptured); shortcutCaptured(binding); },
  });
  Object.defineProperties(desktop, {
    listener: { get() { assert.ok(listener); return listener; } },
    automationsChanged: { get() { assert.ok(automationsChanged); return automationsChanged; } },
    fireAutomation: { get() { assert.ok(fireAutomation); return fireAutomation; } },
    grabWindow: { get() { assert.ok(windowGrabbed); return windowGrabbed; } },
    refuseShortcut: { get() { assert.ok(shortcutRefused); return shortcutRefused; } },
    browserEvent: { get() { assert.ok(browserEvent); return browserEvent; } },
    terminalEvent: { get() { assert.ok(terminalEvent); return terminalEvent; } },
    unsubscribed: { get() { return unsubscribed; } },
  });
  void openThread;
  return desktop;
}
