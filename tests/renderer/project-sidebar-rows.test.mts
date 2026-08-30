import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { Thread } from "../../src/domain/thread.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { ProjectSidebarProps } from "../../src/renderer/components/ProjectSidebar.tsx";
import { engineDesktopStub, mobileDesktopStub } from "../support/mobile-desktop.mts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { MAC } from "../../src/renderer/platform.ts";
import { settleFrame } from "../support/settle.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await import("../../src/renderer/App.tsx");
const { ProjectSidebar } = await import("../../src/renderer/components/ProjectSidebar.tsx");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

type TaskWorkspace = ReturnType<typeof useTaskWorkspace>;

async function mountWorkspace(desktop: DesktopAPI) {
  localStorage.clear();
  window.desktop = desktop;
  let latest: TaskWorkspace | undefined;
  function Harness() {
    latest = useTaskWorkspace();
    return null;
  }
  const view = await mount(React.createElement(Harness));
  return { view, get: () => item(latest) };
}

function renderProjectSidebar(overrides: Partial<ProjectSidebarProps>) {
  return React.createElement(ProjectSidebar, {
    open: true,
    inactive: false,
    projects: [],
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set<string>(),
    runningThreadIds: new Set<string>(),
    blockedThreadIds: new Set<string>(),
    sideChatAttention: new Set<string>(),
    schedules: new Map<string, AutomationView>(),
    worktreeGroups: [],
    worktreeThreadIds: new Set<string>(),
    activityThreads: { priority: [], running: [], threads: [] },
    threadSlots: [],
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {},
    onGoForward() {},
    onNewThread() {},
    onOpenFolder() {},
    onToggleProject() {},
    onRenameProject() {},
    onEditProject() {},
    onRemoveProject() {},
    onSetMode() {},
    onSetSectionOpen() {},
    onSetOpenMenu() {},
    onSelectThread() {},
    onArchiveThread() {},
    onDismissThread() {},
    onDismissAll() {},
    onRenameThread() {},
    onMoveThread() {}, onForkThread() {},
    onMoveProject() {},
    onOpenSettings() {},
    ...overrides,
  });
}

