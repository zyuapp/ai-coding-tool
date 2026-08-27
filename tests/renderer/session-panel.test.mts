import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import { OPEN_SUBAGENT_GROUPS, type BackgroundProcess, type Subagent, type SubagentActivity } from "../../src/domain/run.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { SessionPanelProps } from "../../src/renderer/components/SessionPanel.tsx";
import type { TaskComposerProps } from "../../src/renderer/components/TaskComposer.tsx";
import { mobileDesktopStub } from "../support/mobile-desktop.mts";

import { dom, item, mount, pumpResizeObservers, query, rowHeights, sizeOf } from "../support/renderer-dom.mts";

const { SessionPanel } = await import("../../src/renderer/components/SessionPanel.tsx");
const { SubagentInspector } = await import("../../src/renderer/components/SubagentInspector.tsx");
const { AgentsPanel, matchSubagents } = await import("../../src/renderer/components/SubagentList.tsx");
const { WorkspaceHeader } = await import("../../src/renderer/components/WorkspaceHeader.tsx");
const { OpenInMenu } = await import("../../src/renderer/components/OpenInMenu.tsx");
const { TaskComposer } = await import("../../src/renderer/components/TaskComposer.tsx");

function renderSessionPanel(overrides: Partial<SessionPanelProps>) {
  return React.createElement(SessionPanel, {
    environment: null,
    hasProject: false,
    runActive: false,
    openMenu: null,
    subagents: [],
    subagentGroups: OPEN_SUBAGENT_GROUPS,
    backgroundProcesses: [],
    workflows: [],
    automationCount: 0,
    onSelect() {},
    onOpenAgents() {},
    onOpenAutomations() {},
    onToggleChanges() {},
    onOpenWorkflow() {},
    onStopProcess() {},
    onSetOpenMenu() {},
    onSetSubagentGroup() {},
    onSetWorktree() {},
    onCheckoutBranch() {},
    ...overrides,
  });
}


