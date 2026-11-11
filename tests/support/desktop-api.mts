import assert from "node:assert/strict";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { DesktopPort, PortMembers } from "../../src/contracts/desktop-port.ts";
import type { AutomationPort } from "../../src/contracts/automation-port.ts";
import type { BrowserPort } from "../../src/contracts/browser-port.ts";
import type { CliPort } from "../../src/contracts/cli-port.ts";
import type { ComputerUsePort } from "../../src/contracts/computer-use-port.ts";
import type { DictationPort } from "../../src/contracts/dictation-port.ts";
import type { EnginePort } from "../../src/contracts/engine-port.ts";
import type { FilePort } from "../../src/contracts/file-port.ts";
import type { GitPort } from "../../src/contracts/git-port.ts";
import type { ProjectPort } from "../../src/contracts/project-port.ts";
import type { RunPort } from "../../src/contracts/run-port.ts";
import type { ShortcutPort } from "../../src/contracts/shortcut-port.ts";
import type { SimulatorPort } from "../../src/contracts/simulator-port.ts";
import type { StorePort } from "../../src/contracts/store-port.ts";
import type { TerminalPort } from "../../src/contracts/terminal-port.ts";
import type { UpdatePort } from "../../src/contracts/update-port.ts";
import type { WindowPort } from "../../src/contracts/window-port.ts";
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

type Listener<Name extends keyof DesktopAPI> = Parameters<Extract<DesktopAPI[Name], (listener: never) => unknown>>[0];

/** What the stubs were asked, and the listeners they were handed, read back through the fake. */
type Recorded = {
  sent: RunCommand[];
  persisted: TaskStoreDelta[];
  acknowledged: Array<Parameters<DesktopAPI["acknowledgeAutomation"]>[0]>;
  automationChanges: Array<{ taskId: string; patch?: AutomationPatch; deleted?: true }>;
  threadAnswers: ThreadResponse[];
  browserCalls: unknown[][];
  terminalCalls: unknown[][];
  shortcuts: Array<Parameters<DesktopAPI["setShortcuts"]>[0]>;
  themes: Array<Parameters<DesktopAPI["setTheme"]>[0]>;
  captures: boolean[];
  captureOptions: Array<Parameters<DesktopAPI["setCaptureOptions"]>[0]>;
  appCalls: unknown[][];
  unsubscribed: boolean;
  heard: {
    agent?: Listener<"onAgentEvent">;
    automationsChanged?: Listener<"onAutomationsChanged">;
    fireAutomation?: Listener<"onAutomationFire">;
    threadRequested?: Listener<"onThreadRequest">;
    openProject?: Listener<"onOpenProject">;
    openThread?: Listener<"onOpenThread">;
    browserEvent?: Listener<"onBrowserEvent">;
    terminalEvent?: Listener<"onTerminalEvent">;
    shortcutPressed?: Listener<"onShortcut">;
    shortcutCaptured?: Listener<"onShortcutCaptured">;
    windowGrabbed?: Listener<"onWindowScreenshot">;
    shortcutRefused?: Listener<"onDesktopShortcutRefused">;
  };
};

/** One capability's stub: every member of its port. */
type Stub<Port extends DesktopPort> = PortMembers<[Port]>;

const windowStub = (recorded: Recorded): Stub<WindowPort> => ({
  platform: "macos",
  windowMaterial: "none",
  setWindowGlassRegions: async () => {},
  setTheme: (theme) => { recorded.themes.push(theme); },
  closeWindow: () => { recorded.browserCalls.push(["close-window"]); },
  focusWindow: () => { recorded.browserCalls.push(["focus-window"]); },
  announceThread: () => {},
  setBadgeCount: () => {},
  openSourceLicenses: engineDesktopStub.openSourceLicenses,
  onOpenThread: (next) => { recorded.heard.openThread = next; return () => {}; },
  onWindowActive: () => () => {},
  onGlassTint: () => () => {},
});