const automationView = (overrides: Partial<AutomationView> = {}): AutomationView => ({
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


type FakeDesktop = DesktopAPI & {
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

function fakeDesktop(overrides: Partial<DesktopAPI> = {}): FakeDesktop {
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
    diffSummary: async (workspaceId, range, ignoreWhitespace = false) => ({ status: "available", range, ignoreWhitespace, files: [], additions: 0, deletions: 0 }),
    diffPatch: async () => ({ status: "available", patch: "" }),
    checkoutBranch: async () => {},
    createBranch: async () => {},
    createWorktree: async () => ({ id: "wt1", root: "/worktrees/repo-wt1", workspaceId: "worktree-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 }),
    listManagedWorktrees: async () => [], revealWorktree: async () => {}, releaseWorktree: async () => ({ commit: null, shortCommit: null, ref: null }),
    saveAttachment: async () => "/tmp/aicodingtool-attachments/pasted.png",
    readAttachment: async () => "iVBORw0KGgo=",
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

type SeedProjectThread = Pick<Thread, "id" | "title" | "updatedAt"> & Partial<Thread>;

function seedProjectTasks(tasks: SeedProjectThread[]) {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: tasks.map((task) => ({
      engine: "claude",
      executionPolicy: "confirm",
      messages: [],
      continuationStatus: "none",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      projectId: "project-1",
      ...task,
    })) }),
    projects: JSON.stringify({ version: 2, value: [{ id: "project-1", root: "/project" }] }),
    lastFolder: JSON.stringify({ version: 2, value: "/project" }),
  }));
}


test("activity mode ranks threads into priority, running, and the rest, and only priority dismisses", async () => {
  const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id, title: id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, ...overrides,
  });
  const dismissed: string[] = [];
  let clearedAll = 0;
  const view = await mount(renderProjectSidebar({
    open: true,
    inactive: false,
    projects: [{ id: "project-1", root: "/work/project" }],
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(["busy", "asked"]),
    blockedThreadIds: new Set(["asked"]),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: {
      priority: [thread("asked", { projectId: "project-1" }), thread("unread", { outcome: "finished", outcomeUnread: true }), thread("seen", { outcome: "finished" })],
      running: [thread("busy")],
      threads: [thread("quiet")],
    },
    mode: "activity",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onRenameThread() {},
    onDismissThread: (taskId) => { dismissed.push(taskId); },
    onDismissAll: () => { clearedAll += 1; },
    onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  const listed = (label: string) => [...view.container.querySelectorAll(`nav[aria-label="${label}"] .task-row-text > span`)].map((row) => row.textContent);
  assert.deepEqual(listed("Priority"), ["asked", "unread", "seen"]);
  assert.deepEqual(listed("Running"), ["busy"]);
  assert.deepEqual(listed("Threads"), ["quiet"]);
  assert.equal(view.container.querySelector('[data-rfd-draggable-id]'), null, "activity mode ranks its own rows, so none of them drag");

  assert.match(
    query(view.container, 'nav[aria-label="Priority"] .task-row-text > small').textContent,
    /^project · /,
    "a flat list still says which folder a thread lives in",
  );
  assert.deepEqual(
    [...view.container.querySelectorAll('nav[aria-label="Priority"] .task-attention.finished')].length,
    1,
    "a verdict the user has read ranks without a mark of its own",
  );
  assert.equal(
    query(view.container, 'nav[aria-label="Priority"] [aria-label="Needs approval"]').className,
    "task-attention approval",
    "a thread waiting on the user asks rather than looking merely busy",
  );
  assert.equal(view.container.querySelector('nav[aria-label="Priority"] .task-spinner'), null);

  assert.deepEqual(
    [...view.container.querySelectorAll('nav[aria-label="Priority"] .row-action')].map((button) => button.getAttribute("aria-label")),
    ["Dismiss unread", "Dismiss seen"],
    "the priority list trades archive for dismiss, and a question has nothing to dismiss",
  );
  assert.deepEqual(
    [...view.container.querySelectorAll('nav[aria-label="Running"] .row-action, nav[aria-label="Threads"] .row-action')],
    [],
    "and the other two offer nothing, rather than a second icon meaning something else",
  );

  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Dismiss seen"]').click(); });
  assert.deepEqual(dismissed, ["seen"], "a read row still offers to be filed away");

  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Dismiss all"]').click(); });
  assert.equal(clearedAll, 1);
  await view.unmount();
});

test("only the priority heading offers to dismiss every dot at once", async () => {
  const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id, title: id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, ...overrides,
  });
  const sidebar = (priority: Thread[]) => renderProjectSidebar({
    open: true,
    inactive: false,
    projects: [],
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority, running: [], threads: [] },
    mode: "activity",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onRenameThread() {}, onDismissThread() {}, onDismissAll() {},
    onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar([]));
  assert.equal(view.container.querySelector('[aria-label="Dismiss all"]'), null, "no dot to take off, so the heading offers nothing");

  await view.render(sidebar([thread("done", { outcome: "failed" })]));
  assert.ok(view.container.querySelector('[aria-label="Dismiss all"]'), "one dot is enough to offer it");
  await view.unmount();
});


