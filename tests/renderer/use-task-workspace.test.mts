import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import { settleUntil } from "../support/settle.mts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { Task } from "../../src/domain/task.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import { mobileDesktopStub } from "../support/mobile-desktop.mts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await import("../../src/renderer/App.tsx");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

function seedLegacyWorkspace() {
  const legacyTask = {
    id: "legacy-task", title: "Legacy", folder: "/project", sessionId: "session-1", mode: "default",
    messages: [], changedFiles: [], updatedAt: 1,
  };
  localStorage.clear();
  localStorage.setItem("aicodingtool.tasks.v1", JSON.stringify([legacyTask]));
  localStorage.setItem("aicodingtool.projects.v1", JSON.stringify(["/project"]));
  localStorage.setItem("aicodingtool.last-folder.v1", "/project");
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

test("a window grabbed by the desktop hotkey waits in the composer, and never twice", async () => {
  localStorage.clear();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => { desktop.grabWindow({ app: "Figma", title: "Untitled", path: "/tmp/aicodingtool-attachments/grabbed.png" }); });
  await settleUntil(() => view.container.querySelectorAll(".attachment-chip").length === 1, "a grabbed window never became a chip");
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Send task"]').disabled, false);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Remove image 1"]').click(); });
  assert.equal(view.container.querySelectorAll(".attachment-chip").length, 0);

  await act(async () => { desktop.grabWindow({ app: "Figma", title: "Untitled", path: "/tmp/aicodingtool-attachments/again.png" }); });
  await settleUntil(() => view.container.querySelectorAll(".attachment-chip").length === 1, "a second press attaches the newer window");
  await view.unmount();
});

test("the workspace hook hands the thread's checkout to the application the list chose", async () => {
  const desktop = fakeDesktop({ openFolder: async () => ({ id: "workspace-1", kind: "project", root: "/project" }) });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { await workspace.get().actions.openFolder(); });
  await act(async () => { await workspace.get().actions.openFolderInApp("cursor"); });

  assert.deepEqual(desktop.appCalls, [["cursor", "/project"]]);
  await workspace.view.unmount();
});


test("workspace hook runs a projectless task and scopes events, approvals, and cancellation", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Inspect the app"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const start = startCommand(desktop.sent[0]);
  assert.equal(start.type, "start");
  assert.equal(start.channel, "main");
  assert.equal(start.workspaceId, "projectless");

  await act(async () => {
    desktop.listener({ type: "assistant.delta", taskId: start.taskId, runId: "wrong", sequence: 99, messageId: "wrong", text: "wrong" });
    desktop.listener({ type: "assistant.delta", taskId: start.taskId, runId: start.runId, sequence: 1, messageId: "message-1", text: "hello" });
    desktop.listener({ type: "approval.requested", taskId: start.taskId, runId: start.runId, sequence: 2, approvalId: "approval-1", title: "Approve", description: "Review", intent: { toolId: "tool-1", name: "Read", input: {} } });
    desktop.listener({ type: "run.status", taskId: start.taskId, runId: start.runId, sequence: 3, status: "awaiting-approval" });
  });
  assert.equal(item(workspace.get().currentTask).messages.length, 2);
  assert.equal(item(workspace.get().approval).approvalId, "approval-1");
  await act(async () => { workspace.get().actions.decideApproval(true); workspace.get().actions.cancelRun(); });
  assert.deepEqual(desktop.sent.slice(1).map((command) => command.type), ["approval", "cancel"]);

  await workspace.view.unmount();
  assert.equal(desktop.unsubscribed, true);
});

const BRANCH_PROJECT = { id: "project-1", root: "/project", workspaceId: "workspace-1" };

/** A store holding one thread in a project, which is a thread with a checkout to move. */
function seedBranchProject(overrides: Partial<DesktopAPI> = {}) {
  const task: Task = {
    id: "task-1", title: "Task", projectId: BRANCH_PROJECT.id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  };
  const store: NonNullable<Awaited<ReturnType<DesktopAPI["loadTaskStore"]>>> = {
    version: 2, projects: [BRANCH_PROJECT], worktrees: [], tasks: [task], lastFolder: BRANCH_PROJECT.root,
  };
  return fakeDesktop({
    loadTaskStore: async () => store,
    ...overrides,
  });
}