const shortcutStub = (recorded: Recorded): Stub<ShortcutPort> => ({
  setShortcuts: (next) => { recorded.shortcuts.push(next); },
  setCaptureOptions: (options) => { recorded.captureOptions.push(options); },
  setShortcutCapture: (capturing) => { recorded.captures.push(capturing); },
  onShortcut: (next) => { recorded.heard.shortcutPressed = next; return () => {}; },
  onShortcutCaptured: (next) => { recorded.heard.shortcutCaptured = next; return () => {}; },
  onWindowScreenshot: (next) => { recorded.heard.windowGrabbed = next; return () => {}; },
  onDesktopShortcutRefused: (next) => { recorded.heard.shortcutRefused = next; return () => {}; },
});

const projectStub = (recorded: Recorded): Stub<ProjectPort> => ({
  openFolder: async () => null,
  directories: async () => [],
  registerProject: async (root) => ({ id: root, kind: "project", root }),
  onOpenProject: (next) => { recorded.heard.openProject = next; return () => {}; },
  projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/scratch" }),
  commands: async () => ({ status: "available", commands: [] }),
  openFile: async (root, path, line) => { recorded.browserCalls.push(["open-file", root, path, line]); },
  listApps: async () => [
    { id: "cursor", label: "Cursor", kind: "editor", icon: "data:image/png;base64,AAA" },
    { id: "terminal", label: "Terminal", kind: "terminal", icon: null },
    { id: "finder", label: "Finder", kind: "files", icon: null },
  ],
  openFolderInApp: async (appId, root) => { recorded.appCalls.push([appId, root]); },
});

const cliStub: Stub<CliPort> = {
  cliStatus: async () => ({ state: "missing", path: "/usr/local/bin/aic" }),
  installCli: async () => ({ state: "installed", path: "/usr/local/bin/aic" }),
  uninstallCli: async () => ({ state: "missing", path: "/usr/local/bin/aic" }),
};

const computerUseStub: Stub<ComputerUsePort> = {
  computerUsePermissions: async () => ({ accessibility: true, screenRecording: true }),
  enableComputerUse: async () => ({ accessibility: false, screenRecording: false }),
  restartForComputerUse() {},
};

const engineStub: Stub<EnginePort> = {
  engineStatus: engineDesktopStub.engineStatus,
  signInEngine: engineDesktopStub.signInEngine,
  updateEngine: engineDesktopStub.updateEngine,
  planUsage: async () => ({ status: "not-applicable" }),
  suggestTaskTitle: async () => null,
  loadSubagentMetadata: async () => ({}),
};

const runStub = (recorded: Recorded): Stub<RunPort> => ({
  send: (command) => recorded.sent.push(command),
  onAgentEvent: (next) => { recorded.heard.agent = next; return () => { recorded.unsubscribed = true; }; },
  onThreadRequest: (next) => { recorded.heard.threadRequested = next; return () => {}; },
  answerThreadRequest: (response) => recorded.threadAnswers.push(response),
});

