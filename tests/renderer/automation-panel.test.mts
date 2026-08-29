import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { Task } from "../../src/domain/task.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import { engineDesktopStub, mobileDesktopStub } from "../support/mobile-desktop.mts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { settleFrame } from "../support/settle.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");
const { AutomationPanel, automationStatusLabel, formatCountdown } = await import("../../src/renderer/components/AutomationPanel.tsx");

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

test("the automation panel explains itself before an automation exists", async () => {
  const view = await mount(React.createElement(AutomationPanel, {
    automation: null, engineLabel: "Claude", lastFoundAt: null, lastChecked: null, onUpdate() {}, onDelete() {}, onRunNow() {},
  }));

  assert.match(view.container.textContent, /Ask Claude to repeat this task/);
  assert.match(view.container.textContent, /No automation yet/);
  assert.equal(view.container.querySelector('input[aria-label="Automation schedule"]'), null);
  await view.unmount();
});

test("the automation panel edits the schedule and prompt in one save", async () => {
  const patches: AutomationPatch[] = [];
  const automation = automationView();
  const view = await mount(React.createElement(AutomationPanel, {
    automation, engineLabel: "Claude", lastFoundAt: null, lastChecked: null, onUpdate: (patch) => { patches.push(patch); }, onDelete() {}, onRunNow() {},
  }));

  const schedule = query<HTMLInputElement>(view.container, 'input[aria-label="Automation schedule"]');
  const prompt = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Automation prompt"]');
  const save = query<HTMLButtonElement>(view.container, ".automation-actions button");
  const setInput = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  const setTextarea = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  assert.equal(schedule.value, "*/5 * * * *");
  assert.equal(prompt.value, "Check whether the PR is approved");
  assert.equal(save.disabled, true, "an untouched automation has nothing to save");
  assert.match(view.container.textContent, /2 runs/);
  assert.match(view.container.textContent, /succeeded at/);

  await act(async () => {
    item(setInput).call(schedule, "0 8 * * *");
    schedule.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "0 8 * * *" }));
    schedule.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    item(setTextarea).call(prompt, "Check the PR and stop once it is approved");
    prompt.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Check the PR and stop once it is approved" }));
    prompt.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, ".automation-actions button").click(); });

  assert.deepEqual(patches, [{ schedule: "0 8 * * *", prompt: "Check the PR and stop once it is approved" }]);
  await view.unmount();
});

test("the automation panel pauses, reruns, and removes without editing", async () => {
  const patches: AutomationPatch[] = [];
  let deleted = 0;
  let ranNow = 0;
  const view = await mount(React.createElement(AutomationPanel, {
    automation: automationView(),
    engineLabel: "Claude",
    lastFoundAt: null,
    lastChecked: null,
    onUpdate: (patch) => { patches.push(patch); },
    onDelete: () => { deleted += 1; },
    onRunNow: () => { ranNow += 1; },
  }));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Pause automation"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Run automation now"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Remove automation"]').click(); });

  assert.deepEqual([...patches], [{ paused: true }]);
  assert.equal(ranNow, 1);
  assert.equal(deleted, 1);

  await view.render(React.createElement(AutomationPanel, {
    automation: automationView({ paused: true, nextRunAt: null }),
    engineLabel: "Claude",
    lastFoundAt: null,
    lastChecked: null,
    onUpdate: (patch) => { patches.push(patch); },
    onDelete() {},
    onRunNow() {},
  }));
  assert.match(view.container.textContent, /Paused/);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Resume automation"]').click(); });
  assert.deepEqual(patches.at(-1), { paused: false });
  await view.unmount();
});

test("the automation countdown stays readable at every distance", () => {
  const at = Date.parse("2026-08-17T09:00:00Z");
  assert.equal(formatCountdown(at + 45_000, at), "in 45s");
  assert.equal(formatCountdown(at + 300_000, at), "in 5m");
  assert.equal(formatCountdown(at + 7_200_000, at), "in 2h");
  assert.equal(formatCountdown(at - 5_000, at), "in 0s");
});

