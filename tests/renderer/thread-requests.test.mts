import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import { engineDesktopStub, mobileDesktopStub } from "../support/mobile-desktop.mts";

import { item, mount } from "../support/renderer-dom.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");

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

type ThreadSummary = import("../../src/contracts/threads.ts").ThreadSummary;
type ThreadTranscript = import("../../src/contracts/threads.ts").ThreadTranscript;
type ThreadCommandResult = import("../../src/contracts/threads.ts").ThreadCommandResult;
type ThreadWaitResult = import("../../src/contracts/threads.ts").ThreadWaitResult;

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

function threadListResult(response: ThreadResponse | undefined): ThreadSummary[] {
  const result = responseResult(response);
  assert.ok(Array.isArray(result));
  for (const thread of result) assert.equal(typeof (thread as Record<string, unknown>).id, "string");
  return result as ThreadSummary[];
}

function threadTranscriptResult(response: ThreadResponse | undefined): ThreadTranscript {
  const result = responseRecord(response);
  assert.ok(Array.isArray(result.messages));
  assert.ok(result.thread !== null && typeof result.thread === "object");
  return result as ThreadTranscript;
}

function threadCommandResult(response: ThreadResponse | undefined): ThreadCommandResult {
  const result = responseRecord(response);
  assert.ok(result.thread === null || typeof result.thread === "object");
  return result as ThreadCommandResult;
}

function threadWaitResult(response: ThreadResponse | undefined): ThreadWaitResult {
  const result = responseRecord(response);
  assert.equal(typeof result.timedOut, "boolean");
  assert.ok(result.thread !== null && typeof result.thread === "object");
  return result as ThreadWaitResult;
}

function failedThreadResponse(response: ThreadResponse | undefined): Extract<ThreadResponse, { ok: false }> {
  const actual = item(response);
  assert.equal(actual.ok, false);
  if (actual.ok) assert.fail("Expected the thread request to fail");
  return actual;
}

test("the window answers thread requests from the reducer's own state", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const started = workspace.get().currentTask;
  assert.ok(started, "a thread exists to ask about");

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: started.id, op: "list" }); });
  const listed = threadListResult(desktop.threadAnswers.at(-1));
  assert.deepEqual(listed.map((thread) => thread.id), [started.id]);

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: started.id, op: "read", threadId: started.id }); });
  assert.deepEqual(threadTranscriptResult(desktop.threadAnswers.at(-1)).messages.map((message) => message.text), ["Fix the header"]);

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r3", taskId: started.id, op: "read", threadId: "ghost" }); });
  assert.match(failedThreadResponse(desktop.threadAnswers.at(-1)).message, /No thread has the ID ghost/);

  await workspace.view.unmount();
});

test("a thread command reaches the reducer and reports the thread it acted on", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const caller = item(workspace.get().currentTask);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: caller.id, op: "command", command: { type: "task.send", text: "Implement item 2" } });
  });
  const answer = threadCommandResult(desktop.threadAnswers.at(-1));
  const answeredThread = item(answer.thread);
  assert.notEqual(answeredThread.id, caller.id, "the send started its own thread");
  assert.equal(item(workspace.get().currentTask).id, caller.id, "the user stays where they were");
  assert.equal(desktop.sent.filter((command) => command.type === "start").length, 2);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: caller.id, op: "command", command: { type: "task.archive", taskId: answeredThread.id } });
  });
  assert.equal(item(threadCommandResult(desktop.threadAnswers.at(-1)).thread).archived, true);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r3", taskId: caller.id, op: "command", command: { type: "task.archive", taskId: "ghost" } });
  });
  failedThreadResponse(desktop.threadAnswers.at(-1));

  await workspace.view.unmount();
});

test("a wait is held open until the thread it names stops working", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const running = item(workspace.get().currentTask);
  const runId = startCommand(desktop.sent.at(-1)).runId;

  await act(async () => { desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: running.id, op: "wait", threadId: running.id, timeoutMs: 60_000 }); });
  assert.equal(desktop.threadAnswers.length, 0, "the wait is still open while the run goes");

  await act(async () => {
    desktop.listener({ type: "assistant.delta", taskId: running.id, runId, sequence: 1, messageId: "reply-1", text: "Header fixed." });
    desktop.listener({ type: "run.status", taskId: running.id, runId, sequence: 2, status: "succeeded" });
  });
  await act(async () => {});

  const waited = threadWaitResult(desktop.threadAnswers.at(-1));
  assert.equal(waited.timedOut, false);
  assert.equal(waited.reply, "Header fixed.");
  assert.equal(waited.thread.status, "idle");

  await workspace.view.unmount();
});

test("a wait on a thread that is already idle answers at once, and an unknown thread fails", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const started = item(workspace.get().currentTask);
  const runId = startCommand(desktop.sent.at(-1)).runId;
  await act(async () => { desktop.listener({ type: "run.status", taskId: started.id, runId, sequence: 1, status: "succeeded" }); });

  await act(async () => { desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: started.id, op: "wait", threadId: started.id, timeoutMs: 60_000 }); });
  assert.equal(threadWaitResult(desktop.threadAnswers.at(-1)).timedOut, false);

  await act(async () => { desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: started.id, op: "wait", threadId: "ghost", timeoutMs: 60_000 }); });
  failedThreadResponse(desktop.threadAnswers.at(-1));

  await workspace.view.unmount();
});