const gitStub: Stub<GitPort> = {
  changedFiles: async () => ({ status: "available", files: [], branch: "main", baseline: null, additions: 0, deletions: 0 }),
  branches: async () => ({ status: "available", branches: ["main", "fix-loader", "feature-x"], remotes: ["origin/main"], current: "main" }),
  commits: async (_workspaceId, hashes) => hashes,
  pullRequest: async () => ({ status: "none" }) as const,
  diffSummary: async (_workspaceId, range, ignoreWhitespace = false) => ({ status: "available", range, ignoreWhitespace, files: [], additions: 0, deletions: 0 }),
  diffPatch: async () => ({ status: "available", patch: "" }),
  checkoutBranch: async () => {},
  createBranch: async () => {},
  createWorktree: async () => ({ id: "wt1", root: "/worktrees/repo-wt1", workspaceId: "worktree-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 }),
  listManagedWorktrees: async () => [],
  revealWorktree: async () => {},
  releaseWorktree: async () => ({ commit: null, shortCommit: null, ref: null }),
};

const fileStub: Stub<FilePort> = {
  saveAttachment: async () => "/tmp/aicodingtool-attachments/pasted.png",
  readAttachment: async () => "iVBORw0KGgo=",
  readAttachmentContext: async () => null,
  preserveMessageImages: async () => undefined,
  readMessageImage: async () => ({ data: "iVBORw0KGgo=", contentType: "image/png" }),
  downloadImage: async () => undefined,
  pathForFile: () => "",
  describeFiles: async () => [],
};

const storeStub = (recorded: Recorded): Stub<StorePort> => ({
  loadTaskStore: async () => null,
  loadThreadMessages: async () => [],
  searchThreadMessages: async () => [],
  persistTaskStore: async (delta) => { recorded.persisted.push(delta); },
  loadSubagentActivity: async () => [],
});

const updateStub: Stub<UpdatePort> = {
  checkForUpdates: () => {},
  appUpdate: async () => ({ status: "idle" }) as const,
  appBuild: async () => null,
  launchedUpdate: async () => null,
  onAppUpdate: () => () => {},
  downloadUpdate: () => {},
  installUpdate: () => {},
};

const automationStub = (recorded: Recorded): Stub<AutomationPort> => ({
  listAutomations: async () => [],
  saveAutomation: async (draft) => ({ ...draft, id: "automation-1", paused: false, createdAt: 1, updatedAt: 1, runCount: 0, nextRunAt: 2 }),
  updateAutomation: async (taskId, patch) => { recorded.automationChanges.push({ taskId, patch }); return automationView({ taskId, ...patch, updatedAt: 2 }); },
  deleteAutomation: async (taskId) => { recorded.automationChanges.push({ taskId, deleted: true }); return true; },
  runAutomationNow: async () => "succeeded",
  onAutomationsChanged: (next) => { recorded.heard.automationsChanged = next; return () => {}; },
  onAutomationFire: (next) => { recorded.heard.fireAutomation = next; return () => {}; },
  acknowledgeAutomation: (ack) => recorded.acknowledged.push(ack),
});

const browserStub = ({ browserCalls, heard }: Recorded): Stub<BrowserPort> => ({
  configureBrowserPermissions: async () => {},
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
  inspectBrowserPage: engineDesktopStub.inspectBrowserPage,
  captureBrowserPage: async (tabId, fullPage, timeoutMs) => { browserCalls.push(["capture", tabId, fullPage, timeoutMs]); return { tabId, url: "https://example.com/", title: "Example", path: "/tmp/shot.png", width: 1_200, height: 800 }; },
  clearBrowserData: async () => { browserCalls.push(["clear"]); },
  listBrowserImportSources: async () => [{ id: "brave:0:Default", browser: "Brave", profile: "Personal" }],
  listBrowserImportSites: async () => [{ domain: "example.com", cookies: 2 }],
  importBrowserSites: async (sourceId, sites) => { browserCalls.push(["import", sourceId, sites]); return { imported: 2, skipped: 0 }; },
  findInPage: async (tabId, query, forward, findNext) => { browserCalls.push(["find", tabId, query, forward, findNext]); },
  stopFindInPage: async (tabId) => { browserCalls.push(["stop-find", tabId]); },
  focusBrowserTab: async (tabId) => { browserCalls.push(["focus", tabId]); },
  onBrowserEvent: (next) => { heard.browserEvent = next; return () => {}; },
  onBrowserFind: () => () => {},
});

const simulatorStub: Stub<SimulatorPort> = {
  listSimulators: async () => ({ availability: { status: "available" as const }, devices: [] }),
  bootSimulator: async () => {},
  shutdownSimulator: async () => {},
  simulatorInput: async () => {},
  describeSimulator: async (udid, device) => ({ udid, device, width: 402, height: 874, elements: [] }),
  captureSimulator: async () => ({ path: "/tmp/simulator.png", width: 1206, height: 2622 }),
  watchSimulator: async () => {},
  unwatchSimulator: async () => {},
  onSimulatorFrame: () => () => {},
};

const dictationStub: Stub<DictationPort> = {
  onDictationModel: () => () => {},
  startDictation: async () => {},
  stopDictation: async () => "",
  cancelDictation: async () => {},
  downloadDictationModel: async () => {},
  cancelDictationDownload: async () => {},
  transcribeAudio: async () => "",
  onDictationLevel: () => () => {},
};

const terminalStub = ({ terminalCalls, heard }: Recorded): Stub<TerminalPort> => ({
  startTerminal: async (terminalId, options) => { terminalCalls.push(["start", terminalId, options]); },
  writeTerminal: async (terminalId, data) => { terminalCalls.push(["write", terminalId, data]); },
  resizeTerminal: async (terminalId, cols, rows) => { terminalCalls.push(["resize", terminalId, cols, rows]); },
  closeTerminal: async (terminalId) => { terminalCalls.push(["close", terminalId]); },
  readTerminal: async (terminalId, options) => {
    terminalCalls.push(["read", terminalId, options]);
    return { lines: ["ready in 412 ms"], omitted: 0 };
  },
  terminalSnapshot: async () => null,
  readRemoteTerminal: async () => null,
  onTerminalData: () => () => {},
  onTerminalEvent: (next) => { heard.terminalEvent = next; return () => {}; },
});

export function fakeDesktop(overrides: Partial<DesktopAPI> = {}): FakeDesktop {
  const recorded: Recorded = {
    sent: [], persisted: [], acknowledged: [], automationChanges: [], threadAnswers: [], browserCalls: [], terminalCalls: [],
    shortcuts: [], themes: [], captures: [], captureOptions: [], appCalls: [], unsubscribed: false, heard: {},
  };
  const { heard } = recorded;
  const api: DesktopAPI = {
    ...mobileDesktopStub,
    ...windowStub(recorded), ...shortcutStub(recorded), ...projectStub(recorded), ...cliStub, ...computerUseStub, ...engineStub,
    ...runStub(recorded), ...gitStub, ...fileStub, ...storeStub(recorded), ...updateStub, ...automationStub(recorded),
    ...browserStub(recorded), ...simulatorStub, ...dictationStub, ...terminalStub(recorded),
    ...overrides,
  };
  const desktop = api as FakeDesktop;
  Object.assign(desktop, {
    sent: recorded.sent,
    persisted: recorded.persisted,
    acknowledged: recorded.acknowledged,
    automationChanges: recorded.automationChanges,
    threadAnswers: recorded.threadAnswers,
    browserCalls: recorded.browserCalls,
    terminalCalls: recorded.terminalCalls,
    shortcuts: recorded.shortcuts,
    themes: recorded.themes,
    captures: recorded.captures,
    captureOptions: recorded.captureOptions,
    appCalls: recorded.appCalls,
    askThreads(request: ThreadRequest) { assert.ok(heard.threadRequested); return heard.threadRequested(request); },
    openProjectFromCli(workspace: WorkspaceRecord) { assert.ok(heard.openProject); return heard.openProject(workspace); },
    pressShortcut(action: string, surface: Parameters<Parameters<DesktopAPI["onShortcut"]>[0]>[0]["surface"] = "any") { assert.ok(heard.shortcutPressed); heard.shortcutPressed({ action, surface }); },
    captureShortcut(binding: string | null) { assert.ok(heard.shortcutCaptured); heard.shortcutCaptured(binding); },
  });
  Object.defineProperties(desktop, {
    listener: { get() { assert.ok(heard.agent); return heard.agent; } },
    automationsChanged: { get() { assert.ok(heard.automationsChanged); return heard.automationsChanged; } },
    fireAutomation: { get() { assert.ok(heard.fireAutomation); return heard.fireAutomation; } },
    grabWindow: { get() { assert.ok(heard.windowGrabbed); return heard.windowGrabbed; } },
    refuseShortcut: { get() { assert.ok(heard.shortcutRefused); return heard.shortcutRefused; } },
    browserEvent: { get() { assert.ok(heard.browserEvent); return heard.browserEvent; } },
    terminalEvent: { get() { assert.ok(heard.terminalEvent); return heard.terminalEvent; } },
    unsubscribed: { get() { return recorded.unsubscribed; } },
  });
  return desktop;
}