test("an automation with no next run reads as missed unless the user paused it", () => {
  const at = Date.parse("2026-08-17T09:00:00Z");
  assert.equal(automationStatusLabel(automationView({ nextRunAt: at + 60_000 }), at), "in 1m");
  assert.equal(automationStatusLabel(automationView({ paused: true, nextRunAt: null }), at), "Paused");
  assert.equal(automationStatusLabel(automationView({ nextRunAt: null, lastStatus: "missed" }), at), "Missed");
});

test("a scheduled tick runs in the original thread and reports back to the scheduler", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Watch PR 42"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent[0]);
  await act(async () => {
    desktop.listener({ type: "continuation.updated", taskId: first.taskId, runId: first.runId, sequence: 1, continuation: { provider: "claude", value: "session-1" } });
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 2, status: "succeeded" });
  });
  await settleFrame();

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: first.taskId, runId: "run-scheduled", prompt: "Check PR 42", runNumber: 3, policy: "autonomous" });
  });

  const scheduled = startCommand(desktop.sent[1]);
  assert.equal(scheduled.taskId, first.taskId, "the tick continues the original thread");
  assert.equal(scheduled.runId, "run-scheduled", "the scheduler's run ID is what comes back to it");
  assert.equal(scheduled.policy, "autonomous", "the automation's policy wins over the task's");
  assert.deepEqual(scheduled.continuation, { provider: "claude", value: "session-1" });
  assert.match(scheduled.prompt, /^Check PR 42/);
  assert.match(scheduled.prompt, /automated run #3/);
  assert.match(scheduled.prompt, /stop tool/);
  assert.deepEqual(desktop.acknowledged, [{ automationId: "automation-1", runId: "run-scheduled", started: true }]);

  const messages = item(workspace.get().currentTask).messages;
  assert.equal(item(messages.at(-1)).text, "Check PR 42", "the transcript shows the prompt, not the scheduler's framing");
  assert.equal(item(messages.at(-1)).detail, "Automation run #3");
  await workspace.view.unmount();
});

test("a tick that lands on a busy or archived task is declined instead of queued", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Watch PR 42"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent[0]);

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: first.taskId, runId: "run-overlap", prompt: "Check PR 42", runNumber: 2 });
  });
  assert.equal(desktop.sent.length, 1, "the running task never gets a second run");
  assert.deepEqual(desktop.acknowledged, [{ automationId: "automation-1", runId: "run-overlap", started: false }]);

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: "task-gone", runId: "run-missing", prompt: "Check PR 42", runNumber: 2 });
  });
  assert.equal(item(desktop.acknowledged.at(-1)).started, false, "a tick for a task that no longer exists is declined");
  await workspace.view.unmount();
});

test("removing a project retires the automations of every task it takes with it", async () => {
  const project = { id: "project-1", root: "/project", workspaceId: "workspace-1" };
  const task = (id: string): Task => ({
    id, title: id, projectId: project.id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  });
  const desktop = fakeDesktop({
    loadTaskStore: async () => ({ version: 2, hiddenTasks: 0, projects: [project], worktrees: [], tasks: [task("task-1"), task("task-2"), task("task-3")], lastFolder: project.root }),
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => {});
  await act(async () => {
    desktop.automationsChanged([automationView({ taskId: "task-1" }), automationView({ id: "automation-2", taskId: "task-3" })]);
  });

  await act(async () => { workspace.get().actions.removeProject(project.id); });

  assert.deepEqual(
    desktop.automationChanges.map((change) => change.taskId).sort(),
    ["task-1", "task-3"],
    "every archived task's automation is retired, and tasks without one are left alone",
  );
  await workspace.view.unmount();
});

test("archiving a task retires its automation", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Watch PR 42"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent[0]);
  await act(async () => {
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 1, status: "succeeded" });
  });
  await act(async () => { desktop.automationsChanged([automationView({ taskId: first.taskId })]); });
  assert.equal(item(workspace.get().automation).taskId, first.taskId);

  await act(async () => { workspace.get().actions.archiveTask(first.taskId); });

  assert.deepEqual(desktop.automationChanges, [{ taskId: first.taskId, deleted: true }]);
  await workspace.view.unmount();
});