test("the branch a thread is switched to is made, checked out, and read back", async () => {
  const calls: Array<["create" | "checkout", string, string]> = [];
  const desktop = seedBranchProject({
    createBranch: async (workspaceId, branch) => { calls.push(["create", workspaceId, branch]); },
    checkoutBranch: async (workspaceId, branch) => { calls.push(["checkout", workspaceId, branch]); },
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => {});

  await act(async () => { await workspace.get().actions.checkoutBranch("feature-x"); });
  assert.deepEqual(calls, [["checkout", "workspace-1", "feature-x"]], "a branch the repository has is only moved onto");

  await act(async () => { await workspace.get().actions.checkoutBranch("loader-fix", true); });
  assert.deepEqual(calls.slice(1), [["create", "workspace-1", "loader-fix"], ["checkout", "workspace-1", "loader-fix"]]);
  const environment = workspace.get().environment;
  assert.equal(environment?.status, "available");
  if (environment?.status !== "available") assert.fail("expected the checkout environment");
  assert.equal(environment.branch, "main", "the checkout is read again once it has moved");

  await workspace.view.unmount();
});

test("a checkout Git refuses to move says why, and the thread stays where it is", async () => {
  const desktop = seedBranchProject({
    checkoutBranch: async () => { throw new Error("Your local changes would be overwritten."); },
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => {});

  await act(async () => { await workspace.get().actions.checkoutBranch("feature-x"); });
  assert.equal(workspace.get().actionError, "Your local changes would be overwritten.");

  await workspace.view.unmount();
});

test("workspace hook reopens a legacy project and prevents duplicate submissions", async () => {
  let resolveFolder!: (workspace: WorkspaceRecord | null) => void;
  const folder = new Promise<WorkspaceRecord | null>((resolve) => { resolveFolder = resolve; });
  const desktop = fakeDesktop({ openFolder: () => folder });
  seedLegacyWorkspace();
  window.desktop = desktop;
  let latest: TaskWorkspace | undefined;
  function Harness() { latest = useTaskWorkspace(); return null; }
  const view = await mount(React.createElement(Harness));
  await act(async () => { item(latest).actions.setPrompt("Continue"); });
  let first!: ReturnType<TaskWorkspace["actions"]["sendPrompt"]>;
  let second!: ReturnType<TaskWorkspace["actions"]["sendPrompt"]>;
  await act(async () => {
    first = item(latest).actions.sendPrompt();
    second = item(latest).actions.sendPrompt();
    resolveFolder({ id: "workspace-1", kind: "project", root: "/project" });
    await Promise.all([first, second]);
  });

  assert.equal(desktop.sent.length, 1);
  const start = startCommand(desktop.sent[0]);
  assert.equal(start.workspaceId, "workspace-1");
  assert.deepEqual(start.continuation, { provider: "claude", value: "session-1" });
  await view.unmount();
});

test("workspace hook reads a stored subagent's activity only when it is opened", async () => {
  const project = { id: "project-1", root: "/project", workspaceId: "workspace-1" };
  const task: Task = {
    id: "task-1", title: "Task", projectId: project.id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
    subagents: [{ id: "agent-1", description: "Explore", status: "completed", startedAt: 1, finishedAt: 2, activity: [] }],
  };
  const asked: Array<[string, string]> = [];
  const desktop = fakeDesktop({
    loadTaskStore: async () => ({ version: 2, projects: [project], worktrees: [], tasks: [task], lastFolder: project.root }),
    loadSubagentActivity: async (taskId, subagentId) => {
      asked.push([taskId, subagentId]);
      return [{ id: "activity-1", kind: "text", text: "Reading", at: 1 }];
    },
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => {});
  assert.deepEqual(asked, []);

  await act(async () => { await workspace.get().actions.inspectSubagent("agent-1"); });
  assert.deepEqual(asked, [["task-1", "agent-1"]]);
  assert.deepEqual(workspace.get().subagents[0].activity.map((item) => item.id), ["activity-1"]);

  await act(async () => { await workspace.get().actions.inspectSubagent("agent-1"); });
  assert.equal(asked.length, 1);
  assert.ok(desktop.persisted.flatMap((delta) => delta.tasks).every((change) => !change.activity));
  await workspace.view.unmount();
});

test("workspace hook removes a project without touching its folder", async () => {
  const project = { id: "project-1", root: "/project", workspaceId: "workspace-1" };
  const task: Task = {
    id: "task-1", title: "Task", projectId: project.id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  };
  const desktop = fakeDesktop({ loadTaskStore: async () => ({ version: 2, projects: [project], worktrees: [], tasks: [task], lastFolder: project.root }) });
  const workspace = await mountWorkspace(desktop);
  await act(async () => {});

  await act(async () => { workspace.get().actions.removeProject(project.id); });

  assert.equal(workspace.get().projects.length, 0);
  assert.equal(workspace.get().currentTask, undefined);
  assert.ok(workspace.get().tasks[0].archivedAt);
  assert.equal(workspace.get().tasks[0].projectId, undefined);
  assert.equal(workspace.get().folder, "");
  await workspace.view.unmount();
});

test("workspace hook can retry cancelled, mismatched, and failed folder recovery", async () => {
  const outcomes: Array<WorkspaceRecord | null | Error> = [null, { id: "wrong", kind: "project", root: "/wrong" }, new Error("dialog failed"), { id: "workspace-1", kind: "project", root: "/project" }];
  const desktop = fakeDesktop({ openFolder: async () => {
    const outcome = outcomes.shift();
    assert.ok(outcome !== undefined);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  } });
  seedLegacyWorkspace();
  window.desktop = desktop;
  let latest: TaskWorkspace | undefined;
  function Harness() { latest = useTaskWorkspace(); return null; }
  const view = await mount(React.createElement(Harness));
  await act(async () => { item(latest).actions.setPrompt("Continue"); });

  for (const message of ["Reopen this project folder", "Choose the same project folder", "dialog failed"]) {
    await act(async () => { await item(latest).actions.sendPrompt(); });
    assert.match(item(item(latest).actionError), new RegExp(message));
    assert.equal(desktop.sent.length, 0);
  }
  await act(async () => { await item(latest).actions.sendPrompt(); });
  assert.equal(desktop.sent.length, 1);
  await view.unmount();
});

test("workspace hook ignores a changed-files response from a replaced run", async () => {
  type ChangedFilesResult = Awaited<ReturnType<DesktopAPI["changedFiles"]>>;
  let phase = "initial";
  let resolveOld!: (result: ChangedFilesResult) => void;
  const oldResult = new Promise<ChangedFilesResult>((resolve) => { resolveOld = resolve; });
  const never = new Promise<ChangedFilesResult>(() => {});
  const desktop = fakeDesktop({
    openFolder: async () => ({ id: "workspace-1", kind: "project", root: "/project" }),
    changedFiles: async () => {
      if (phase === "initial") return { status: "available", files: ["initial"], branch: "main", baseline: null, additions: 0, deletions: 0 };
      if (phase === "old") { phase = "new"; return oldResult; }
      return never;
    },
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { await workspace.get().actions.openFolder(); });
  await act(async () => { workspace.get().actions.setPrompt("First"); await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent.at(-1));
  phase = "old";
  await act(async () => { desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 1, status: "succeeded" }); });
  await act(async () => { workspace.get().actions.setPrompt("Second"); await workspace.get().actions.sendPrompt(); });
  resolveOld({ status: "available", files: ["stale"], branch: "old", baseline: null, additions: 99, deletions: 99 });
  await act(async () => {});

  assert.notDeepEqual(item(workspace.get().currentTask).lastChangeSnapshot.files, ["stale"]);
  await workspace.view.unmount();
});

test("workspace hook coalesces overlapping changed-files reads and follows up once", async () => {
  type ChangedFilesResult = Awaited<ReturnType<DesktopAPI["changedFiles"]>>;
  type AvailableChangedFiles = Extract<ChangedFilesResult, { status: "available" }>;
  const result: AvailableChangedFiles = { status: "available", files: [], branch: "main", baseline: "origin/main", additions: 0, deletions: 0 };
  const pending: Array<(result: ChangedFilesResult) => void> = [];
  let controlled = false;
  let calls = 0;
  const desktop = fakeDesktop({
    openFolder: async () => ({ id: "workspace-1", kind: "project", root: "/project" }),
    changedFiles: async () => {
      if (!controlled) return result;
      calls += 1;
      return new Promise<ChangedFilesResult>((resolve) => pending.push((value) => resolve(value)));
    },
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { await workspace.get().actions.openFolder(); });
  controlled = true;

  let first!: ReturnType<TaskWorkspace["dispatch"]>;
  await act(async () => {
    first = workspace.get().dispatch({ type: "view.refresh-environment" });
    await Promise.resolve();
  });
  assert.equal(calls, 1);

  await act(async () => { await workspace.get().dispatch({ type: "view.refresh-environment" }); });
  assert.equal(calls, 1, "a refresh in flight owns the checkout");

  await act(async () => {
    item(pending.shift())({ ...result, files: ["first"] });
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(calls, 2, "the queued refresh starts as soon as the first settles");

  await act(async () => {
    item(pending.shift())({ ...result, files: ["second"] });
    await first;
  });
  const environment = workspace.get().environment;
  assert.equal(environment?.status, "available");
  if (environment?.status !== "available") assert.fail("expected the refreshed environment");
  assert.deepEqual(environment.files, ["second"]);
  await workspace.view.unmount();
});

test("a folder the aic command names opens as a project without the dialog", async () => {
  const desktop = fakeDesktop({ openFolder: async () => { throw new Error("nothing should be picked"); } });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { desktop.openProjectFromCli({ id: "workspace-cli", kind: "project", root: "/code/app" }); });

  assert.deepEqual(workspace.get().projects.map((project) => [project.root, project.workspaceId]), [["/code/app", "workspace-cli"]]);
  await workspace.view.unmount();
});

test("workspace hook keeps subagents when the task continues", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("First"); await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent[0]);
  await act(async () => {
    desktop.listener({ type: "subagent.started", taskId: first.taskId, runId: first.runId, sequence: 1, id: "agent-1", description: "Inspect", agentType: "Explore" });
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 2, status: "succeeded" });
  });
  await act(async () => { workspace.get().actions.setPrompt("Second"); await workspace.get().actions.sendPrompt(); });

  assert.equal(workspace.get().subagents[0].description, "Inspect");
  await act(async () => {});
  const stored = desktop.persisted.flatMap((delta) => delta.tasks).findLast((change) => change.subagents?.length);
  assert.ok(stored?.subagents);
  assert.equal(stored.subagents[0].subagent.description, "Inspect");
  assert.equal("subagents" in stored.task, false);
  await workspace.view.unmount();
});

test("workspace hook runs tasks concurrently with per-task composer state", async () => {
  const desktop = fakeDesktop({ openFolder: async () => ({ id: "workspace-1", kind: "project", root: "/project" }) });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { await workspace.get().actions.openFolder(); });
  const projectId = item(workspace.get().currentProject).id;
  await act(async () => { workspace.get().actions.setPrompt("First"); await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent[0]);

  await act(async () => { workspace.get().actions.newTask(projectId); });
  assert.equal(workspace.get().runActive, false);
  assert.equal(workspace.get().prompt, "");
  await act(async () => { workspace.get().actions.setPrompt("Second"); await workspace.get().actions.sendPrompt(); });
  const second = startCommand(desktop.sent[1]);

  assert.notEqual(second.taskId, first.taskId);
  assert.equal(workspace.get().runActive, true);
  assert.deepEqual([...workspace.get().runningTaskIds].sort(), [first.taskId, second.taskId].sort());
  assert.deepEqual(workspace.get().orderedTasks.map((task) => task.id), [second.taskId, first.taskId]);

  await act(async () => {
    desktop.listener({ type: "assistant.delta", taskId: first.taskId, runId: first.runId, sequence: 1, messageId: "message-1", text: "one" });
    desktop.listener({ type: "assistant.delta", taskId: second.taskId, runId: second.runId, sequence: 1, messageId: "message-2", text: "two" });
  });
  assert.equal(item(item(workspace.get().currentTask).messages.at(-1)).text, "two");
  assert.deepEqual(workspace.get().orderedTasks.map((task) => task.id), [second.taskId, first.taskId]);

  await act(async () => { workspace.get().actions.moveTask(second.taskId, { projectId, index: 1 }); });
  assert.deepEqual(workspace.get().orderedTasks.map((task) => task.id), [first.taskId, second.taskId]);

  await act(async () => { desktop.listener({ type: "run.status", taskId: second.taskId, runId: second.runId, sequence: 2, status: "succeeded" }); });
  assert.equal(workspace.get().runActive, false);
  assert.deepEqual([...workspace.get().runningTaskIds], [first.taskId]);

  await act(async () => { workspace.get().actions.setPrompt("Draft for second"); });
  await act(async () => { workspace.get().actions.selectTask(first.taskId); });
  assert.equal(workspace.get().runActive, true);
  assert.equal(workspace.get().status, "running");
  assert.equal(workspace.get().prompt, "");

  await act(async () => { workspace.get().actions.setPrompt("Ignored"); await workspace.get().actions.sendPrompt(); });
  assert.equal(desktop.sent.filter((command) => command.type === "start").length, 2);

  await act(async () => { workspace.get().actions.selectTask(second.taskId); });
  assert.equal(workspace.get().prompt, "Draft for second");
  await workspace.view.unmount();
});

test("resolving a run hands back the workspace the reducer named, kind and all", async () => {
  const { resolveRunWorkspace } = await import("../../src/renderer/task-workspace/resolve-run-workspace.ts");
  type ResolveDesktop = import("../../src/renderer/task-workspace/resolve-run-workspace.ts").ResolveDesktop;
  const worktree: WorkspaceRecord = { id: "worktree-1", kind: "worktree", root: "/worktrees/repo-wt1" };
  const desktop: ResolveDesktop = {
    createBranch: async () => { throw new Error("no branch should be made"); },
    checkoutBranch: async () => { throw new Error("nothing should be checked out"); },
    createWorktree: async () => { throw new Error("the worktree already exists"); },
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/tmp" }),
    openFolder: async () => { throw new Error("nothing should be picked"); },
  };

  const resolved = await resolveRunWorkspace({ type: "resolve-run-workspace", pendingId: "pending-1", picker: false, workspace: worktree }, desktop);

  assert.deepEqual(resolved, { type: "run.resolved", pendingId: "pending-1", workspace: worktree }, "a run in a worktree is answered as a worktree, never as a project");
});

test("resolving a run reports what the branch or the worktree could not do", async () => {
  const { resolveRunWorkspace } = await import("../../src/renderer/task-workspace/resolve-run-workspace.ts");
  type ResolveDesktop = import("../../src/renderer/task-workspace/resolve-run-workspace.ts").ResolveDesktop;
  const calls: Array<[string, string, string]> = [];
  const desktop: ResolveDesktop = {
    createBranch: async (workspaceId: string, branch: string) => { calls.push(["create", workspaceId, branch]); },
    checkoutBranch: async () => { throw new Error("Your local changes would be overwritten."); },
    createWorktree: async () => { throw new Error("unreached"); },
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/tmp" }),
    openFolder: async () => null,
  };

  const effect: Parameters<typeof resolveRunWorkspace>[0] = {
    type: "resolve-run-workspace",
    pendingId: "pending-2",
    picker: false,
    workspace: { id: "workspace-a", kind: "project", root: "/repo" },
    createBranch: { workspaceId: "workspace-a", branch: "feature-x" },
    checkout: { workspaceId: "workspace-a", branch: "feature-x" },
  };
  const failed = await resolveRunWorkspace(effect, desktop);

  assert.deepEqual(calls, [["create", "workspace-a", "feature-x"]], "the branch is made before anything tries to start from it");
  assert.deepEqual(failed, {
    type: "run.unresolved",
    pendingId: "pending-2",
    message: "Could not check out feature-x: Your local changes would be overwritten.",
  }, "Git says what went wrong, and the message says what was being attempted");
});

test("resolving a run through the picker insists on the same folder", async () => {
  const { resolveRunWorkspace } = await import("../../src/renderer/task-workspace/resolve-run-workspace.ts");
  type ResolveDesktop = import("../../src/renderer/task-workspace/resolve-run-workspace.ts").ResolveDesktop;
  const desktop: ResolveDesktop = {
    createBranch: async () => {},
    checkoutBranch: async () => {},
    createWorktree: async () => ({ id: "wt", root: "/tmp/wt", workspaceId: "workspace-wt", baseCommit: "abc1234", createdAt: 1, lastUsedAt: 1 }),
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/tmp" }),
    openFolder: async () => ({ id: "workspace-b", kind: "project", root: "/elsewhere" }),
  };

  const wrong = await resolveRunWorkspace({ type: "resolve-run-workspace", pendingId: "pending-3", picker: true, root: "/repo" }, desktop);

  assert.equal(wrong.type, "run.unresolved");
  assert.match(wrong.message, /same project folder/);
});

test("the checkout on screen is read again while nothing runs in it", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  /** The hook asks the window for its timers, and jsdom's window keeps its own. */
  const windowTimers = { setInterval: dom.window.setInterval, clearInterval: dom.window.clearInterval };
  for (const name of ["setInterval", "clearInterval"] as const) {
    Object.defineProperty(dom.window, name, { configurable: true, value: globalThis[name] });
  }
  t.onTestFinished(() => {
    for (const name of ["setInterval", "clearInterval"] as const) {
      Object.defineProperty(dom.window, name, { configurable: true, value: windowTimers[name] });
    }
    vi.useRealTimers();
  });
  let reads = 0;
  const desktop = fakeDesktop({
    openFolder: async () => ({ id: "workspace-1", kind: "project", root: "/project" }),
    changedFiles: async () => {
      reads += 1;
      return { status: "available", files: [], branch: "main", baseline: "origin/main", additions: 0, deletions: 0 };
    },
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { await workspace.get().actions.openFolder(); });
  const opened = reads;

  await act(async () => { vi.advanceTimersByTime(14_000); });
  assert.equal(reads, opened, "an idle checkout is not read on the running cadence");

  await act(async () => {
    vi.advanceTimersByTime(2_000);
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(reads, opened + 1, "work done outside the app is picked up without a run");
  await workspace.view.unmount();
});