test("sidebar rows hold their position no matter how recently a task ran", async () => {
  seedProjectTasks([
    { id: "top", title: "Pinned to the top", sortIndex: 0, updatedAt: 10 },
    { id: "middle", title: "Busiest task", sortIndex: 1, updatedAt: 900 },
    { id: "bottom", title: "Quietest task", sortIndex: 2, updatedAt: 400 },
  ]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const titles = () => [...view.container.querySelectorAll(".project-task-row > span:first-child")].map((row) => row.textContent);
  assert.deepEqual(titles(), ["Pinned to the top", "Busiest task", "Quietest task"]);
  await view.unmount();
});

test("the sidebar switches to activity mode, and dismissing there takes the dot off for good", async () => {
  seedProjectTasks([
    { id: "quiet", title: "Quiet task", sortIndex: 0, updatedAt: 5, createdAt: 5 },
    { id: "settled", title: "Settled task", sortIndex: 1, updatedAt: 9, createdAt: 9, outcome: "finished", outcomeUnread: true },
  ]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const toggle = () => query<HTMLButtonElement>(view.container, '[aria-label="Rank threads by activity"]');
  assert.equal(view.container.querySelector('nav[aria-label="Priority"]'), null, "the sidebar opens grouped by project");
  assert.equal(toggle().getAttribute("aria-pressed"), "false");

  await act(async () => { toggle().click(); });
  assert.equal(toggle().getAttribute("aria-pressed"), "true");

  const priority = () => [...view.container.querySelectorAll('nav[aria-label="Priority"] .task-row-text > span')].map((row) => row.textContent);
  assert.deepEqual(priority(), ["Settled task"]);
  assert.deepEqual(
    [...view.container.querySelectorAll('nav[aria-label="Threads"] .task-row-text > span')].map((row) => row.textContent),
    ["Quiet task"],
  );

  /** Opening it reads the mark off, and leaves the verdict holding its place. */
  await act(async () => { query<HTMLElement>(view.container, 'nav[aria-label="Priority"] .task-row').click(); });
  assert.deepEqual(priority(), ["Settled task"]);
  assert.equal(view.container.querySelector(".task-attention.finished"), null);

  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Dismiss Settled task"]').click(); });
  assert.deepEqual(priority(), []);
  assert.deepEqual(
    [...view.container.querySelectorAll('nav[aria-label="Threads"] .task-row-text > span')].map((row) => row.textContent),
    ["Settled task", "Quiet task"],
    "a dismissed thread drops into the chronological list",
  );

  /** The one switch carries both directions, so pressing it again puts the folders back. */
  await act(async () => { toggle().click(); });
  assert.equal(toggle().getAttribute("aria-pressed"), "false");
  assert.equal(view.container.querySelector('nav[aria-label="Priority"]'), null);
  assert.ok(view.container.querySelector(".project-list"), "the folders come back");
  await view.unmount();
});

test("opening a dotted row in projects mode takes its dot off", async () => {
  seedProjectTasks([
    { id: "open", title: "Open task", sortIndex: 0, updatedAt: 2 },
    { id: "waiting", title: "Waiting task", sortIndex: 1, updatedAt: 1, outcome: "failed", outcomeUnread: true },
  ]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const dot = view.container.querySelector(".task-attention.failed");
  assert.equal(dot?.getAttribute("aria-label"), "Failed");

  const waiting = [...view.container.querySelectorAll<HTMLElement>(".project-task-row")].find((row) => row.textContent.includes("Waiting task"));
  assert.ok(waiting);
  await act(async () => { waiting.click(); });

  assert.equal(view.container.querySelector(".task-attention.failed"), null, "reading the thread takes the dot off");
  assert.deepEqual([...view.container.querySelectorAll(".task-dismiss")], [], "projects mode never offers a dismissal");
  assert.deepEqual(
    [...view.container.querySelectorAll(".project-task-row .row-action")].map((button) => button.getAttribute("aria-label")),
    ["Archive Open task", "Archive Waiting task"],
    "archiving is a projects-mode row's only trailing action",
  );
  await view.unmount();
});

test("the sidebar lists a project's threads as one list, and its menu starts another in a checkout", async () => {
  const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id, title: id, projectId: "project-1", engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1, ...overrides,
  });
  const worktree = { id: "wt1", projectId: "project-1", root: "/worktrees/project-wt1", workspaceId: "ws-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 };
  const started: Array<[string | undefined, string | undefined]> = [];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedThreads: [thread("in-checkout", { worktreeId: "wt1" }), thread("in-project")],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [{ worktree, threads: [thread("in-checkout", { worktreeId: "wt1" })] }],
    worktreeThreadIds: new Set(["in-checkout"]),
    activityThreads: { priority: [], running: [], threads: [] },
    threadSlots: [],
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: "project:project-1",
    settingsOpen: false,
    onNewThread(projectId, worktreeId) { started.push([projectId, worktreeId]); },
    onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onDismissThread() {}, onDismissAll() {}, onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  assert.deepEqual(
    [...view.container.querySelectorAll(".project-tasks [data-rfd-draggable-id]")].map((row) => row.getAttribute("data-rfd-draggable-id")),
    ["in-checkout", "in-project"],
    "a checkout opens no list of its own, so the project holds every thread in one order",
  );
  const marked = query<HTMLElement>(view.container, '[data-rfd-draggable-id="in-checkout"] .task-worktree');
  assert.equal(marked.getAttribute("aria-label"), "Works in project-wt1", "the row's own mark says which checkout it works in");

  const menuItem = [...view.container.querySelectorAll<HTMLButtonElement>(".project-menu [role=menuitem]")].find((button) => button.textContent === "New thread in project-wt1");
  assert.ok(menuItem);
  await act(async () => { menuItem.click(); });
  assert.deepEqual(started, [["project-1", "wt1"]], "the project's menu is where a checkout it already has is started in");
  await view.unmount();
});

test("the sidebar marks each thread's engine, schedule, and checkout", async () => {
  const task = (id: string, projectId?: string, engine: Thread["engine"] = "claude"): Thread => ({
    id, title: id, ...(projectId ? { projectId } : {}), engine, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedThreads: [task("scheduled-task", "project-1"), task("plain-task", "project-1", "codex")],
    recentThreads: [task("scheduled-chat"), task("plain-chat", undefined, "codex")],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map([["scheduled-task", automationView({ taskId: "scheduled-task" })], ["scheduled-chat", automationView({ taskId: "scheduled-chat" })]]),
    worktreeGroups: [],
    worktreeThreadIds: new Set(["plain-task"]),
    activityThreads: { priority: [], running: [], threads: [] },
    threadSlots: [],
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onDismissThread() {}, onDismissAll() {}, onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  const marks = (label: string) => [...view.container.querySelectorAll(`[aria-label="${label}"]`)]
    .map((icon) => item(icon.closest("[data-rfd-draggable-id]")).getAttribute("data-rfd-draggable-id"))
    .sort();

  assert.deepEqual(marks("Runs on a schedule"), ["scheduled-chat", "scheduled-task"]);
  assert.deepEqual(marks("Works in a worktree"), ["plain-task"], "a thread with its own checkout is marked wherever it is listed");
  assert.deepEqual(marks("Claude thread"), ["scheduled-chat", "scheduled-task"]);
  assert.deepEqual(marks("Codex thread"), ["plain-chat", "plain-task"]);
  await view.unmount();
});

test("holding the command key numbers the threads a digit reaches", async () => {
  const task = (id: string, projectId?: string): Thread => ({
    id, title: id, ...(projectId ? { projectId } : {}), engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const command = MAC ? "Meta" : "Control";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "project-1", root: "/project" }],
    orderedThreads: [task("first", "project-1"), task("second", "project-1")],
    recentThreads: [task("third")],
    expandedProjects: new Set(["project-1"]),
    threadSlots: ["first", "second", "third"],
  }));
  const numbers = () => [...view.container.querySelectorAll(".row-number")].map((badge) => badge.textContent);

  assert.deepEqual(numbers(), [], "nothing is numbered until the key is held");

  await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: command })); });
  assert.deepEqual(numbers(), [], "and not on the way to a chord either");

  await act(async () => { vi.advanceTimersByTime(400); });
  const held = numbers();
  const marked = query(view.container, ".sidebar").classList.contains("numbered");

  await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: command })); });
  const released = numbers();
  vi.useRealTimers();

  assert.deepEqual(held, ["1", "2", "3"], "a held key numbers the rows in the order they are drawn");
  assert.ok(marked, "and the lists open room for them");
  assert.deepEqual(released, [], "letting go takes them away");
  await view.unmount();
});