function renderTaskComposer(overrides: Partial<TaskComposerProps>) {
  return React.createElement(TaskComposer, {
    prompt: "",
    folder: "",
    mode: "confirm",
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

const subagents: Subagent[] = [
  { id: "working", description: "Working agent", status: "working", lastToolName: "Read", totalTokens: 321, startedAt: 1, activity: [] },
  { id: "complete", description: "Complete agent", status: "completed", summary: "Done", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "failed", description: "Failed agent", status: "failed", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "stopped", description: "Stopped agent", status: "stopped", startedAt: 1, finishedAt: 2, activity: [] },
];

type MountView = Awaited<ReturnType<typeof mount>>;

type ThreadLocation = import("../../src/application/workspace-state.ts").ThreadLocation;

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

/** A workflow still going is drawn against the clock, so its fixture starts where a live one would. */
const workflowStart = Date.now() - 92_000;
type Workflow = SessionPanelProps["workflows"][number];
const workflowAgents: Workflow["agents"] = [
  { index: 0, label: "review:bugs", state: "done", phaseIndex: 0, phaseTitle: "Review", startedAt: workflowStart, durationMs: 60_000, tokens: 41_200, toolCalls: 12, resultPreview: "3 findings", model: "opus" },
  { index: 1, label: "verify:query.ts", state: "error", phaseIndex: 1, phaseTitle: "Verify", startedAt: workflowStart + 60_000, durationMs: 30_000, tokens: 20_500, error: "Agent returned no structured output" },
  { index: 2, label: "verify:store.ts", state: "running", phaseIndex: 1, phaseTitle: "Verify", queuedAt: workflowStart + 60_000, startedAt: workflowStart + 61_000, tokens: 18_600, lastToolName: "Grep", isolation: "worktree", attempt: 2, promptPreview: "Adversarially verify this finding" },
];

const liveWorkflow: Workflow = {
  id: "wf-1",
  name: "review-changes",
  description: "Review changed files across dimensions",
  status: "running",
  phases: [{ index: 0, title: "Review" }, { index: 1, title: "Verify" }],
  agents: workflowAgents,
  totalTokens: 80_300,
  totalToolCalls: 21,
  startedAt: workflowStart,
};

test("session panel renders Git and subagent states and selects an agent", async () => {
  window.desktop = fakeDesktop();
  let selected: string | undefined;
  let openedAutomations = 0;
  const view = await mount(renderSessionPanel({
    environment: { status: "available", files: [" M file"], branch: "main", baseline: null, additions: 4, deletions: 2 },
    hasProject: true,
    subagents,
    backgroundProcesses: [], workflows: [],
    automationCount: 1,
    onSelect: (id) => { selected = id; },
    onOpenAutomations: () => { openedAutomations += 1; },
  }));

  assert.match(view.container.textContent, /\+4−2/);
  assert.match(view.container.textContent, /main/);
  assert.match(view.container.textContent, /1 working/);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Working agent details"]').click(); });
  assert.equal(selected, "working");

  const automations = query<HTMLButtonElement>(view.container, 'button[aria-label="Open Automation panel"]');
  assert.equal(query(automations, ".session-count").textContent, "1", "the card only counts automations");
  assert.equal(automations.querySelector('input[aria-label="Automation schedule"]'), null, "editing happens in the sliding panel");
  await act(async () => { automations.click(); });
  assert.equal(openedAutomations, 1);

  const environments: Array<[SessionPanelProps["environment"], string]> = [
    [null, "Reading Git…"],
    [{ status: "unknown", workspaceId: "gone" }, "Workspace is no longer registered"],
    [{ status: "unavailable", reason: "missing" }, "Workspace is missing"],
    [{ status: "error", message: "git failed" }, "git failed"],
  ];
  for (const [environment, message] of environments) {
    await view.render(renderSessionPanel({ environment, hasProject: true, workspaceId: "workspace-a", subagents: [], backgroundProcesses: [], workflows: [], automationCount: 0, onSelect() {}, onOpenAutomations() {} }));
    assert.match(view.container.textContent, new RegExp(message));
  }
  await view.render(renderSessionPanel({ environment: null, hasProject: true, subagents: [], backgroundProcesses: [], workflows: [], automationCount: 0, onSelect() {}, onOpenAutomations() {} }));
  assert.match(view.container.textContent, /Reopen the project to inspect Git/, "a project that is no longer open has no checkout to read");
  await view.render(renderSessionPanel({ environment: null, hasProject: false, subagents: [], backgroundProcesses: [], workflows: [], automationCount: 0, onSelect() {}, onOpenAutomations() {} }));
  assert.match(view.container.textContent, /Open a project to inspect Git/);
  await view.unmount();
});

test("the session panel lists the run's background processes and stops the one asked for", async () => {
  const stopped: string[] = [];
  const processes: BackgroundProcess[] = [
    { id: "bash-1", kind: "shell", description: "npm run dev" },
    { id: "watch-1", kind: "monitor", description: "Deploy events", stopping: true },
  ];
  const view = await mount(renderSessionPanel({
    environment: { status: "available", files: [], branch: "main", baseline: null, additions: 0, deletions: 0 },
    hasProject: true,
    subagents: [],
    backgroundProcesses: processes,
    workflows: [],
    automationCount: 0,
    onSelect() {},
    onOpenAutomations() {},
    onStopProcess: (processId) => { stopped.push(processId); },
  }));

  assert.match(view.container.textContent, /2 running/);
  assert.match(view.container.textContent, /npm run dev/);
  assert.match(view.container.textContent, /Stopping/);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Stop npm run dev"]').click(); });
  assert.deepEqual(stopped, ["bash-1"]);
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Stop Deploy events"]').disabled, true, "a stop already asked for cannot be asked for twice");

  await view.render(renderSessionPanel({
    environment: null, hasProject: true, subagents: [], backgroundProcesses: [], workflows: [], automationCount: 0, onSelect() {}, onOpenAutomations() {}, onStopProcess() {},
  }));
  assert.doesNotMatch(view.container.textContent, /Processes/, "an empty section leaves nothing behind");
  await view.unmount();
});

test("the subagents panel windows a large roster, leads with failures, and filters it", async () => {
  const many: Subagent[] = Array.from({ length: 1000 }, (_, index) => ({
    id: `agent-${index}`,
    description: `Agent ${index}`,
    status: index === 700 ? "failed" : index % 3 === 0 ? "working" : "completed",
    ...(index % 3 === 0 ? { lastToolName: "Grep" } : {}),
    startedAt: index,
    activity: [],
  }));
  /** jsdom measures every row at nothing, which would fit the whole roster on one screen. */
  const measuredRows = rowHeights((node) => node.classList?.contains("subagent-row") ? 51 : 0);
  const view = await mount(React.createElement(AgentsPanel, { subagents: many, groups: OPEN_SUBAGENT_GROUPS, onSelect() {}, onSetGroup() {} }));
  const list = query(view.container, ".agents-panel-list");
  sizeOf(list, 360, 720);
  await pumpResizeObservers();

  const rows = view.container.querySelectorAll(".subagent-row").length;
  assert.ok(rows > 0 && rows < 80, `a windowed list should draw a screenful, drew ${rows}`);
  assert.match(query(view.container, ".subagent-group").textContent ?? "", /Failed/);
  assert.match(view.container.textContent, /Agent 700/);

  await act(async () => { query<HTMLButtonElement>(view.container, '.agent-status-strip button.failed').click(); });
  assert.deepEqual(
    [...view.container.querySelectorAll(".subagent-list strong")].map((node) => node.textContent),
    ["Agent 700"],
  );

  measuredRows.restore();
  await view.unmount();
});

test("a folded status group hides its rows and reports the fold", async () => {
  const subagents: Subagent[] = [
    { id: "a", description: "Explore renderer", status: "completed", startedAt: 1, activity: [] },
    { id: "b", description: "Read the reducer", status: "working", startedAt: 2, activity: [] },
  ];
  const folds: Array<[string, boolean]> = [];
  const view = await mount(React.createElement(AgentsPanel, {
    subagents,
    groups: OPEN_SUBAGENT_GROUPS,
    onSelect() {},
    onSetGroup(group, open) { folds.push([group, open]); },
  }));

  assert.match(view.container.textContent, /Explore renderer/);
  const completed = [...view.container.querySelectorAll<HTMLButtonElement>(".subagent-group")].find((node) => node.textContent?.includes("Completed"));
  await act(async () => { item(completed).click(); });
  assert.deepEqual(folds, [["completed", false]]);

  await view.render(React.createElement(AgentsPanel, {
    subagents,
    groups: { ...OPEN_SUBAGENT_GROUPS, completed: false },
    onSelect() {},
    onSetGroup() {},
  }));
  assert.doesNotMatch(view.container.textContent, /Explore renderer/, "a folded group drops its rows");
  assert.match(view.container.textContent, /Completed/, "the heading stays so the fold can be undone");
  assert.match(view.container.textContent, /Read the reducer/, "an unfolded group is untouched");
  await view.unmount();
});

test("the sidebar folds its subagent list and leaves the count on show", async () => {
  const subagents: Subagent[] = [{ id: "a", description: "Explore renderer", status: "working", startedAt: 1, activity: [] }];
  const folds: Array<[string, boolean]> = [];
  const view = await mount(renderSessionPanel({ subagents, onSetSubagentGroup(group, open) { folds.push([group, open]); } }));

  assert.match(view.container.textContent, /Explore renderer/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".subagent-heading .section-toggle").click(); });
  assert.deepEqual(folds, [["sidebar", false]]);

  await view.render(renderSessionPanel({ subagents, subagentGroups: { ...OPEN_SUBAGENT_GROUPS, sidebar: false } }));
  assert.doesNotMatch(view.container.textContent, /Explore renderer/, "a folded list drops its rows");
  assert.match(view.container.textContent, /1 working/, "the count stays readable while folded");
  await view.unmount();
});

test("the subagent search keeps what the query names, and the status keeps its own", async () => {
  const subagents: Subagent[] = [
    { id: "a", description: "Explore renderer", status: "completed", startedAt: 1, activity: [] },
    { id: "b", description: "Fix loader", status: "working", lastToolName: "Grep", startedAt: 2, activity: [] },
    { id: "c", description: "Audit deps", status: "failed", startedAt: 3, activity: [] },
  ];

  assert.deepEqual(matchSubagents(subagents, null, "").map((subagent) => subagent.id), ["c", "b", "a"], "failures are read first");
  assert.deepEqual(matchSubagents(subagents, null, "   ").map((subagent) => subagent.id), ["c", "b", "a"], "an empty search is not a filter");
  assert.deepEqual(matchSubagents(subagents, "working", "").map((subagent) => subagent.id), ["b"]);
  assert.deepEqual(matchSubagents(subagents, null, "LOADER").map((subagent) => subagent.id), ["b"], "case never decides a match");
  assert.deepEqual(matchSubagents(subagents, null, "grep").map((subagent) => subagent.id), ["b"], "the tool a subagent is using is searchable");
  assert.deepEqual(matchSubagents(subagents, "failed", "loader"), []);
});

test("subagent inspector renders activity and closes", async () => {
  let closed = false;
  const subagent: Subagent = {
    ...subagents[0],
    summary: "Renderer inspected",
    activity: [{ id: "old", kind: "text", text: "Earlier", at: 0 }, { id: "text", kind: "text", text: "Reading", at: 1 }, { id: "tool", kind: "tool", title: "Read", text: "{\"file\":\"App.tsx\"}", at: 2 }, ...Array.from({ length: 58 }, (_, index) => ({ id: `later-${index}`, kind: "text" as const, text: `Later ${index}`, at: index + 3 }))] satisfies SubagentActivity[],
  };
  /** The log is windowed, and a virtualiser reads every height off the element, which jsdom reports at nothing. */
  const measuredRows = rowHeights((node) => node.classList?.contains("agent-activity-row") ? 40 : 0);
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose: () => { closed = true; } }));
  sizeOf(query(view.container, ".inspector-scroll"), 360, 720);
  await pumpResizeObservers();

  assert.match(view.container.textContent, /Renderer inspected/);
  assert.match(view.container.textContent, /321 tokens/);
  assert.match(view.container.textContent, /Reading/);
  assert.equal(query(view.container, "details summary").textContent, "Read");
  const earlier = query<HTMLButtonElement>(view.container, ".agent-activity-earlier"); assert.equal(earlier.textContent, "Load earlier (1)");
  await act(async () => { earlier.click(); });
  assert.equal(view.container.querySelector(".agent-activity-earlier"), null);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Close subagent details"]').click(); });
  assert.equal(closed, true);
  measuredRows.restore();
  await view.unmount();
});

