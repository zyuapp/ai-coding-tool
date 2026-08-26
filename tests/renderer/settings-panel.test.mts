import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { CliStatus } from "../../src/domain/cli.ts";
import type { PlanUsage } from "../../src/domain/plan-usage.ts";
import type { Subagent } from "../../src/domain/run.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { SettingsPanelProps } from "../../src/renderer/components/SettingsPanel.tsx";
import { mobileDesktopStub, mobileSettingsProps } from "../support/mobile-desktop.mts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

const { App } = await import("../../src/renderer/App.tsx");
const { SettingsPanel } = await import("../../src/renderer/components/SettingsPanel.tsx");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

type SettingsTestOverrides = Partial<SettingsPanelProps> & {
  captureSound?: boolean;
  captureFocus?: boolean;
  onSetTheme?: () => void;
  onSetCaptureOptions?: () => void;
};

function renderSettingsPanel(overrides: SettingsTestOverrides) {
  return React.createElement(SettingsPanel, {
    onClose() {},
    archivedTasks: [], managedWorktrees: [], worktreeManagementError: null, worktreeManagementNotice: null,
    theme: "aicodingtool-dark",
    themeMode: "auto",
    uiFont: "system",
    monoFont: "system",
    readingSize: 15,
    terminalSize: 13,
    allowedOrigins: [],
    plainEnglish: false, chromeBrowser: false, computerUse: true, browserTools: true, notifications: true,
    shortcuts: [],
    capturingShortcut: null,
    onSetThemeFamily() {},
    onSetThemeMode() {},
    onSetUiFont() {},
    onSetMonoFont() {},
    onSetReadingSize() {},
    onSetTerminalSize() {},
    onSetPlainEnglish() {}, onSetChromeBrowser() {}, onSetComputerUse() {}, onSetBrowserTools() {}, onSetNotifications() {},
    onRestoreTask() {}, onClearArchive() {}, onRefreshWorktrees() {}, onRevealWorktree() {}, onDeleteWorktree() {},
    onClearBrowserData() {},
    onCaptureShortcut() {},
    onSetShortcut() {},
    onResetShortcuts() {}, ...mobileSettingsProps,
    ...overrides,
  });
}

const subagents: Subagent[] = [
  { id: "working", description: "Working agent", status: "working", lastToolName: "Read", totalTokens: 321, startedAt: 1, activity: [] },
  { id: "complete", description: "Complete agent", status: "completed", summary: "Done", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "failed", description: "Failed agent", status: "failed", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "stopped", description: "Stopped agent", status: "stopped", startedAt: 1, finishedAt: 2, activity: [] },
];

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
    diffSummary: async (workspaceId, range) => ({ status: "available", range, ignoreWhitespace: false, files: [], additions: 0, deletions: 0 }),
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

function seedTaskWithSubagent() {
  const task = {
    id: "task-with-agent",
    title: "Inspect",
    executionPolicy: "confirm",
    messages: [],
    subagents: [subagents[1]],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 2,
  };
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [task] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
}

/** Opens settings on one of its pages, named the way its sidebar names it. */
type MountView = Awaited<ReturnType<typeof mount>>;

async function openSettingsPage(view: MountView, name: string) {
  await act(async () => { query<HTMLButtonElement>(view.container, ".sidebar-settings").click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === name)).click(); });
}

