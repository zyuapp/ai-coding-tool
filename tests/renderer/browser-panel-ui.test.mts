import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { Subagent } from "../../src/domain/run.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import { mobileDesktopStub } from "../support/mobile-desktop.mts";
import { dom, item, mount, place, placed, query } from "../support/renderer-dom.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await import("../../src/renderer/App.tsx");
const { ImageAnnotator } = await import("../../src/renderer/components/ImageAnnotator.tsx");

const subagents: Subagent[] = [
  { id: "working", description: "Working agent", status: "working", lastToolName: "Read", totalTokens: 321, startedAt: 1, activity: [] },
  { id: "complete", description: "Complete agent", status: "completed", summary: "Done", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "failed", description: "Failed agent", status: "failed", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "stopped", description: "Stopped agent", status: "stopped", startedAt: 1, finishedAt: 2, activity: [] },
];

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

function callNamed(calls: unknown[][], name: string): unknown[] {
  return item(calls.find((call) => call[0] === name));
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") assert.fail("Expected a string");
  return value;
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

type BrowserReadResult = import("../../src/contracts/threads.ts").BrowserReadResult;

function responseResult(response: ThreadResponse | undefined): unknown {
  const actual = item(response);
  if (!actual.ok) assert.fail(actual.message);
  return actual.result;
}

function responseRecord(response: ThreadResponse | undefined): Record<string, unknown> {
  const result = responseResult(response);
  assert.ok(result !== null && typeof result === "object" && !Array.isArray(result));
  return result as Record<string, unknown>;
}

function browserReadResult(response: ThreadResponse | undefined): BrowserReadResult {
  const result = responseRecord(response);
  assert.ok(["tabs", "snapshot", "awaiting-approval", "no-tab"].includes(String(result.kind)));
  return result as BrowserReadResult;
}

test("the browser panel drives the page through the workspace and reports where it is drawn", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel")).click(); });

  const address = query<HTMLInputElement>(view.container, '.browser-bar input[aria-label="Address"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => {
    item(setValue).call(address, "example.com/docs");
    address.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "example.com/docs" }));
  });
  await act(async () => { address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });

  const opened = callNamed(desktop.browserCalls, "open");
  const tabId = stringValue(opened[1]);
  assert.deepEqual(callNamed(desktop.browserCalls, "navigate"), ["navigate", tabId, "https://example.com/docs"], "the blank tab the launcher made is the one that loads");
  assert.deepEqual(callNamed(desktop.browserCalls, "show").slice(0, 1), ["show"]);
  assert.ok(desktop.browserCalls.some((call) => call[0] === "bounds"), "the panel reports its rectangle to main");

  await act(async () => {
    desktop.browserEvent({ tabId, url: "https://example.com/docs", title: "Docs", loading: false, canGoBack: true });
  });
  assert.match(query(view.container, ".right-dock-tab.active").textContent, /Docs/, "a page names its own dock tab");

  await act(async () => { query<HTMLButtonElement>(view.container, '.browser-bar button[aria-label="Back"]').click(); });
  assert.deepEqual(desktop.browserCalls.at(-1), ["history", tabId, -1]);

  await view.unmount();
  assert.deepEqual(desktop.browserCalls.at(-1), ["bounds", null], "an unmounted panel leaves no page drawn over the app");
});

test("anything the document draws over the page takes it off screen", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const drawn = () => desktop.browserCalls.at(-1);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel")).click(); });

  const box = place(".browser-viewport", { x: 0, y: 50, width: 400, height: 600 });
  place('.right-dock-add div[role="menu"]', { x: 0, y: 0, width: 400, height: 200 });
  place(".annotator", { x: 0, y: 0, width: 1200, height: 800 });
  await act(async () => { window.dispatchEvent(new Event("resize")); });
  await settle();
  assert.deepEqual(drawn(), ["bounds", box], "an uncovered panel draws the page where it is");

  const add = query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]');
  await act(async () => { add.click(); });
  await settle();
  assert.deepEqual(drawn(), ["bounds", null], "the page is not drawn while the menu hangs over it");
  await act(async () => { add.click(); });
  await settle();
  assert.deepEqual(drawn(), ["bounds", box], "closing the menu draws the page again");

  /** A modal opened somewhere else entirely, which nothing here was told about. */
  const modal = await mount(React.createElement(ImageAnnotator, { source: "data:image/png;base64,x", annotations: [], onCancel: () => {}, onApply: () => {} }));
  await settle();
  assert.deepEqual(drawn(), ["bounds", null], "a modal covers the page without the panel naming it");
  await modal.unmount();
  await settle();
  assert.deepEqual(drawn(), ["bounds", box], "closing the modal draws the page again");

  await view.unmount();
  placed.length = 0;
});