test("a search reading the inspector gets the whole log, drawn open", async () => {
  const subagent: Subagent = {
    ...subagents[0],
    activity: [
      { id: "tool", kind: "tool", title: "Read", text: "reading App.tsx", at: 0 },
      ...Array.from({ length: 120 }, (_, index) => ({ id: `step-${index}`, kind: "text" as const, text: `Step ${index}`, at: index + 1 })),
    ] satisfies SubagentActivity[],
  };
  const measuredRows = rowHeights((node) => node.classList?.contains("agent-activity-row") ? 40 : 0);
  const view = await mount(React.createElement(SubagentInspector, { subagent, finding: true, onClose() {} }));
  sizeOf(query(view.container, ".inspector-scroll"), 360, 720);
  await pumpResizeObservers();

  assert.equal(view.container.querySelectorAll(".agent-activity-row").length, 121, "a search reads what was drawn, so all of it is drawn");
  assert.equal(view.container.querySelector(".agent-activity-earlier"), null, "there is nothing earlier left to load");
  assert.equal(query<HTMLDetailsElement>(view.container, "details.agent-tool").open, true, "a match inside a tool's output has to be visible to be stepped onto");
  assert.match(view.container.textContent, /Step 0/);
  measuredRows.restore();
  await view.unmount();
});