test("the general section installs the aic command and takes it back", async () => {
  const calls: string[] = [];
  let status: CliStatus = { state: "missing", path: "/usr/local/bin/aic" };
  window.desktop = fakeDesktop({
    cliStatus: async () => status,
    installCli: async () => { calls.push("install"); status = { state: "installed", path: "/usr/local/bin/aic" }; return status; },
    uninstallCli: async () => { calls.push("uninstall"); status = { state: "missing", path: "/usr/local/bin/aic" }; return status; },
  });
  const view = await mount(renderSettingsPanel({ onClose() {}, archivedTasks: [], theme: "aicodingtool-dark", allowedOrigins: [], shortcuts: [], captureSound: true, captureFocus: true, capturingShortcut: null, onSetTheme() {}, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onSetCaptureOptions() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => {});
  const button = () => query<HTMLButtonElement>(view.container, ".setting-row-action button");
  assert.match(view.container.textContent, /Terminal command/);
  assert.equal(button().textContent, "Install");

  await act(async () => { button().click(); });
  assert.equal(button().textContent, "Uninstall");
  assert.match(view.container.textContent, /Installed at \/usr\/local\/bin\/aic/);

  await act(async () => { button().click(); });
  assert.deepEqual(calls, ["install", "uninstall"]);
  assert.equal(button().textContent, "Install");
  await view.unmount();
});

test("an install the password prompt refuses is reported, not swallowed", async () => {
  window.desktop = fakeDesktop({ installCli: async () => { throw new Error("Cancelled."); } });
  const view = await mount(renderSettingsPanel({ onClose() {}, archivedTasks: [], theme: "aicodingtool-dark", allowedOrigins: [], shortcuts: [], captureSound: true, captureFocus: true, capturingShortcut: null, onSetTheme() {}, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onSetCaptureOptions() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => {});
  await act(async () => { query<HTMLButtonElement>(view.container, ".setting-row-action button").click(); });

  assert.match(query(view.container, ".settings-error").textContent, /Cancelled/);
  assert.equal(query(view.container, ".setting-row-action button").textContent, "Install");
  await view.unmount();
});

test("computer-use settings refresh permissions", async () => {
  let restarted = false;
  let checks = 0;
  const requested: Array<Parameters<DesktopAPI["enableComputerUse"]>[0]> = [];
  window.desktop = fakeDesktop({
    enableComputerUse: async (permission) => {
      requested.push(permission);
      return { accessibility: false, screenRecording: false };
    },
    computerUsePermissions: async () => item([
      { accessibility: false, screenRecording: false },
      { accessibility: true, screenRecording: true },
    ][checks++]),
    restartForComputerUse: () => { restarted = true; },
  });
  const view = await mount(renderSettingsPanel({ onClose() {}, initialSection: "computer-use", archivedTasks: [], allowedOrigins: [], shortcuts: [], capturingShortcut: null, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => {});
  assert.match(view.container.textContent, /Accessibility/);
  assert.match(view.container.textContent, /Setup required/);
  assert.match(view.container.textContent, /Enable Accessibility/);
  assert.match(view.container.textContent, /Enable Screen Recording/);
  const buttons = query<HTMLElement>(view.container, "[aria-labelledby='permissions-heading']").querySelectorAll<HTMLButtonElement>(".setting-row-action button");
  assert.equal(buttons.length, 2);
  await act(async () => { item(buttons[0]).click(); });
  await act(async () => { item(buttons[1]).click(); });
  assert.deepEqual(requested, ["accessibility", "screenRecording"]);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.match(view.container.textContent, /Setup complete/);
  assert.equal(view.container.querySelectorAll(".setting-row-action em.granted").length, 2);
  assert.match(view.container.textContent, /Done/);
  assert.match(view.container.textContent, /Restart AI Coding Tool/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-restart button").click(); });
  assert.equal(restarted, true);
  await view.unmount();
});

test("the usage section draws a bar per plan window, and reports a reader that cannot answer", async () => {
  const windows: PlanUsage = {
    status: "available",
    subscription: "max",
    windows: [
      { id: "five_hour", label: "Current session", utilization: 17, resetsAt: "2026-08-18T08:19:00Z" },
      { id: "model:Fable", label: "Current week (Fable)", utilization: 96, resetsAt: null },
    ],
  };
  let answer: PlanUsage = windows;
  window.desktop = fakeDesktop({ planUsage: async () => answer });
  const view = await mount(renderSettingsPanel({ onClose() {}, archivedTasks: [], theme: "aicodingtool-dark", allowedOrigins: [], shortcuts: [], captureSound: true, captureFocus: true, capturingShortcut: null, onSetTheme() {}, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onSetCaptureOptions() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "Usage")).click(); });

  assert.match(view.container.textContent, /Max plan/);
  assert.match(view.container.textContent, /Current session/);
  assert.match(view.container.textContent, /17% used/);
  assert.match(view.container.textContent, /96% used/);
  const fills = view.container.querySelectorAll<HTMLElement>(".usage-window-fill");
  assert.equal(fills.length, 2);
  assert.equal(item(fills[0]).style.width, "17%");
  assert.equal(item(fills[0]).classList.contains("high"), false);
  assert.equal(item(fills[1]).classList.contains("high"), true);

  answer = { status: "unavailable", message: "This build of the Claude SDK does not report plan usage." };
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-group-action button").click(); });
  assert.equal(view.container.querySelectorAll(".usage-window-fill").length, 0);
  assert.match(query(view.container, ".settings-error").textContent, /does not report plan usage/);
  await view.unmount();
});

test("a usage read that rejects reports instead of breaking the panel", async () => {
  window.desktop = fakeDesktop({ planUsage: async () => { throw new Error("Untrusted IPC sender."); } });
  const view = await mount(renderSettingsPanel({ onClose() {}, archivedTasks: [], theme: "aicodingtool-dark", allowedOrigins: [], shortcuts: [], captureSound: true, captureFocus: true, capturingShortcut: null, onSetTheme() {}, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onSetCaptureOptions() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "Usage")).click(); });

  assert.match(query(view.container, ".settings-error").textContent, /Untrusted IPC sender/);
  await view.unmount();
});

test("the appearance page sets the families through its pickers, and the sizes are px the window writes onto the root", async () => {
  localStorage.clear();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Appearance");

  const root = dom.window.document.documentElement;
  assert.equal(root.dataset.uiFont, "system");
  assert.equal(root.style.getPropertyValue("--text-content"), "15px");

  const control = (label: string) => query<HTMLButtonElement>(view.container, `button[aria-label="${label}"]`);
  const pick = async (picker: string, name: string) => {
    await act(async () => { control(picker).click(); });
    await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".font-select-list button")].find((option) => option.textContent.includes(name))).click(); });
  };
  await pick("Interface font", "Inter");
  assert.equal(root.dataset.uiFont, "inter");
  assert.equal(view.container.querySelector(".font-select-popover"), null, "choosing closes the picker");
  await pick("Code and terminal font", "JetBrains Mono");
  assert.equal(root.dataset.monoFont, "jetbrains-mono");

  for (let click = 0; click < 4; click += 1) await act(async () => { control("Larger conversation text size").click(); });
  await act(async () => { control("Smaller terminal text size").click(); });
  assert.equal(root.style.getPropertyValue("--text-content"), "19px");
  assert.equal(root.style.getPropertyValue("--terminal-text"), "11px");

  const stored = JSON.parse(item(localStorage.getItem("aicodingtool.view-preferences.v1")));
  assert.deepEqual(
    { uiFont: stored.uiFont, monoFont: stored.monoFont, readingSize: stored.readingSize, terminalSize: stored.terminalSize },
    { uiFont: "inter", monoFont: "jetbrains-mono", readingSize: 19, terminalSize: 11 },
  );
  await view.unmount();
});

