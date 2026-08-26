import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { Task } from "../../src/domain/task.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { ProjectSidebarProps } from "../../src/renderer/components/ProjectSidebar.tsx";
import { mobileDesktopStub } from "../support/mobile-desktop.mts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

const { App } = await import("../../src/renderer/App.tsx");
const { ProjectSidebar } = await import("../../src/renderer/components/ProjectSidebar.tsx");

function renderProjectSidebar(overrides: Partial<ProjectSidebarProps>) {
  return React.createElement(ProjectSidebar, {
    open: true,
    inactive: false,
    projects: [],
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set<string>(),
    runningTaskIds: new Set<string>(),
    blockedTaskIds: new Set<string>(),
    schedules: new Map<string, AutomationView>(),
    worktreeGroups: [],
    worktreeTaskIds: new Set<string>(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {},
    onGoForward() {},
    onNewTask() {},
    onOpenFolder() {},
    onToggleProject() {},
    onRenameProject() {},
    onEditProject() {},
    onRemoveProject() {},
    onSetMode() {},
    onSetSectionOpen() {},
    onSetOpenMenu() {},
    onSelectTask() {},
    onArchiveTask() {},
    onDismissTask() {},
    onDismissAll() {},
    onRenameTask() {},
    onMoveTask() {}, onForkTask() {},
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
    ...mobileDesktopStub, openFolder: async () => null,
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

type SeedProjectTask = Pick<Task, "id" | "title" | "updatedAt"> & Partial<Task>;

function seedProjectTasks(tasks: SeedProjectTask[]) {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: tasks.map((task) => ({
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


test("a sidebar row renames itself on a double click, and on the menu's Rename", async () => {
  seedProjectTasks([{ id: "only", title: "First task", sortIndex: 0, updatedAt: 1 }]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  const row = () => query<HTMLElement>(view.container, ".project-task-row");
  const type = async (title: string, key: string) => {
    const input = query<HTMLInputElement>(view.container, ".task-rename");
    await act(async () => {
      item(setValue).call(input, title);
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    });
  };

  await act(async () => { row().dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
  await type("Nightly audit", "Enter");
  assert.equal(view.container.querySelector(".task-rename"), null);
  assert.equal(row().textContent.includes("Nightly audit"), true);

  await act(async () => { row().dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
  assert.deepEqual([...document.querySelectorAll(".context-menu-popover > button")].map((button) => button.textContent), ["Rename", "Move to folder", "Copy link", "Fork", "Fork into a new worktree", "Archive"]);
  await act(async () => { query<HTMLButtonElement>(document, ".context-menu-popover button").click(); });
  await type("Abandoned edit", "Escape");
  assert.equal(view.container.querySelector(".task-rename"), null);
  assert.equal(row().textContent.includes("Nightly audit"), true, "Escape leaves the name the row started with");
  await view.unmount();
});


test("a folder's menu opens on its trigger and every choice closes it", async () => {
  const opened: Array<string | null> = [];
  const removed: string[] = [];
  const sidebar = (openMenu: string | null) => renderProjectSidebar({
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRenameProject() {}, onEditProject() {},
    onRemoveProject: (id) => { removed.push(id); },
    onSetMode() {}, onSetSectionOpen() {},
    onSetOpenMenu: (menu) => { opened.push(menu); },
    onSelectTask() {}, onArchiveTask() {}, onDismissTask() {}, onDismissAll() {}, onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar(null));
  const trigger = () => query<HTMLButtonElement>(view.container, '[aria-label="More options for project"]');
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  assert.equal(view.container.querySelector(".project-menu .menu-popover"), null, "a shut menu renders no list");

  await act(async () => { trigger().click(); });
  assert.deepEqual(opened, ["project:project-1"], "the trigger names the menu it opens");

  await view.render(sidebar("project:project-1"));
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  const items = [...view.container.querySelectorAll<HTMLButtonElement>(".project-menu .menu-popover button")];
  assert.deepEqual(items.map((item) => item.textContent), ["New task", "Collapse", "Edit…", "Remove"]);

  await act(async () => { item(items[3]).click(); });
  assert.deepEqual(removed, ["project-1"]);
  assert.equal(opened.at(-1), null, "choosing an item closes the menu without the item saying so");
  await view.unmount();
});


test("a folder is lifted by its own row, and lifting one leaves every folded folder folded", async () => {
  const moves: Array<[string, number]> = [];
  const projects = [{ id: "first-project", root: "/first", sortIndex: 0 }, { id: "second-project", root: "/second", sortIndex: 1 }];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects,
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onMoveTask() {},
    onMoveProject: (projectId, index) => { moves.push([projectId, index]); },
    onOpenSettings() {},
  }));

  const handle = query<HTMLElement>(view.container, '[data-rfd-drag-handle-draggable-id="second-project"]');
  assert.ok(handle.className.includes("project-row"), "the header row is the handle, so there is nothing extra to aim at");

  await act(async () => {
    handle.focus();
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", keyCode: 32, bubbles: true, cancelable: true }));
  });
  assert.equal(view.container.querySelector('[data-rfd-droppable-id="first-project"]'), null, "a folded folder holds no drop target of its own");

  await act(async () => {
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  });
  assert.deepEqual(moves, [], "an abandoned drag moves nothing");
  await view.unmount();
});


test("a thread drag leaves a folded folder folded, and opens no gap where it sits", async () => {
  const task = (id: string, projectId: string): Task => ({
    id, title: id, ...(projectId ? { projectId } : {}), executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const projects = [{ id: "open-project", root: "/open" }, { id: "shut-project", root: "/shut" }];
  const tasks = [task("open-task", "open-project"), task("shut-task", "shut-project")];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects,
    orderedTasks: tasks,
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["open-project"]),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: false, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onDismissTask() {}, onDismissAll() {}, onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  const folded = () => [...view.container.querySelectorAll('[data-rfd-droppable-id="shut-project"], .task-list')];
  assert.deepEqual(folded(), [], "a folded folder and a folded Recents render nothing to lay out");

  const handle = query<HTMLElement>(view.container, '[data-rfd-drag-handle-draggable-id="open-task"]');
  await act(async () => {
    handle.focus();
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", keyCode: 32, bubbles: true, cancelable: true }));
  });

  assert.deepEqual(folded(), [], "the drag opens no strip under either of them");
  assert.equal(view.container.querySelectorAll('[data-rfd-draggable-id="shut-task"]').length, 0, "and reveals nothing they hold");
  await act(async () => {
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  });
  await view.unmount();
});


test("an expanded folder shows ten tasks, and reveals the rest on demand", async () => {
  seedProjectTasks(Array.from({ length: 13 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    sortIndex: index,
    updatedAt: index,
  })));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const rows = () => view.container.querySelectorAll(".project-task-row");
  const showMore = () => query<HTMLButtonElement>(view.container, ".show-more");
  assert.equal(rows().length, 10);
  assert.equal(showMore().textContent, "Show 3 more");

  await act(async () => { showMore().click(); });
  assert.equal(rows().length, 13);
  assert.equal(showMore().textContent, "Show less");

  await act(async () => { showMore().click(); });
  assert.equal(rows().length, 10);
  await view.unmount();
});

test("a folder keeps the open task in view past the first ten", async () => {
  seedProjectTasks(Array.from({ length: 13 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    sortIndex: index,
    updatedAt: index,
  })));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const titles = () => [...view.container.querySelectorAll(".project-task-row > span:first-child")].map((row) => row.textContent);
  await act(async () => { query<HTMLButtonElement>(view.container, ".show-more").click(); });
  const eleventh = item([...view.container.querySelectorAll<HTMLElement>(".project-task-row")].find((row) => row.textContent.startsWith("Task 11")));
  await act(async () => { eleventh.click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, ".show-more").click(); });

  assert.equal(titles().length, 12);
  assert.equal(titles().at(-1), "Task 11");
  assert.equal(query(view.container, ".show-more").textContent, "Show 1 more");
  await view.unmount();
});


test("a folder lifts from a press on its name, which is a button", async () => {
  const moves: Array<[string, number]> = [];
  const folded: string[] = [];
  const projects = [{ id: "first-project", root: "/first", sortIndex: 0 }, { id: "second-project", root: "/second", sortIndex: 1 }];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects,
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onRemoveProject() {},
    onToggleProject: (projectId) => { folded.push(projectId); },
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onMoveTask() {},
    onMoveProject: (projectId, index) => { moves.push([projectId, index]); },
    onOpenSettings() {},
  }));

  const name = item(view.container.querySelectorAll<HTMLButtonElement>(".project-main")[1]);
  const mouse = (type: string, target: EventTarget, y: number) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: y }));
  await act(async () => { mouse("mousedown", name, 40); });
  await act(async () => { mouse("mousemove", dom.window, 4); });
  assert.ok(view.container.querySelector(".project-group.is-dragging"), "a press on the folder's name lifts it");
  await act(async () => { mouse("mouseup", dom.window, 4); });

  await act(async () => {
    mouse("mousedown", name, 40);
    mouse("mouseup", name, 40);
    name.click();
  });
  assert.deepEqual(folded, ["second-project"], "a press that goes nowhere still folds the row");
  await view.unmount();
});