test("workspace header keeps session summary and right panel controls separate", async () => {
  let sidebarToggles = 0;
  let summaryToggles = 0;
  let rightPanelToggles = 0;
  const view = await mount(React.createElement(WorkspaceHeader, {
    folder: "/project",
    folderLabel: "project",
    sidebarOpen: false,
    sessionPanelOpen: true,
    rightDockOpen: true,
    workingSubagents: 2,
    openMenu: null,
    canOpenFolder: true,
    onSetOpenMenu: () => {},
    onOpenInApp: () => {},
    onToggleSidebar: () => { sidebarToggles += 1; },
    onToggleSessionPanel: () => { summaryToggles += 1; },
    onToggleRightDock: () => { rightPanelToggles += 1; },
  }));

  assert.equal(query(view.container, 'button[aria-label="Hide right panel"]').getAttribute("aria-pressed"), "true");
  assert.equal(query(view.container, 'button[aria-label="Hide session summary"]').getAttribute("aria-pressed"), "true");
  assert.match(view.container.textContent, /2/);
  await act(async () => {
    query<HTMLButtonElement>(view.container, 'button[aria-label="Show sidebar"]').click();
    query<HTMLButtonElement>(view.container, 'button[aria-label="Hide session summary"]').click();
    query<HTMLButtonElement>(view.container, 'button[aria-label="Hide right panel"]').click();
  });
  assert.equal(sidebarToggles, 1);
  assert.equal(summaryToggles, 1);
  assert.equal(rightPanelToggles, 1);
  await view.unmount();
});