test("a size typed into the field is clamped to the range, and Escape abandons the typing", async () => {
  localStorage.clear();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Appearance");

  const root = dom.window.document.documentElement;
  const field = query<HTMLInputElement>(view.container, 'input[aria-label="Conversation text size"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  const type = async (text: string) => {
    await act(async () => { field.focus(); });
    await act(async () => {
      item(setValue).call(field, text);
      field.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    });
  };
  const leave = async () => { await act(async () => { field.blur(); }); };

  await type("40");
  await leave();
  assert.equal(root.style.getPropertyValue("--text-content"), "24px", "a typed size lands on the nearest px the range allows");
  assert.equal(field.value, "24", "the field settles on the size that was kept");

  await type("13");
  await act(async () => { field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(root.style.getPropertyValue("--text-content"), "24px", "Escape keeps the settled size");
  assert.equal(JSON.parse(item(localStorage.getItem("aicodingtool.view-preferences.v1"))).readingSize, 24);
  await view.unmount();
});

test("a size stored as a rung the app used to offer reopens at the px that rung drew at", async () => {
  localStorage.clear();
  localStorage.setItem("aicodingtool.view-preferences.v1", JSON.stringify({ readingSize: "larger", terminalSize: "small" }));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  const root = dom.window.document.documentElement;
  assert.equal(root.style.getPropertyValue("--text-content"), "19px");
  assert.equal(root.style.getPropertyValue("--terminal-text"), "11px");
  await view.unmount();
});

test("the appearance page picks a theme and a ground separately, and each click paints the window", async () => {
  localStorage.clear();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await openSettingsPage(view, "Appearance");

  const root = dom.window.document.documentElement;
  assert.equal(root.dataset.theme, "aicodingtool-dark");

  const card = (family: string) => item([...view.container.querySelectorAll<HTMLButtonElement>(".theme-choice")].find((choice) => choice.textContent.includes(family)));
  /** The tiles live in a popover, so the row is opened before one of them can be picked. */
  await act(async () => { item(view.container.querySelector<HTMLButtonElement>(".theme-select > button")).click(); });
  await act(async () => { card("Gruvbox").click(); });
  assert.equal(root.dataset.theme, "gruvbox-dark");

  /** The ground is the other axis: it moves within the theme rather than replacing it. */
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".segmented button")].find((button) => button.textContent === "Light")).click(); });
  assert.equal(root.dataset.theme, "gruvbox-light");

  const stored = JSON.parse(item(localStorage.getItem("aicodingtool.view-preferences.v1")));
  assert.deepEqual({ theme: stored.theme, themeMode: stored.themeMode }, { theme: "gruvbox-light", themeMode: "light" });
  await view.unmount();
});