test("the sidebar follows the thread the keyboard steps to", async () => {
  const thread = (id: string): Thread => ({
    id, title: id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  });
  const scrolled: Array<{ className: string; options?: boolean | ScrollIntoViewOptions }> = [];
  const original = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ className: this.className, options }); };
  const sidebar = (currentId: string | null) => renderProjectSidebar({
    open: true,
    inactive: false,
    projects: [],
    orderedThreads: [thread("first"), thread("second")],
    recentThreads: [thread("first"), thread("second")],
    currentId,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority: [], running: [], threads: [] },
    threadSlots: [],
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onRenameThread() {},
    onDismissThread() {}, onDismissAll() {},
    onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar("first"));
  await view.render(sidebar("second"));
  dom.window.HTMLElement.prototype.scrollIntoView = original;

  assert.deepEqual(scrolled.at(-1), { className: "task-row active", options: { block: "nearest" } }, "the row now open is brought into view");
  await view.unmount();
});

test("the sidebar steps through visited threads", async () => {
  let backSteps = 0;
  const view = await mount(renderProjectSidebar({
    open: false,
    inactive: false,
    projects: [],
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority: [], running: [], threads: [] },
    threadSlots: [],
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: true,
    canGoForward: false,
    onGoBack: () => { backSteps += 1; },
    onGoForward() {},
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onDismissThread() {}, onDismissAll() {}, onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  assert.ok(query<HTMLButtonElement>(view.container, 'button[aria-label="Go forward"]').disabled, "nothing ahead to go forward to");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Go back"]').click(); });
  assert.equal(backSteps, 1);
  await view.unmount();
});

test("a run settling on the thread on screen ranks it without marking it, even behind a blurred window", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Inspect the app"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const start = startCommand(desktop.sent[0]);

  await act(async () => { window.dispatchEvent(new Event("blur")); });
  await act(async () => {
    desktop.listener({ type: "run.status", taskId: start.taskId, runId: start.runId, sequence: 1, status: "succeeded" });
  });
  await settleFrame();
  assert.equal(item(workspace.get().currentThread).outcome, "finished");
  assert.equal(item(workspace.get().currentThread).outcomeUnread, undefined);

  await act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.equal(item(workspace.get().currentThread).outcomeUnread, undefined, "and coming back finds nothing marked");
  await workspace.view.unmount();
});