test("⌘W closes the page in front, then the dock, and only then the window", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel")).click(); });

  const address = query<HTMLInputElement>(view.container, '.browser-bar input[aria-label="Address"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => {
    item(setValue).call(address, "example.com");
    address.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "example.com" }));
  });
  await act(async () => { address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 1);

  await act(async () => { desktop.pressShortcut("tab.close"); });
  assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 0, "the page is the tab, so it goes first");
  assert.equal(view.container.querySelector(".browser-panel"), null);

  await act(async () => { desktop.pressShortcut("tab.close"); });
  assert.equal(query<HTMLElement>(view.container, ".right-dock").hidden, true, "then the dock");

  assert.deepEqual(desktop.browserCalls.filter((call) => call[0] === "close-window"), []);
  await act(async () => { desktop.pressShortcut("tab.close"); });
  assert.deepEqual(desktop.browserCalls.filter((call) => call[0] === "close-window"), [["close-window"]], "with nothing in front, ⌘W is the window's");

  await view.unmount();
});

test("a run reads the page through the window and is told when a site is waiting on the user", async () => {
  const desktop = fakeDesktop();
  const harness = await mountWorkspace(desktop);

  await act(async () => { await harness.get().dispatch({ type: "view.set-prompt", prompt: "look at the dashboard" }); });
  await act(async () => { await harness.get().dispatch({ type: "task.send" }); });
  const taskId = item(harness.get().currentTask).id;
  await act(async () => { await harness.get().dispatch({ type: "browser.open", url: "https://example.com" }); });
  const tabId = item(harness.get().browserTabs[0]).id;

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "read-1", taskId, op: "browser", read: { op: "tabs" } }); });
  const tabs = browserReadResult(desktop.threadAnswers.at(-1));
  if (tabs.kind !== "tabs") assert.fail("Expected the browser tab list");
  assert.deepEqual(tabs.tabs.map((tab) => tab.id), [tabId]);

  /** A page belongs to the thread whose dock holds it, so no other thread reads it. */
  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "read-2", taskId: "elsewhere", op: "browser", read: { op: "tabs" } }); });
  const elsewhere = browserReadResult(desktop.threadAnswers.at(-1));
  if (elsewhere.kind !== "tabs") assert.fail("Expected the browser tab list");
  assert.deepEqual(elsewhere.tabs, []);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "read-3", taskId, op: "browser", read: { op: "snapshot", timeoutMs: 5_000, textLimit: 500 } });
  });
  assert.deepEqual(desktop.browserCalls.at(-1), ["read", tabId, 500, 5_000]);
  const snapshot = browserReadResult(desktop.threadAnswers.at(-1));
  if (snapshot.kind !== "snapshot") assert.fail("Expected a browser snapshot");
  assert.equal(snapshot.snapshot.title, "Example");

  /** A run asking for a site nobody has allowed is answered with the ask, not with a page. */
  await act(async () => { await harness.get().dispatch({ type: "browser.open", taskId, url: "https://dash.example.com" }); });
  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "read-4", taskId, op: "browser", read: { op: "snapshot", timeoutMs: 1_000 } });
  });
  assert.deepEqual(browserReadResult(desktop.threadAnswers.at(-1)), { kind: "awaiting-approval", url: "https://dash.example.com/" });

  await harness.view.unmount();
});