test("the open-in list groups the applications this machine has, and hands one the folder", async () => {
  window.desktop = fakeDesktop();
  const chosen: string[] = [];
  let menu: string | null = null;
  const view = await mount(React.createElement(OpenInMenu, {
    openMenu: menu,
    onSetOpenMenu: (next: string | null) => { menu = next; },
    enabled: true,
    onOpenInApp: (appId: string) => chosen.push(appId),
  }));
  const trigger = () => query<HTMLButtonElement>(view.container, ".open-in .session-toggle");

  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  await act(async () => { trigger().click(); });
  assert.equal(menu, "workspace:open-in");

  await view.render(React.createElement(OpenInMenu, {
    openMenu: menu,
    onSetOpenMenu: (next: string | null) => { menu = next; },
    enabled: true,
    onOpenInApp: (appId: string) => chosen.push(appId),
  }));
  await act(async () => {});

  assert.deepEqual([...view.container.querySelectorAll(".open-in-group")].map((group) => group.textContent), ["Editors", "Terminals", "Files"]);
  const rows = [...view.container.querySelectorAll<HTMLButtonElement>(".open-in-popover button")];
  assert.deepEqual(rows.map((row) => item(row.textContent)), ["Cursor", "Terminal", "Finder"]);
  assert.ok(rows[0].querySelector("img"), "an application whose own icon can be read shows it");
  assert.ok(rows[1].querySelector(".open-in-icon svg"), "one whose icon cannot be read falls back to the mark for its kind");

  await act(async () => { rows[0].click(); });
  assert.deepEqual(chosen, ["cursor"]);
  assert.equal(menu, null, "choosing an application closes the list");
  await view.unmount();
});

