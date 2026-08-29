import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import { settleUntil } from "../support/settle.mts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { PastedText, RunAttachment } from "../../src/domain/task.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { TaskComposerProps } from "../../src/renderer/components/TaskComposer.tsx";
import { engineDesktopStub, mobileDesktopStub } from "../support/mobile-desktop.mts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

const { TaskComposer } = await import("../../src/renderer/components/TaskComposer.tsx");

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

function renderTaskComposer(overrides: Partial<TaskComposerProps>) {
  return React.createElement(TaskComposer, {
    prompt: "",
    folder: "",
    mode: "confirm",
    engine: "claude", engineLabel: "Claude",
    model: "opus",
    effort: "high",
    runActive: false,
    queuedMessages: [],
    onPromptChange() {},
    onModeChange() {},
    onModelChange() {},
    onEffortChange() {},
    onSend() {},
    onSteerQueued() {},
    onDropQueued() {},
    onCancel() {},
    ...overrides,
  });
}

test("an active native goal stays visible and can be cleared", async () => {
  let cleared = 0;
  const view = await mount(renderTaskComposer({
    goal: { objective: "All checks pass", status: "active", iterations: 2 },
    onGoalClear: () => { cleared += 1; },
  }));

  assert.match(query(view.container, ".goal-bar").textContent, /All checks pass/);
  assert.match(query(view.container, ".goal-detail").textContent, /Pass 2/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".goal-clear").click(); });
  assert.equal(cleared, 1);
  await view.unmount();
});

test("context usage stays within 100% when the window shrinks below the used tokens", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(renderTaskComposer({
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
    engine: "claude", engineLabel: "Claude",
    model: "opus",
    contextUsage: { tokens: 620_000, limit: 200_000, model: "claude-opus-5" },
    runActive: false,
    onPromptChange() {},
    onModeChange() {},
    onModelChange() {},
    queuedMessages: [],
    onSteerQueued() {},
    onDropQueued() {},
    onSend() {},
    onCancel() {},
  }));
  await act(async () => {});

  const usage = query(view.container, ".context-usage");
  assert.equal(usage.getAttribute("aria-label"), "100% of context window used");
  assert.match(usage.textContent, /100% used \(0% left\)/);
  assert.match(usage.textContent, /620K \/ 200K tokens used/);
  await view.unmount();
});

test("one outside pointer press dismisses the slash menu until the draft changes", async () => {
  window.desktop = fakeDesktop({ commands: async () => ({ status: "available", commands: [{ name: "review", description: "Review this change.", argumentHint: "" }] }) });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt, folder: "/project", workspaceId: "workspace-1", mode: "confirm", engine: "claude", engineLabel: "Claude", model: "opus", effort: "medium", runActive: false,
      onPromptChange: setPrompt, onModeChange() {}, onModelChange() {}, onEffortChange() {}, queuedMessages: [], onSteerQueued() {}, onDropQueued() {}, onSend() {}, onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  await act(async () => {
    textarea.focus();
    item(setValue).call(textarea, "/");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  assert.ok(view.container.querySelector(".command-menu"));
  await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  assert.equal(view.container.querySelector(".command-menu"), null);
  await act(async () => {
    item(setValue).call(textarea, "/r");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  assert.ok(view.container.querySelector(".command-menu"), "typing again reopens matching commands");
  await view.unmount();
});

test("a slash action runs at once and clears the draft", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues. Extra details are hidden.", argumentHint: "" },
      { name: "pdf", description: "Work with PDF files.", argumentHint: "<file>" },
    ] }),
  });
  let sends = 0;
  let opened = 0;
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      actions: [{ name: "side", description: "Open a focused side chat.", run: () => { opened += 1; } }],
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onDropQueued() {},
      onSend: () => { sends += 1; },
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  const scrolled: Array<{ id: string; options?: boolean | ScrollIntoViewOptions }> = [];
  const originalScrollIntoView = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ id: this.id, options }); };

  await act(async () => {
    textarea.focus();
    item(setValue).call(textarea, "/s");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "/s" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/side", "/security-scan"]);

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })); });
  assert.deepEqual(scrolled.at(-1), { id: "slash-command-1", options: { block: "nearest" } });
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowUp" })); });

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(opened, 1, "choosing an action performs it");
  assert.equal(textarea.value, "", "the action takes its own name out of the draft");
  assert.equal(view.container.querySelector(".command-menu"), null);
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(sends, 0, "an emptied draft has nothing to send");
  dom.window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  await view.unmount();
});