test("computer-use setup events open settings directly", async () => {
  localStorage.clear();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;

  await act(async () => {
    item(setValue).call(textarea, "Use the Calculator app");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Use the Calculator app" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').click(); });
  const start = startCommand(desktop.sent[0]);
  await act(async () => {
    desktop.listener({ type: "computer-use.setup-required", taskId: start.taskId, runId: start.runId, sequence: 1 });
  });

  assert.ok(view.container.querySelector(".settings-view"));
  assert.equal(view.container.querySelector(".computer-use-card"), null);
  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-back").click(); });
  assert.equal(view.container.querySelector(".settings-view"), null);
  await view.unmount();
});

test("settings rebind a shortcut, and the window is told what to match", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  assert.deepEqual(desktop.shortcuts, [{}], "the window starts out matching the defaults");

  await act(async () => { query<HTMLButtonElement>(view.container, ".sidebar-settings").click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "Shortcuts")).click(); });
  const row = (label: string) => item([...view.container.querySelectorAll<HTMLElement>(".shortcut-row")].find((element) => query(element, "strong").textContent === label));
  const keys = (label: string) => [...query(row(label), "kbd").querySelectorAll(".shortcut-key")].map((key) => key.textContent);
  /** jsdom is no Mac, so the panel spells its modifiers out rather than drawing them. */
  assert.deepEqual(keys("Allow"), ["Ctrl", "Shift", "A"]);

  await act(async () => { item([...row("Allow").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Change")).click(); });
  assert.match(row("Allow").textContent, /Press a keystroke…/);
  assert.deepEqual(desktop.captures, [true]);

  await act(async () => { desktop.captureShortcut("Mod+Shift+K"); });
  assert.deepEqual(keys("Allow"), ["Ctrl", "Shift", "K"]);
  assert.deepEqual(desktop.captures, [true, false], "the window goes back to acting on keystrokes");
  assert.deepEqual(item(desktop.shortcuts.at(-1)), { "run.allow": "Mod+Shift+K" });

  /** Taking a keystroke that another action holds leaves that action with none. */
  await act(async () => { item([...row("Deny").querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Change")).click(); });
  await act(async () => { desktop.captureShortcut("Mod+Shift+K"); });
  assert.deepEqual(keys("Deny"), ["Ctrl", "Shift", "K"]);
  assert.match(row("Allow").textContent, /Not set/);
  assert.deepEqual(item(desktop.shortcuts.at(-1)), { "run.allow": null, "run.deny": "Mod+Shift+K" });

  await act(async () => { query<HTMLButtonElement>(view.container, ".settings-group-action button").click(); });
  assert.deepEqual(keys("Allow"), ["Ctrl", "Shift", "A"]);
  assert.deepEqual(item(desktop.shortcuts.at(-1)), {});

  await view.unmount();
});

const capabilitySwitch = (root: ParentNode, section: string) =>
  query<HTMLButtonElement>(root, `[aria-labelledby='${section}-heading'] .setting-row-action button`);

test("each capability page carries a switch that turns the whole capability off", async () => {
  const changed: Array<[string, boolean]> = [];
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({
    initialSection: "computer-use",
    onSetComputerUse: (enabled) => changed.push(["computer-use", enabled]),
    onSetBrowserTools: (enabled) => changed.push(["browser-tools", enabled]),
  }));
  await act(async () => {});

  assert.equal(capabilitySwitch(view.container, "computer-use").getAttribute("aria-checked"), "true");
  await act(async () => { capabilitySwitch(view.container, "computer-use").click(); });

  const browserTab = item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === "Browser"));
  await act(async () => { browserTab.click(); });
  assert.equal(capabilitySwitch(view.container, "browser-tools").getAttribute("aria-checked"), "true");
  await act(async () => { capabilitySwitch(view.container, "browser-tools").click(); });

  assert.deepEqual(changed, [["computer-use", false], ["browser-tools", false]]);
  await view.unmount();
});

test("a switch that is off says so and offers to turn it back on", async () => {
  window.desktop = fakeDesktop({});
  const view = await mount(renderSettingsPanel({ initialSection: "computer-use", computerUse: false }));
  await act(async () => {});
  assert.equal(capabilitySwitch(view.container, "computer-use").getAttribute("aria-checked"), "false");
  assert.equal(capabilitySwitch(view.container, "computer-use").textContent, "Turn on");
  await view.unmount();
});