test("the open-in button waits for a folder to hand over", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(OpenInMenu, { openMenu: null, onSetOpenMenu: () => {}, enabled: false, onOpenInApp: () => {} }));

  assert.equal(query<HTMLButtonElement>(view.container, ".open-in .session-toggle").disabled, true);
  await view.unmount();
});

test("the session panel's thread menu offers the hand-off its location allows, and nothing else", async () => {
  const calls: { worktree: boolean[]; menu: Array<string | null> } = { worktree: [], menu: [] };
  const panel = (location: ThreadLocation, openMenu: string | null, runActive = false) => renderSessionPanel({
    environment: { status: "available", files: [], branch: "main", baseline: null, additions: 0, deletions: 0 },
    hasProject: true,
    location,
    runActive,
    openMenu,
    subagents: [],
    backgroundProcesses: [], workflows: [],
    automationCount: 0,
    onSelect() {},
    onOpenAutomations() {},
    onSetOpenMenu: (menu) => { calls.menu.push(menu); },
    onSetWorktree: (worktree) => { calls.worktree.push(worktree); },
  });
  const items = (mounted: MountView) => [...mounted.container.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((element) => element.textContent);

  const view = await mount(panel({ kind: "local" }, null));
  assert.equal(view.container.querySelector('[role="menu"]'), null, "the menu stays shut until asked for");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Thread options"]').click(); });
  assert.deepEqual(calls.menu, ["session:location"]);

  await view.render(panel({ kind: "local" }, "session:location"));
  assert.deepEqual(items(view), ["Hand off to worktree"], "where a thread works is the only thing this menu decides");
  await act(async () => { item(view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]).click(); });
  assert.deepEqual(calls.worktree, [true]);

  const checkout = { id: "wt1", root: "/worktrees/repo-wt1", projectId: "p", workspaceId: "w", baseCommit: "abc1234", createdAt: 1, lastUsedAt: 1 };
  const worktree: ThreadLocation = { kind: "worktree", worktree: checkout, threads: 1 };
  await view.render(panel(worktree, "session:location"));
  assert.deepEqual(items(view), ["Return to local and remove the worktree"], "the last thread out takes the checkout with it, and the menu says so");
  assert.match(query(view.container, ".session-location-name").textContent, /Worktree/);
  await act(async () => { item(view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]).click(); });
  assert.deepEqual(calls.worktree, [true, false]);

  await view.render(panel({ kind: "worktree", worktree: checkout, threads: 3 }, "session:location"));
  assert.deepEqual(items(view), ["Return to local and leave the worktree"], "a checkout others are still in stays where it is");
  assert.match(query(view.container, ".session-location-name").textContent, /3 threads/, "the row counts them before the user acts");

  await view.render(panel(worktree, "session:location", true));
  assert.equal(query<HTMLButtonElement>(view.container, '[role="menuitem"]').disabled, true, "a running thread cannot change where it works");

  await view.render(panel({ kind: "creating" }, "session:location"));
  assert.match(query(view.container, ".session-location-name").textContent, /Creating worktree/);
  assert.equal(query<HTMLButtonElement>(view.container, '[role="menuitem"]').disabled, true, "a checkout being made cannot be asked for twice");

  await view.render(panel({ kind: "releasing" }, "session:location"));
  assert.match(query(view.container, ".session-location-name").textContent, /Removing worktree/);
  assert.equal(query(view.container, ".session-location-name .text-sweep").textContent, "Removing worktree…", "the wait reads as the same motion the app uses elsewhere");
  assert.equal(query<HTMLButtonElement>(view.container, '[role="menuitem"]').disabled, true, "a checkout being removed cannot be asked for twice");
  await view.unmount();
});