test("the up arrow recalls sent prompts and the down arrow walks back to the draft", async () => {
  window.desktop = fakeDesktop();
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      history: ["first question", "first question", "second\nquestion"].map((text) => ({ text, annotations: [], pastes: [], files: [], attachments: [] })),
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onDropQueued() {},
      onSend() {},
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  const press = (key: string) => act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })); });
  const type = (text: string) => act(async () => {
    item(setValue).call(textarea, text);
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });

  const upIs = async (expected: string, why: string) => { await press("ArrowUp"); assert.equal(textarea.value, expected, why); };
  const downIs = async (expected: string, why: string) => { await press("ArrowDown"); assert.equal(textarea.value, expected, why); };

  await act(async () => { textarea.focus(); });
  await type("a draft");
  await upIs("a draft", "up in a typed draft moves the caret, not the history");
  await type("");
  await upIs("second\nquestion", "up in an empty composer recalls the newest sent prompt");
  await upIs("second\nquestion", "up below the first line of a recalled prompt moves the caret");
  await act(async () => { textarea.setSelectionRange(0, 0); });
  await upIs("first question", "up from the first line walks back, skipping the repeated send");
  await upIs("first question", "the oldest entry is the end of the line");
  await downIs("second\nquestion", "down walks forward again");
  await downIs("", "down past the newest restores the stashed empty draft");
  await downIs("", "with no recall going, down is just a caret move");
  await press("ArrowUp");
  await type("second question edited");
  await upIs("second question edited", "editing a recalled prompt ends the recall");
  await view.unmount();
});

test("a skill completes anywhere in the draft, where an action is not offered", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues.", argumentHint: "" },
    ] }),
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      actions: [{ name: "side", description: "Open a focused side chat.", run() {} }],
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onDropQueued() {},
      onSend() {},
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  const type = async (value: string, inputType = "insertText") => {
    await act(async () => {
      textarea.focus();
      item(setValue).call(textarea, value);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  await type("look at this /s");
  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/security-scan"], "a half-written draft offers skills alone");

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(textarea.value, "look at this /security-scan", "the completion replaces the token it grew from");

  await type("src/s");
  assert.equal(view.container.querySelector(".command-menu"), null, "a path is not a command");

  await type("/s", "insertFromPaste");
  assert.equal(view.container.querySelector(".command-menu"), null, "pasted text is not typing");
  await view.unmount();
});

test("the @ menu offers threads, keeps browsing in this project, and completes to a handle", async () => {
  const threads = [
    { id: "t-1", title: "Raise the dock", handle: "raise-the-dock", project: "app", inScope: true, running: false, lastActivityAt: 3 },
    { id: "t-2", title: "Raise the panel", handle: "site/raise-the-panel", project: "site", inScope: false, running: false, lastActivityAt: 2 },
  ];
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      threads,
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onDropQueued() {},
      onSend() {},
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  const type = async (value: string) => {
    await act(async () => {
      textarea.focus();
      item(setValue).call(textarea, value);
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const offered = () => [...view.container.querySelectorAll('.thread-menu [role="option"] strong')].map((node) => node.textContent);

  await type("compare with @");
  assert.deepEqual(offered(), ["Raise the dock"], "browsing stays in this project");

  await type("compare with @raise");
  assert.deepEqual(offered(), ["Raise the dock", "Raise the panel"], "a query reaches the other projects");

  await type("compare with @panel");
  assert.deepEqual(offered(), ["Raise the panel"]);

  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(textarea.value, "compare with @site/raise-the-panel ");
  assert.equal(view.container.querySelector(".thread-menu"), null, "the menu closes once a thread is chosen");

  await type("mail me at zhuocheng@gmail");
  assert.equal(view.container.querySelector(".thread-menu"), null, "an address is not a mention");
  await view.unmount();
});

test("the side surface keeps the slash palette but never offers to fork a fork", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues.", argumentHint: "" },
    ] }),
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      surface: "side",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onDropQueued() {},
      onSend() {},
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Side chat prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  await act(async () => {
    textarea.focus();
    item(setValue).call(textarea, "/s");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "/s" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });

  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/security-scan"]);
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Send side chat message"]').disabled, false);
  await view.unmount();
});

test("a pasted image becomes an attachment chip and is saved on send", async () => {
  window.desktop = fakeDesktop();
  let sent: RunAttachment[] | null = null;
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      onPromptChange: setPrompt,
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onDropQueued() {},
      onSend: (attachments) => { sent = attachments; },
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const send = query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]');
  assert.equal(send.disabled, true);

  const paste = new dom.window.Event("paste", { bubbles: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [new dom.window.File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })] } });
  await act(async () => { query<HTMLTextAreaElement>(view.container, "textarea").dispatchEvent(paste); });
  /** Reading the file and saving it is a chain of promises, so this waits for the chip, not a tick. */
  await settleUntil(() => view.container.querySelectorAll(".attachment-chip").length === 1);
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').disabled, false);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').click(); });
  assert.deepEqual(sent, [{ path: "/tmp/aicodingtool-attachments/pasted.png", labels: [] }]);
  assert.equal(view.container.querySelectorAll(".attachment-chip").length, 0);
  await view.unmount();
});