test("the session panel's branch row moves the checkout onto the branch it is given", async () => {
  window.desktop = fakeDesktop();
  const calls: { menu: Array<string | null>; checkout: Array<{ branch: string; create: boolean }> } = { menu: [], checkout: [] };
  const panel = (openMenu: string | null) => renderSessionPanel({
    environment: { status: "available", files: [], branch: "main", baseline: null, additions: 0, deletions: 0 },
    hasProject: true,
    workspaceId: "workspace-a",
    location: { kind: "local" },
    runActive: false,
    openMenu,
    subagents: [],
    backgroundProcesses: [], workflows: [],
    automationCount: 0,
    onSelect() {},
    onOpenAutomations() {},
    onSetOpenMenu: (menu) => { calls.menu.push(menu); },
    onSetWorktree() {},
    onCheckoutBranch: (branch, create) => { calls.checkout.push({ branch, create }); },
  });

  const view = await mount(panel(null));
  const trigger = query<HTMLButtonElement>(view.container, 'button[aria-label="Branch"]');
  assert.match(trigger.textContent, /main/, "the row says where the checkout already is");
  assert.equal(view.container.querySelector('[role="listbox"]'), null, "no branch is read until the list is asked for");
  await act(async () => { trigger.click(); });
  assert.deepEqual(calls.menu, ["session:branch"]);

  await view.render(panel("session:branch"));
  const menu = query(document, ".branch-menu");
  assert.ok(!view.container.contains(menu), "the list hangs outside the panel, which would crop it");
  const options = [...menu.querySelectorAll<HTMLElement>('[role="option"]')];
  assert.deepEqual(options.map((option) => option.textContent), ["main", "fix-loader", "feature-x"]);
  await act(async () => { item(options.find((option) => option.textContent === "fix-loader")).click(); });
  assert.deepEqual(calls.checkout, [{ branch: "fix-loader", create: false }]);
  assert.deepEqual(calls.menu, ["session:branch", null], "choosing one closes the list");

  await view.render(panel("session:branch"));
  const search = query<HTMLInputElement>(document, 'input[aria-label="Search branches"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  await act(async () => {
    item(setValue).call(search, "loader-fix");
    search.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
  const creating = item([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => /Create branch/.test(option.textContent)));
  await act(async () => { creating.click(); });
  assert.deepEqual(calls.checkout.at(-1), { branch: "loader-fix", create: true });

  await view.render(renderSessionPanel({ ...panel(null).props, workspaceId: undefined, hasProject: false, environment: null }));
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Branch"]').disabled, true, "with no checkout there is no branch to change");
  await view.unmount();
});

test("the session panel lists a workflow as a process and opens its panel", async () => {
  const opened: string[] = [];
  const stopped: string[] = [];
  const view = await mount(renderSessionPanel({
    environment: { status: "available", files: [], branch: "main", baseline: null, additions: 0, deletions: 0 },
    hasProject: true,
    subagents: [],
    backgroundProcesses: [{ id: "bash-1", kind: "shell", description: "npm run dev" }],
    workflows: [liveWorkflow],
    automationCount: 0,
    onSelect() {},
    onOpenAutomations() {},
    onOpenWorkflow: (id) => { opened.push(id); },
    onStopProcess: (id) => { stopped.push(id); },
  }));

  assert.match(view.container.textContent, /2 running/);
  assert.match(view.container.textContent, /Running · 2\/3 agents/);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open review-changes workflow"]').click(); });
  assert.deepEqual(opened, ["wf-1"]);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Stop review-changes"]').click(); });
  assert.deepEqual(stopped, ["wf-1"]);

  await view.render(renderSessionPanel({
    environment: null, hasProject: true, subagents: [], backgroundProcesses: [], workflows: [{ ...liveWorkflow, status: "completed" }], automationCount: 0,
    onSelect() {}, onOpenAutomations() {}, onOpenWorkflow() {}, onStopProcess() {},
  }));
  assert.equal(view.container.querySelector('button[aria-label="Stop review-changes"]'), null, "a workflow that ended keeps its row without a stop");
  await view.unmount();
});