test("a long paste is held aside as a pill, and a short one lands in the draft", async () => {
  window.desktop = fakeDesktop();
  const added: string[] = [];
  const removed: string[] = [];
  const blob = Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n");
  function Harness({ pastes }: { pastes: PastedText[] }) {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      engine: "claude", engineLabel: "Claude",
      model: "opus",
      runActive: false,
      pastes,
      onPromptChange: setPrompt,
      onPasteAdd: (text) => { added.push(text); },
      onPasteRemove: (pasteId) => { removed.push(pasteId); },
      onModeChange() {},
      onModelChange() {},
      queuedMessages: [],
      onSteerQueued() {},
      onDropQueued() {},
      onSend() {},
      onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness, { pastes: [] }));
  const textarea = query<HTMLTextAreaElement>(view.container, "textarea");

  function pasteText(text: string) {
    const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [], getData: () => text } });
    return event;
  }

  const short = pasteText("a line I meant to type");
  await act(async () => { textarea.dispatchEvent(short); });
  assert.deepEqual(added, [], "a short paste is the textarea's own business");
  assert.equal(short.defaultPrevented, false);

  const long = pasteText(blob);
  await act(async () => { textarea.dispatchEvent(long); });
  assert.deepEqual(added, [blob]);
  assert.equal(long.defaultPrevented, true, "the blob never reaches the draft");

  await view.render(React.createElement(Harness, { pastes: [{ id: "paste-1", text: blob }] }));
  const pill = query(view.container, ".paste-pill");
  assert.match(pill.textContent, /Pasted text #1/);
  assert.match(pill.textContent, /40 lines/);
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').disabled, false, "a paste alone is enough to send");

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Read pasted text 1"]').click(); });
  assert.match(query(document.body, ".paste-full").textContent, /line 39/);
  await act(async () => { query<HTMLButtonElement>(document.body, ".viewer-close").click(); });
  assert.equal(document.body.querySelector(".paste-full"), null);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Remove pasted text 1"]').click(); });
  assert.deepEqual(removed, ["paste-1"]);
  await view.unmount();
});

test("the composer offers model and effort choices, ordered most to least capable", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(TaskComposer, {
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
    engine: "claude", engineLabel: "Claude",
    model: "opus",
    effort: "high",
    runActive: false,
    onPromptChange() {},
    onModeChange() {},
    onModelChange() {},
    onEffortChange() {},
    queuedMessages: [],
    onSteerQueued() {},
    onDropQueued() {},
    onSend() {},
    onCancel() {},
  }));
  await act(async () => {});

  const menus = [...view.container.querySelectorAll(".setting-menu summary")].map((item) => item.getAttribute("aria-label"));
  assert.deepEqual(menus, ["Permission mode", "Model", "Effort"]);
  const modelMenu = item(view.container.querySelectorAll<HTMLElement>(".setting-menu")[1]);
  await act(async () => { query<HTMLElement>(modelMenu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(
    [...modelMenu.querySelectorAll(".setting-group-heading")].map((item) => item.textContent),
    ["Claude", "Codex"],
    "a draft lists every engine's models under that engine's name",
  );
  assert.deepEqual(
    [...modelMenu.querySelectorAll(".setting-option strong")].map((item) => item.textContent),
    ["Fable", "Opus", "Sonnet", "Haiku", "Sol", "Terra", "Luna"],
  );
  assert.equal(modelMenu.querySelectorAll(".setting-option[aria-disabled]").length, 0);
  assert.equal(modelMenu.querySelector(".setting-rule"), null);
  assert.equal(query(modelMenu, ".setting-value").textContent, "Opus");
  const effortMenu = item(view.container.querySelectorAll<HTMLElement>(".setting-menu")[2]);
  await act(async () => { query<HTMLElement>(effortMenu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(
    [...effortMenu.querySelectorAll(".setting-option strong")].map((item) => item.textContent),
    ["Max", "Extra high", "High", "Medium", "Low"],
  );
  assert.equal(query(effortMenu, ".setting-value").textContent, "High");
  await view.unmount();
});

test("the send button holds while the checkout a send needs is still being made", async () => {
  window.desktop = fakeDesktop();
  const sent: string[] = [];
  const composer = (waiting: boolean) => React.createElement(TaskComposer, {
    prompt: "Refactor the loader", folder: "/project", workspaceId: "workspace-1", mode: "confirm", engine: "claude", engineLabel: "Claude", model: "opus", effort: "medium",
    runActive: false, waiting, queuedMessages: [],
    onPromptChange() {}, onModeChange() {}, onModelChange() {}, onEffortChange() {}, onSteerQueued() {}, onDropQueued() {},
    onSend: () => { sent.push("sent"); }, onCancel() {},
  });

  const view = await mount(composer(true));
  const send = query<HTMLButtonElement>(view.container, ".send-button");
  assert.equal(send.disabled, true, "a second Enter is refused visibly rather than swallowed");
  await act(async () => { send.click(); });
  assert.deepEqual(sent, []);

  await view.render(composer(false));
  await act(async () => { query<HTMLButtonElement>(view.container, ".send-button").click(); });
  assert.deepEqual(sent, ["sent"], "the button works again once the checkout has landed");
  await view.unmount();
});
