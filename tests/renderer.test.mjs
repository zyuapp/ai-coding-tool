import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "localStorage", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "navigator", "File", "Blob", "FileReader", "innerWidth", "innerHeight"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
let animationTime = 0;
for (const [name, value] of [["requestAnimationFrame", (fn) => setTimeout(() => fn(animationTime += 33), 0)], ["cancelAnimationFrame", (id) => clearTimeout(id)]]) {
  Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(dom.window, name, { configurable: true, value });
}
/** jsdom has no ResizeObserver, and the transcript's scrolling is driven by one. */
class ResizeObserverStub {
  static live = [];
  constructor(callback) { this.callback = callback; ResizeObserverStub.live.push(this); }
  observe() {}
  unobserve() {}
  disconnect() { ResizeObserverStub.live = ResizeObserverStub.live.filter((observer) => observer !== this); }
}
for (const target of [globalThis, dom.window]) {
  Object.defineProperty(target, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.Element.prototype.getAnimations = () => [];

/** xterm ships a broken `module` field, so it is bundled here the way the real build bundles it. */
const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom", ssr: { noExternal: [/^@xterm\//] } });
const { SessionPanel } = await vite.ssrLoadModule("/src/renderer/components/SessionPanel.tsx");
const { SubagentInspector } = await vite.ssrLoadModule("/src/renderer/components/SubagentInspector.tsx");
const { AgentsPanel, matchSubagents } = await vite.ssrLoadModule("/src/renderer/components/SubagentList.tsx");
const { WorkspaceHeader } = await vite.ssrLoadModule("/src/renderer/components/WorkspaceHeader.tsx");
const { MarkdownMessage } = await vite.ssrLoadModule("/src/renderer/components/MarkdownMessage.tsx");
const { useTaskWorkspace } = await vite.ssrLoadModule("/src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await vite.ssrLoadModule("/src/renderer/App.tsx");
const { TaskComposer } = await vite.ssrLoadModule("/src/renderer/components/TaskComposer.tsx");
const { drawAnnotations, wrapLabel } = await vite.ssrLoadModule("/src/renderer/components/ImageAnnotator.tsx");
const { SettingsPanel } = await vite.ssrLoadModule("/src/renderer/components/SettingsPanel.tsx");
const { ConversationTimeline, groupTimeline } = await vite.ssrLoadModule("/src/renderer/components/ConversationTimeline.tsx");
const { RevealedTextProvider, StreamingText } = await vite.ssrLoadModule("/src/renderer/components/StreamingText.tsx");
const { AutomationPanel, automationStatusLabel, formatCountdown } = await vite.ssrLoadModule("/src/renderer/components/AutomationPanel.tsx");
const { ProjectSidebar } = await vite.ssrLoadModule("/src/renderer/components/ProjectSidebar.tsx");
const { SideChat } = await vite.ssrLoadModule("/src/renderer/components/SideChat.tsx");
const { WorkflowPanel } = await vite.ssrLoadModule("/src/renderer/components/WorkflowPanel.tsx");

test.after(async () => {
  await vite.close();
  dom.window.close();
});

async function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test("assistant markdown renders GFM without executing raw HTML", async () => {
  const view = await mount(React.createElement(MarkdownMessage, null, "## Heading\n\n**Bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] Done\n\n<script>bad()</script>"));

  assert.equal(view.container.querySelector("h2")?.textContent, "Heading");
  assert.equal(view.container.querySelector("strong")?.textContent, "Bold");
  assert.equal(view.container.querySelector("table td")?.textContent, "1");
  assert.equal(view.container.querySelector('input[type="checkbox"]')?.checked, true);
  assert.equal(view.container.querySelector("script"), null);
  await view.unmount();
});

test("assistant markdown preserves nested, quoted, linked, and fenced structures", async () => {
  const markdown = [
    "> **Quoted** guidance",
    ">",
    "> - Parent",
    ">   - Child",
    "",
    "A [safe link](https://example.com) and ~~obsolete text~~.",
    "",
    "```typescript",
    "const first = 1;",
    "",
    "const second = 2;",
    "```",
  ].join("\n");
  const view = await mount(React.createElement(MarkdownMessage, null, markdown));

  assert.equal(view.container.querySelector("blockquote strong")?.textContent, "Quoted");
  assert.equal(view.container.querySelector("blockquote ul ul li")?.textContent, "Child");
  assert.equal(view.container.querySelector("a")?.target, "_blank");
  assert.equal(view.container.querySelector("a")?.rel, "noreferrer");
  assert.equal(view.container.querySelector("del")?.textContent, "obsolete text");
  assert.match(view.container.querySelector("pre code.language-typescript")?.textContent ?? "", /first = 1;\n\nconst second = 2;/);
  await view.unmount();
});

test("a thread link opens that thread in place, and nothing else under the scheme is a link", async () => {
  const selected = [];
  const markdown = [
    "See [the sidebar work](claudex://thread/task-9) for how it went.",
    "",
    "Not [an archive](claudex://archive/task-9) and not [the docs](https://example.com).",
  ].join("\n");
  const view = await mount(React.createElement(MarkdownMessage, { onSelectTask: (taskId) => selected.push(taskId) }, markdown));

  const links = [...view.container.querySelectorAll("a")];
  assert.deepEqual(links.map((link) => link.textContent), ["the sidebar work", "the docs"], "an unknown claudex:// path stays plain text");
  assert.match(view.container.textContent, /Not an archive and not the docs/);

  await act(async () => { links[0].click(); });
  assert.deepEqual(selected, ["task-9"]);
  assert.equal(links[0].target, "", "an in-app link does not open a browser tab");

  await act(async () => { links[1].click(); });
  assert.deepEqual(selected, ["task-9"], "an ordinary link still just follows its href");
  assert.equal(links[1].target, "_blank");
  await view.unmount();
});

test("a thread link is plain text where no thread can be selected", async () => {
  const view = await mount(React.createElement(MarkdownMessage, null, "See [the sidebar work](claudex://thread/task-9)."));

  assert.equal(view.container.querySelector("a"), null);
  assert.match(view.container.textContent, /See the sidebar work\./);
  await view.unmount();
});

const subagents = [
  { id: "working", description: "Working agent", status: "working", lastToolName: "Read", totalTokens: 321, startedAt: 1, activity: [] },
  { id: "complete", description: "Complete agent", status: "completed", summary: "Done", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "failed", description: "Failed agent", status: "failed", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "stopped", description: "Stopped agent", status: "stopped", startedAt: 1, finishedAt: 2, activity: [] },
];

test("session panel renders Git and subagent states and selects an agent", async () => {
  let selected;
  let openedAutomations = 0;
  const view = await mount(React.createElement(SessionPanel, {
    environment: { status: "available", files: [" M file"], branch: "main", additions: 4, deletions: 2 },
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
  await act(async () => { view.container.querySelector('button[aria-label="Open Working agent details"]').click(); });
  assert.equal(selected, "working");

  const automations = view.container.querySelector('button[aria-label="Open Automation panel"]');
  assert.equal(automations.querySelector(".session-count").textContent, "1", "the card only counts automations");
  assert.equal(automations.querySelector('input[aria-label="Automation schedule"]'), null, "editing happens in the sliding panel");
  await act(async () => { automations.click(); });
  assert.equal(openedAutomations, 1);

  for (const [environment, message] of [
    [null, "Reopen the project to inspect Git"],
    [{ status: "unknown", workspaceId: "gone" }, "Workspace is no longer registered"],
    [{ status: "unavailable", reason: "missing" }, "Workspace is missing"],
    [{ status: "error", message: "git failed" }, "git failed"],
  ]) {
    await view.render(React.createElement(SessionPanel, { environment, hasProject: true, subagents: [], backgroundProcesses: [], workflows: [], automationCount: 0, onSelect() {}, onOpenAutomations() {} }));
    assert.match(view.container.textContent, new RegExp(message));
  }
  await view.render(React.createElement(SessionPanel, { environment: null, hasProject: false, subagents: [], backgroundProcesses: [], workflows: [], automationCount: 0, onSelect() {}, onOpenAutomations() {} }));
  assert.match(view.container.textContent, /Open a project to inspect Git/);
  await view.unmount();
});

test("the session panel lists the run's background processes and stops the one asked for", async () => {
  const stopped = [];
  const processes = [
    { id: "bash-1", kind: "shell", description: "npm run dev" },
    { id: "watch-1", kind: "monitor", description: "Deploy events", stopping: true },
  ];
  const view = await mount(React.createElement(SessionPanel, {
    environment: { status: "available", files: [], branch: "main", additions: 0, deletions: 0 },
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
  await act(async () => { view.container.querySelector('button[aria-label="Stop npm run dev"]').click(); });
  assert.deepEqual(stopped, ["bash-1"]);
  assert.equal(view.container.querySelector('button[aria-label="Stop Deploy events"]').disabled, true, "a stop already asked for cannot be asked for twice");

  await view.render(React.createElement(SessionPanel, {
    environment: null, hasProject: true, subagents: [], backgroundProcesses: [], workflows: [], automationCount: 0, onSelect() {}, onOpenAutomations() {}, onStopProcess() {},
  }));
  assert.match(view.container.textContent, /No background processes/);
  await view.unmount();
});

test("the subagents panel windows a large roster, leads with failures, and filters it", async () => {
  const many = Array.from({ length: 1000 }, (_, index) => ({
    id: `agent-${index}`,
    description: `Agent ${index}`,
    status: index === 700 ? "failed" : index % 3 === 0 ? "working" : "completed",
    ...(index % 3 === 0 ? { lastToolName: "Grep" } : {}),
    startedAt: index,
    activity: [],
  }));
  /** jsdom measures every row at nothing, which would fit the whole roster on one screen. */
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() { return this.classList?.contains("subagent-row") ? 51 : 0; },
  });
  const view = await mount(React.createElement(AgentsPanel, { subagents: many, onSelect() {} }));
  const list = view.container.querySelector(".agents-panel-list");
  Object.defineProperty(list, "offsetWidth", { value: 360 });
  Object.defineProperty(list, "offsetHeight", { value: 720 });
  await act(async () => { for (const observer of [...ResizeObserverStub.live]) observer.callback([], observer); });

  const rows = view.container.querySelectorAll(".subagent-row").length;
  assert.ok(rows > 0 && rows < 80, `a windowed list should draw a screenful, drew ${rows}`);
  assert.match(view.container.querySelector(".subagent-group").textContent, /Failed/);
  assert.match(view.container.textContent, /Agent 700/);

  await act(async () => { view.container.querySelector('.agent-status-strip button.failed').click(); });
  assert.deepEqual(
    [...view.container.querySelectorAll(".subagent-list strong")].map((node) => node.textContent),
    ["Agent 700"],
  );

  delete window.HTMLElement.prototype.offsetHeight;
  await view.unmount();
});

test("the subagent search keeps what the query names, and the status keeps its own", async () => {
  const subagents = [
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
  const subagent = {
    ...subagents[0],
    summary: "Renderer inspected",
    activity: [
      { id: "text", kind: "text", text: "Reading", at: 1 },
      { id: "tool", kind: "tool", title: "Read", text: "{\"file\":\"App.tsx\"}", at: 2 },
    ],
  };
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose: () => { closed = true; } }));

  assert.match(view.container.textContent, /Renderer inspected/);
  assert.match(view.container.textContent, /321 tokens/);
  assert.match(view.container.textContent, /Reading/);
  assert.equal(view.container.querySelector("details summary").textContent, "Read");
  await act(async () => { view.container.querySelector('button[aria-label="Close subagent details"]').click(); });
  assert.equal(closed, true);
  await view.unmount();
});

test("a side chat opened from the right panel sends on the side channel and stops on request", async () => {
  localStorage.clear();
  localStorage.setItem("claudex.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "main-task",
      title: "Main task",
      executionPolicy: "confirm",
      messages: [],
      continuation: { provider: "claude", value: "main-session" },
      continuationStatus: "available",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      updatedAt: 1,
    }] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  await act(async () => { view.container.querySelector('button[aria-label="Add right panel tab"]').click(); });
  await act(async () => { [...view.container.querySelectorAll('.right-dock-add button')].find((button) => button.textContent.includes("Side chat")).click(); });

  const textarea = view.container.querySelector('textarea[aria-label="Side chat prompt"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    setValue.call(textarea, "What does this code do?");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "What does this code do?" }));
  });
  await act(async () => { view.container.querySelector('button[aria-label="Send side chat message"]').click(); });

  const [start] = desktop.sent;
  assert.equal(start.channel, "side");
  assert.equal(start.forkContinuation, true);
  assert.deepEqual(start.continuation, { provider: "claude", value: "main-session" });
  assert.equal(textarea.value, "");

  assert.ok(
    desktop.persisted.every((delta) => (delta.tasks ?? []).every((entry) => entry.task.id !== start.taskId)),
    "a side chat's thread never reaches the store",
  );

  await act(async () => { view.container.querySelector('button[aria-label="Stop side chat"]').click(); });
  assert.deepEqual(desktop.sent.at(-1), { type: "cancel", taskId: start.taskId, runId: start.runId });
  await view.unmount();
});

test("workspace header keeps session summary and right panel controls separate", async () => {
  let sidebarToggles = 0;
  let summaryToggles = 0;
  let rightPanelToggles = 0;
  const view = await mount(React.createElement(WorkspaceHeader, {
    folder: "/project",
    sidebarOpen: false,
    sessionPanelOpen: true,
    rightDockOpen: true,
    workingSubagents: 2,
    onToggleSidebar: () => { sidebarToggles += 1; },
    onToggleSessionPanel: () => { summaryToggles += 1; },
    onToggleRightDock: () => { rightPanelToggles += 1; },
  }));

  assert.equal(view.container.querySelector('button[aria-label="Hide right panel"]').getAttribute("aria-pressed"), "true");
  assert.equal(view.container.querySelector('button[aria-label="Hide session summary"]').getAttribute("aria-pressed"), "true");
  assert.match(view.container.textContent, /2/);
  await act(async () => {
    view.container.querySelector('button[aria-label="Show sidebar"]').click();
    view.container.querySelector('button[aria-label="Hide session summary"]').click();
    view.container.querySelector('button[aria-label="Hide right panel"]').click();
  });
  assert.equal(sidebarToggles, 1);
  assert.equal(summaryToggles, 1);
  assert.equal(rightPanelToggles, 1);
  await view.unmount();
});

test("the sidebar steps through visited threads", async () => {
  let backSteps = 0;
  const view = await mount(React.createElement(ProjectSidebar, {
    compactOpen: false,
    inactive: false,
    projects: [],
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(),
    automatedTaskIds: new Set(),
    worktreeTaskIds: new Set(),
    projectsOpen: true,
    recentsOpen: true,
    openMenu: null,
    settingsOpen: false,
    canGoBack: true,
    canGoForward: false,
    onGoBack: () => { backSteps += 1; },
    onGoForward() {},
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetProjectsOpen() {}, onSetRecentsOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onMoveTask() {}, onOpenSettings() {},
  }));

  assert.ok(view.container.querySelector('button[aria-label="Go forward"]').disabled, "nothing ahead to go forward to");
  await act(async () => { view.container.querySelector('button[aria-label="Go back"]').click(); });
  assert.equal(backSteps, 1);
  await view.unmount();
});

async function mountWorkspace(desktop) {
  localStorage.clear();
  window.desktop = desktop;
  let latest;
  function Harness() {
    latest = useTaskWorkspace();
    return null;
  }
  const view = await mount(React.createElement(Harness));
  return { view, get: () => latest };
}

function fakeDesktop(overrides = {}) {
  const sent = [];
  const persisted = [];
  const acknowledged = [];
  const automationChanges = [];
  const browserCalls = [];
  const terminalCalls = [];
  let browserEvent;
  let terminalEvent;
  let shortcutPressed;
  let shortcutCaptured;
  let listener;
  let automationsChanged;
  let fireAutomation;
  let threadRequested;
  let openProject;
  const threadAnswers = [];
  let unsubscribed = false;
  return {
    sent,
    persisted,
    acknowledged,
    automationChanges,
    get listener() { return listener; },
    get automationsChanged() { return automationsChanged; },
    get fireAutomation() { return fireAutomation; },
    threadAnswers,
    askThreads: (request) => threadRequested(request),
    openProjectFromCli: (workspace) => openProject(workspace),
    get unsubscribed() { return unsubscribed; },
    openFolder: async () => null,
    onOpenProject: (next) => { openProject = next; return () => {}; },
    cliStatus: async () => ({ state: "missing", path: "/usr/local/bin/claudex" }),
    installCli: async () => ({ state: "installed", path: "/usr/local/bin/claudex" }),
    uninstallCli: async () => ({ state: "missing", path: "/usr/local/bin/claudex" }),
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/scratch" }),
    commands: async () => ({ status: "available", commands: [] }),
    computerUsePermissions: async () => ({ accessibility: true, screenRecording: true }),
    planUsage: async () => ({ status: "not-applicable" }),
    enableComputerUse: async () => ({ accessibility: false, screenRecording: false }),
    restartForComputerUse() {},
    changedFiles: async () => ({ status: "available", files: [], branch: "main", additions: 0, deletions: 0 }),
    branches: async () => ({ status: "available", branches: ["main", "fix-loader", "feature-x"], current: "main" }),
    checkoutBranch: async () => {},
    createBranch: async () => {},
    createWorktree: async () => ({ id: "wt1", root: "/worktrees/repo-wt1", workspaceId: "worktree-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 }),
    releaseWorktree: async () => ({ commit: null, shortCommit: null, ref: null }),
    deleteWorktree: async () => {},
    saveAttachment: async () => "/tmp/claudex-attachments/pasted.png",
    suggestTaskTitle: async () => null,
    loadTaskStore: async () => null,
    loadSubagentActivity: async () => [],
    persistTaskStore: async (delta) => { persisted.push(delta); },
    send: (command) => sent.push(command),
    onAgentEvent: (next) => { listener = next; return () => { unsubscribed = true; }; },
    listAutomations: async () => [],
    saveAutomation: async (draft) => ({ ...draft, id: "automation-1", paused: false, createdAt: 1, updatedAt: 1, runCount: 0, nextRunAt: 2 }),
    updateAutomation: async (taskId, patch) => { automationChanges.push({ taskId, patch }); return { taskId, ...patch, id: "automation-1", paused: false, createdAt: 1, updatedAt: 2, runCount: 0, nextRunAt: 2 }; },
    deleteAutomation: async (taskId) => { automationChanges.push({ taskId, deleted: true }); return true; },
    runAutomationNow: async () => "succeeded",
    onAutomationsChanged: (next) => { automationsChanged = next; return () => {}; },
    onAutomationFire: (next) => { fireAutomation = next; return () => {}; },
    acknowledgeAutomation: (ack) => acknowledged.push(ack),
    onThreadRequest: (next) => { threadRequested = next; return () => {}; },
    answerThreadRequest: (response) => threadAnswers.push(response),
    browserCalls,
    get browserEvent() { return browserEvent; },
    shortcuts: [],
    captures: [],
    pressShortcut: (action, surface = "any") => shortcutPressed({ action, surface }),
    captureShortcut: (binding) => shortcutCaptured(binding),
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
    onBrowserEvent: (next) => { browserEvent = next; return () => {}; },
    onBrowserFind: () => () => {},
    terminalCalls,
    get terminalEvent() { return terminalEvent; },
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
    setShortcuts(overrides) { this.shortcuts.push(overrides); },
    setShortcutCapture(capturing) { this.captures.push(capturing); },
    onShortcut: (next) => { shortcutPressed = next; return () => {}; },
    onShortcutCaptured: (next) => { shortcutCaptured = next; return () => {}; },
    closeWindow: () => { browserCalls.push(["close-window"]); },
    ...overrides,
  };
}

test("the general section installs the claudex command and takes it back", async () => {
  const calls = [];
  let status = { state: "missing", path: "/usr/local/bin/claudex" };
  window.desktop = fakeDesktop({
    cliStatus: async () => status,
    installCli: async () => { calls.push("install"); status = { state: "installed", path: "/usr/local/bin/claudex" }; return status; },
    uninstallCli: async () => { calls.push("uninstall"); status = { state: "missing", path: "/usr/local/bin/claudex" }; return status; },
  });
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, archivedTasks: [], allowedOrigins: [], shortcuts: [], capturingShortcut: null, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => {});
  const button = () => view.container.querySelector(".setting-row-action button");
  assert.match(view.container.textContent, /Terminal command/);
  assert.equal(button().textContent, "Install");

  await act(async () => { button().click(); });
  assert.equal(button().textContent, "Uninstall");
  assert.match(view.container.textContent, /Installed at \/usr\/local\/bin\/claudex/);

  await act(async () => { button().click(); });
  assert.deepEqual(calls, ["install", "uninstall"]);
  assert.equal(button().textContent, "Install");
  await view.unmount();
});

test("an install the password prompt refuses is reported, not swallowed", async () => {
  window.desktop = fakeDesktop({ installCli: async () => { throw new Error("Cancelled."); } });
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, archivedTasks: [], allowedOrigins: [], shortcuts: [], capturingShortcut: null, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => {});
  await act(async () => { view.container.querySelector(".setting-row-action button").click(); });

  assert.match(view.container.querySelector(".settings-error").textContent, /Cancelled/);
  assert.equal(view.container.querySelector(".setting-row-action button").textContent, "Install");
  await view.unmount();
});

test("computer-use settings refresh permissions", async () => {
  let restarted = false;
  let checks = 0;
  const requested = [];
  window.desktop = fakeDesktop({
    enableComputerUse: async (permission) => {
      requested.push(permission);
      return { accessibility: false, screenRecording: false };
    },
    computerUsePermissions: async () => [
      { accessibility: false, screenRecording: false },
      { accessibility: true, screenRecording: true },
    ][checks++],
    restartForComputerUse: () => { restarted = true; },
  });
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, initialSection: "computer-use", archivedTasks: [], allowedOrigins: [], shortcuts: [], capturingShortcut: null, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => {});
  assert.match(view.container.textContent, /Accessibility/);
  assert.match(view.container.textContent, /Setup required/);
  assert.match(view.container.textContent, /Enable Accessibility/);
  assert.match(view.container.textContent, /Enable Screen Recording/);
  assert.equal(view.container.querySelectorAll(".setting-row-action button").length, 2);
  const buttons = view.container.querySelectorAll(".setting-row-action button");
  await act(async () => { buttons[0].click(); });
  await act(async () => { buttons[1].click(); });
  assert.deepEqual(requested, ["accessibility", "screenRecording"]);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.match(view.container.textContent, /Setup complete/);
  assert.equal(view.container.querySelectorAll(".setting-row-action em.granted").length, 2);
  assert.match(view.container.textContent, /Done/);
  assert.match(view.container.textContent, /Restart Claudex/);
  await act(async () => { view.container.querySelector(".settings-restart button").click(); });
  assert.equal(restarted, true);
  await view.unmount();
});

test("the usage section draws a bar per plan window, and reports a reader that cannot answer", async () => {
  const windows = {
    status: "available",
    subscription: "max",
    windows: [
      { id: "five_hour", label: "Current session", utilization: 17, resetsAt: "2026-08-18T08:19:00Z" },
      { id: "model:Fable", label: "Current week (Fable)", utilization: 96, resetsAt: null },
    ],
  };
  let answer = windows;
  window.desktop = fakeDesktop({ planUsage: async () => answer });
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, archivedTasks: [], allowedOrigins: [], shortcuts: [], capturingShortcut: null, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => { [...view.container.querySelectorAll(".settings-sidebar nav button")].find((button) => button.textContent === "Usage").click(); });

  assert.match(view.container.textContent, /Max plan/);
  assert.match(view.container.textContent, /Current session/);
  assert.match(view.container.textContent, /17% used/);
  assert.match(view.container.textContent, /96% used/);
  const fills = view.container.querySelectorAll(".usage-window-fill");
  assert.equal(fills.length, 2);
  assert.equal(fills[0].style.width, "17%");
  assert.equal(fills[0].classList.contains("high"), false);
  assert.equal(fills[1].classList.contains("high"), true);

  answer = { status: "unavailable", message: "This build of the Claude SDK does not report plan usage." };
  await act(async () => { view.container.querySelector(".settings-group-action button").click(); });
  assert.equal(view.container.querySelectorAll(".usage-window-fill").length, 0);
  assert.match(view.container.querySelector(".settings-error").textContent, /does not report plan usage/);
  await view.unmount();
});

test("a usage read that rejects reports instead of breaking the panel", async () => {
  window.desktop = fakeDesktop({ planUsage: async () => { throw new Error("Untrusted IPC sender."); } });
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, archivedTasks: [], allowedOrigins: [], shortcuts: [], capturingShortcut: null, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => { [...view.container.querySelectorAll(".settings-sidebar nav button")].find((button) => button.textContent === "Usage").click(); });

  assert.match(view.container.querySelector(".settings-error").textContent, /Untrusted IPC sender/);
  await view.unmount();
});

test("computer-use setup events open settings directly", async () => {
  localStorage.clear();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  const textarea = view.container.querySelector('textarea[aria-label="Task prompt"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;

  await act(async () => {
    setValue.call(textarea, "Use the Calculator app");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Use the Calculator app" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { view.container.querySelector('button[aria-label="Send task"]').click(); });
  const start = desktop.sent[0];
  await act(async () => {
    desktop.listener({ type: "computer-use.setup-required", taskId: start.taskId, runId: start.runId, sequence: 1 });
  });

  assert.ok(view.container.querySelector(".settings-view"));
  assert.equal(view.container.querySelector(".computer-use-card"), null);
  await act(async () => { view.container.querySelector(".settings-back").click(); });
  assert.equal(view.container.querySelector(".settings-view"), null);
  await view.unmount();
});

test("context usage stays within 100% when the window shrinks below the used tokens", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(TaskComposer, {
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
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

  const usage = view.container.querySelector(".context-usage");
  assert.equal(usage.getAttribute("aria-label"), "100% of context window used");
  assert.match(usage.textContent, /100% used \(0% left\)/);
  assert.match(usage.textContent, /620K \/ 200K tokens used/);
  await view.unmount();
});

test("a side chat composes with everything the main composer has", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues.", argumentHint: "" },
    ] }),
  });
  const decisions = [];
  const policies = [];
  const chatTask = {
    id: "chat-1",
    title: "Side chat",
    executionPolicy: "allow-edits",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    contextUsage: { tokens: 120_000, limit: 200_000, model: "claude-opus-5" },
  };
  const sideChatProps = (prompt, onPrompt) => ({
    chat: {
      id: "chat-1",
      title: "Chat 1",
      sourceTaskId: "main-task",
      prompt: "",
      error: null,
      task: chatTask,
      running: true,
      compacting: false,
      status: "running",
      streamingTail: null,
      queuedMessages: [],
      running: true,
      approval: { approvalId: "approval-1", taskId: "chat-1", runId: "run-1", title: "Run a command", description: "ls", toolName: "Bash", input: { command: "ls" } },
      prompt,
    },
    source: { ...chatTask, id: "main-task", title: "Main", continuation: { provider: "claude", value: "main-session" } },
    onPrompt,
    onSend() {},
    onCancel() {},
    onDecide(allow) { decisions.push(allow); },
    onPolicyChange(policy) { policies.push(policy); },
    onModelChange() {},
    onEffortChange() {},
    onSteerQueued() {},
    onDropQueued() {},
    onClose() {},
    onSelectTask() {},
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return React.createElement(SideChat, sideChatProps(prompt, setPrompt));
  }
  const view = await mount(React.createElement(Harness));
  await act(async () => {});

  const usage = view.container.querySelector(".context-usage");
  assert.equal(usage.getAttribute("aria-label"), "60% of context window used");
  assert.match(usage.textContent, /120K \/ 200K tokens used/);

  const settings = view.container.querySelectorAll(".composer-settings .setting-menu");
  assert.equal(settings.length, 3, "permission mode, model, and effort");
  assert.match(settings[0].textContent, /Allow all edit/, "the chat's own policy is selected, not the first one on offer");
  await act(async () => { [...settings[0].querySelectorAll(".setting-option")].find((option) => option.textContent.includes("Auto mode")).click(); });
  assert.deepEqual(policies, ["autonomous"]);

  const approval = view.container.querySelector(".approval-card");
  assert.match(approval.textContent, /Run a command/);
  await act(async () => { [...approval.querySelectorAll("button")].at(-1).click(); });
  assert.deepEqual(decisions, [true]);

  const textarea = view.container.querySelector('textarea[aria-label="Side chat prompt"]');
  assert.ok(view.container.querySelector(".composer-wrap.side .composer"), "the side chat uses the shared composer");

  const paste = new dom.window.Event("paste", { bubbles: true });
  paste.clipboardData = { files: [new dom.window.File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })] };
  await act(async () => { textarea.dispatchEvent(paste); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.container.querySelectorAll(".attachment-chip").length, 1, "a side chat takes a pasted image");
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
    return React.createElement(TaskComposer, {
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
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
  const textarea = view.container.querySelector('textarea[aria-label="Task prompt"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  const scrolled = [];
  const originalScrollIntoView = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ id: this.id, options }); };
  textarea.attachEvent = () => {};
  textarea.detachEvent = () => {};

  await act(async () => {
    textarea.focus();
    setValue.call(textarea, "/s");
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
    return React.createElement(TaskComposer, {
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
      model: "opus",
      runActive: false,
      history: ["first question", "first question", "second question"],
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
  const textarea = view.container.querySelector('textarea[aria-label="Task prompt"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  textarea.attachEvent = () => {};
  textarea.detachEvent = () => {};
  const press = (key) => act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key })); });
  const type = (text) => act(async () => {
    setValue.call(textarea, text);
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });

  await act(async () => { textarea.focus(); });
  await type("a draft");
  await press("ArrowUp");
  assert.equal(textarea.value, "second question", "up recalls the newest sent prompt");
  await press("ArrowUp");
  assert.equal(textarea.value, "first question", "up again walks back, skipping the repeated send");
  await press("ArrowUp");
  assert.equal(textarea.value, "first question", "the oldest entry is the end of the line");
  await press("ArrowDown");
  assert.equal(textarea.value, "second question");
  await press("ArrowDown");
  assert.equal(textarea.value, "a draft", "down past the newest restores the stashed draft");
  await press("ArrowDown");
  assert.equal(textarea.value, "a draft", "with no recall going, down is just a caret move");

  await press("ArrowUp");
  await type("second question edited");
  await press("ArrowUp");
  assert.equal(textarea.value, "second question", "editing a recalled prompt starts recall over from the newest");

  await type("line one\nline two");
  await act(async () => { textarea.setSelectionRange(textarea.value.length, textarea.value.length); });
  await press("ArrowUp");
  assert.equal(textarea.value, "line one\nline two", "up below the first line moves the caret, not the history");
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
    return React.createElement(TaskComposer, {
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
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
  const textarea = view.container.querySelector('textarea[aria-label="Task prompt"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  textarea.attachEvent = () => {};
  textarea.detachEvent = () => {};
  const type = async (value, inputType = "insertText") => {
    await act(async () => {
      textarea.focus();
      setValue.call(textarea, value);
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

function recordingContext() {
  const calls = { text: [], strokes: 0, fills: 0 };
  return {
    calls,
    measureText: (value) => ({ width: value.length * 7 }),
    fillText: (value) => calls.text.push(value),
    strokeRect: () => { calls.strokes += 1; },
    fillRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    fill: () => { calls.fills += 1; },
  };
}

test("arrows draw without a mark and never renumber the boxes around them", () => {
  const context = recordingContext();
  drawAnnotations(context, [
    { kind: "box", x: 0.1, y: 0.1, width: 0.2, height: 0.2, text: "first" },
    { kind: "arrow", x: 0.8, y: 0.8, width: -0.3, height: -0.3, text: "" },
    { kind: "box", x: 0.5, y: 0.5, width: 0.2, height: 0.2, text: "second" },
  ], 1000, 800);

  assert.deepEqual(context.calls.text, ["1. first", "2. second"]);
  assert.equal(context.calls.strokes, 2);
  assert.equal(context.calls.fills, 1);
});

test("a long note wraps onto several chip lines instead of running off the image", () => {
  const context = recordingContext();
  drawAnnotations(context, [
    { kind: "box", x: 0.1, y: 0.4, width: 0.2, height: 0.2, text: "this note is long enough to need more than one line of chip" },
  ], 1000, 800);

  assert.ok(context.calls.text.length > 1);
  assert.equal(context.calls.text.join(" "), "1. this note is long enough to need more than one line of chip");
});

test("a word wider than the chip is split rather than overflowing it", () => {
  const context = recordingContext();
  assert.deepEqual(wrapLabel(context, "aaaaaaaaaa bb", 35), ["aaaaa", "aaaaa", "bb"]);
});

test("the side surface keeps the slash palette but never offers to fork a fork", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues.", argumentHint: "" },
    ] }),
  });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return React.createElement(TaskComposer, {
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      surface: "side",
      mode: "confirm",
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
  const textarea = view.container.querySelector('textarea[aria-label="Side chat prompt"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  textarea.attachEvent = () => {};
  textarea.detachEvent = () => {};
  await act(async () => {
    textarea.focus();
    setValue.call(textarea, "/s");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "/s" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });

  assert.deepEqual([...view.container.querySelectorAll('[role="option"] strong')].map((node) => node.textContent), ["/security-scan"]);
  assert.equal(view.container.querySelector('button[aria-label="Send side chat message"]').disabled, false);
  await view.unmount();
});

test("a pasted image becomes an attachment chip and is saved on send", async () => {
  window.desktop = fakeDesktop();
  let sent = null;
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return React.createElement(TaskComposer, {
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
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
  const send = view.container.querySelector('button[aria-label="Send task"]');
  assert.equal(send.disabled, true);

  const paste = new dom.window.Event("paste", { bubbles: true });
  paste.clipboardData = { files: [new dom.window.File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })] };
  await act(async () => { view.container.querySelector("textarea").dispatchEvent(paste); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.equal(view.container.querySelectorAll(".attachment-chip").length, 1);
  assert.equal(view.container.querySelector('button[aria-label="Send task"]').disabled, false);

  await act(async () => { view.container.querySelector('button[aria-label="Send task"]').click(); });
  assert.deepEqual(sent, [{ path: "/tmp/claudex-attachments/pasted.png", labels: [] }]);
  assert.equal(view.container.querySelectorAll(".attachment-chip").length, 0);
  await view.unmount();
});

test("a long paste is held aside as a pill, and a short one lands in the draft", async () => {
  window.desktop = fakeDesktop();
  const added = [];
  const removed = [];
  const blob = Array.from({ length: 40 }, (_, line) => `line ${line}`).join("\n");
  function Harness({ pastes }) {
    const [prompt, setPrompt] = React.useState("");
    return React.createElement(TaskComposer, {
      prompt,
      folder: "/project",
      workspaceId: "workspace-1",
      mode: "confirm",
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
  const textarea = view.container.querySelector("textarea");

  function pasteText(text) {
    const event = new dom.window.Event("paste", { bubbles: true, cancelable: true });
    event.clipboardData = { files: [], getData: () => text };
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
  const pill = view.container.querySelector(".paste-pill");
  assert.match(pill.textContent, /Pasted text #1/);
  assert.match(pill.textContent, /40 lines/);
  assert.equal(view.container.querySelector('button[aria-label="Send task"]').disabled, false, "a paste alone is enough to send");

  await act(async () => { view.container.querySelector('button[aria-label="Read pasted text 1"]').click(); });
  assert.match(document.body.querySelector(".paste-full").textContent, /line 39/);
  await act(async () => { document.body.querySelector(".viewer-close").click(); });
  assert.equal(document.body.querySelector(".paste-full"), null);

  await act(async () => { view.container.querySelector('button[aria-label="Remove pasted text 1"]').click(); });
  assert.deepEqual(removed, ["paste-1"]);
  await view.unmount();
});

function seedLegacyWorkspace() {
  const legacyTask = {
    id: "legacy-task", title: "Legacy", folder: "/project", sessionId: "session-1", mode: "default",
    messages: [], changedFiles: [], updatedAt: 1,
  };
  localStorage.clear();
  localStorage.setItem("claudex.tasks.v1", JSON.stringify([legacyTask]));
  localStorage.setItem("claudex.projects.v1", JSON.stringify(["/project"]));
  localStorage.setItem("claudex.last-folder.v1", "/project");
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
  localStorage.setItem("claudex.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [task] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
}

test("closing subagent details returns to the agents tab", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  assert.ok(view.container.querySelector('[aria-label="Choose a right panel"]'));
  assert.equal(view.container.querySelector('.right-dock [role="tab"]'), null);
  await act(async () => { view.container.querySelector('button[aria-label="Open Subagents panel"]').click(); });
  assert.match(view.container.querySelector('.right-dock [role="tab"]').textContent, /Subagents/);
  await act(async () => { view.container.querySelector('button[aria-label="Open Complete agent details"]').click(); });
  assert.ok(view.container.querySelector(".subagent-inspector"));
  await act(async () => { view.container.querySelector('button[aria-label="Close subagent details"]').click(); });
  assert.ok(view.container.querySelector('.agents-panel button[aria-label="Open Complete agent details"]'));

  await view.unmount();
});

test("session summary stays outside the tabbed right panel", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show session summary"]').click(); });
  assert.ok(view.container.querySelector('.workspace > .session-panel'));
  assert.equal(view.container.querySelector('.right-dock .session-panel'), null);
  await act(async () => { view.container.querySelector('button[aria-label="Open Complete agent details"]').click(); });
  assert.equal(view.container.querySelector('.workspace > .session-panel'), null);
  assert.ok(view.container.querySelector('.right-dock .subagent-inspector'));

  await view.unmount();
});

test("right panel keeps multiple side chats mounted as tabs", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  const add = view.container.querySelector('button[aria-label="Add right panel tab"]');
  await act(async () => { add.click(); });
  await act(async () => { [...view.container.querySelectorAll('.right-dock-add button')].find((button) => button.textContent.includes("Side chat")).click(); });
  await act(async () => { add.click(); });
  await act(async () => { [...view.container.querySelectorAll('.right-dock-add button')].find((button) => button.textContent.includes("Side chat")).click(); });

  assert.equal(view.container.querySelectorAll('.right-dock [role="tab"]').length, 2);
  assert.equal(view.container.querySelectorAll('.side-chat').length, 2);
  assert.equal(view.container.querySelectorAll('.right-dock-content > div[hidden]').length, 5);
  await view.unmount();
});

test("every right panel view opens as a closable tab", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  const labels = [...view.container.querySelectorAll(".right-dock-picker button:not([disabled])")].map((button) => button.getAttribute("aria-label"));
  assert.ok(labels.length >= 3);

  for (const label of labels) {
    await act(async () => { view.container.querySelector(`.right-dock-picker button[aria-label="${label}"]`).click(); });
    const tab = [...view.container.querySelectorAll(".right-dock-tab")].find((candidate) => candidate.classList.contains("active"));
    assert.ok(tab, `${label} opened no tab`);
    assert.ok(view.container.querySelector(".right-dock-content > div:not([hidden])"), `${label} opened no panel content`);

    const close = tab.querySelector('button[aria-label^="Close "]');
    assert.ok(close, `${label} opened a tab that cannot be closed`);
    await act(async () => { close.click(); });
    assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 0, `${label} left a tab behind`);
    assert.equal(view.container.querySelector(".right-dock-picker").hidden, false);
  }

  await view.unmount();
});

test("right panel resizes with the keyboard", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  const workspace = view.container.querySelector(".workspace");
  const panel = view.container.querySelector(".right-dock");
  workspace.getBoundingClientRect = () => ({ width: 1000, right: 1000 });
  panel.getBoundingClientRect = () => ({ left: 600 });
  await act(async () => { panel.querySelector('[aria-label="Resize right panel"]').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "410px");
  await view.unmount();
});

function seedProjectTasks(tasks) {
  localStorage.clear();
  localStorage.setItem("claudex.store.v2", JSON.stringify({
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

test("a sidebar row renames itself on a double click, and on the menu's Rename", async () => {
  seedProjectTasks([{ id: "only", title: "First task", sortIndex: 0, updatedAt: 1 }]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  const row = () => view.container.querySelector(".project-task-row");
  const type = async (title, key) => {
    const input = view.container.querySelector(".task-rename");
    await act(async () => {
      setValue.call(input, title);
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    });
  };

  await act(async () => { row().dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
  await type("Nightly audit", "Enter");
  assert.equal(view.container.querySelector(".task-rename"), null);
  assert.equal(row().textContent.includes("Nightly audit"), true);

  await act(async () => { row().dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
  assert.deepEqual([...document.querySelectorAll(".context-menu-popover button")].map((button) => button.textContent), ["Rename", "Archive"]);
  await act(async () => { document.querySelector(".context-menu-popover button").click(); });
  await type("Abandoned edit", "Escape");
  assert.equal(view.container.querySelector(".task-rename"), null);
  assert.equal(row().textContent.includes("Nightly audit"), true, "Escape leaves the name the row started with");
  await view.unmount();
});

test("an unread row shows why it wants attention until it is opened", async () => {
  seedProjectTasks([
    { id: "open", title: "Open task", sortIndex: 0, updatedAt: 2 },
    { id: "waiting", title: "Waiting task", sortIndex: 1, updatedAt: 1, attention: "approval" },
  ]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const dot = view.container.querySelector(".task-attention.approval");
  assert.equal(dot?.getAttribute("aria-label"), "Needs approval");

  const waiting = [...view.container.querySelectorAll(".project-task-row")].find((row) => row.textContent.includes("Waiting task"));
  await act(async () => { waiting.click(); });
  assert.equal(view.container.querySelector(".task-attention"), null);
  await view.unmount();
});

test("a run that settles out of sight is flagged, and clears when the window comes back", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Inspect the app"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const start = desktop.sent[0];

  await act(async () => { window.dispatchEvent(new Event("blur")); });
  await act(async () => {
    desktop.listener({ type: "run.status", taskId: start.taskId, runId: start.runId, sequence: 1, status: "succeeded" });
  });
  assert.equal(workspace.get().currentTask.attention, "finished");

  await act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.equal(workspace.get().currentTask.attention, undefined);
  await workspace.view.unmount();
});

test("workspace hook runs a projectless task and scopes events, approvals, and cancellation", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Inspect the app"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const start = desktop.sent[0];
  assert.equal(start.type, "start");
  assert.equal(start.channel, "main");
  assert.equal(start.workspaceId, "projectless");

  await act(async () => {
    desktop.listener({ type: "assistant.delta", taskId: start.taskId, runId: "wrong", sequence: 99, messageId: "wrong", text: "wrong" });
    desktop.listener({ type: "assistant.delta", taskId: start.taskId, runId: start.runId, sequence: 1, messageId: "message-1", text: "hello" });
    desktop.listener({ type: "approval.requested", taskId: start.taskId, runId: start.runId, sequence: 2, approvalId: "approval-1", title: "Approve", description: "Review", intent: { toolId: "tool-1", name: "Read", input: {} } });
    desktop.listener({ type: "run.status", taskId: start.taskId, runId: start.runId, sequence: 3, status: "awaiting-approval" });
  });
  assert.equal(workspace.get().currentTask.messages.length, 2);
  assert.equal(workspace.get().approval.approvalId, "approval-1");
  await act(async () => { workspace.get().actions.decideApproval(true); workspace.get().actions.cancelRun(); });
  assert.deepEqual(desktop.sent.slice(1).map((command) => command.type), ["approval", "cancel"]);

  await workspace.view.unmount();
  assert.equal(desktop.unsubscribed, true);
});

const BRANCH_PROJECT = { id: "project-1", root: "/project", workspaceId: "workspace-1" };

/** A store holding one thread in a project, which is a thread with a checkout to move. */
function seedBranchProject(overrides = {}) {
  const task = {
    id: "task-1", title: "Task", projectId: BRANCH_PROJECT.id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  };
  return fakeDesktop({
    loadTaskStore: async () => ({ version: 2, projects: [BRANCH_PROJECT], tasks: [task], lastFolder: BRANCH_PROJECT.root }),
    ...overrides,
  });
}

test("the branch a thread is switched to is made, checked out, and read back", async () => {
  const calls = [];
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
  assert.equal(workspace.get().environment.branch, "main", "the checkout is read again once it has moved");

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
  let resolveFolder;
  const folder = new Promise((resolve) => { resolveFolder = resolve; });
  const desktop = fakeDesktop({ openFolder: () => folder });
  seedLegacyWorkspace();
  window.desktop = desktop;
  let latest;
  function Harness() { latest = useTaskWorkspace(); return null; }
  const view = await mount(React.createElement(Harness));
  await act(async () => { latest.actions.setPrompt("Continue"); });
  let first;
  let second;
  await act(async () => {
    first = latest.actions.sendPrompt();
    second = latest.actions.sendPrompt();
    resolveFolder({ id: "workspace-1", kind: "project", root: "/project" });
    await Promise.all([first, second]);
  });

  assert.equal(desktop.sent.length, 1);
  assert.equal(desktop.sent[0].workspaceId, "workspace-1");
  assert.deepEqual(desktop.sent[0].continuation, { provider: "claude", value: "session-1" });
  await view.unmount();
});

test("the composer offers model and effort choices, ordered most to least capable", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(TaskComposer, {
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
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
  const modelMenu = view.container.querySelectorAll(".setting-menu")[1];
  assert.deepEqual(
    [...modelMenu.querySelectorAll(".setting-option strong")].map((item) => item.textContent),
    ["Fable", "Opus", "Sonnet", "Haiku"],
  );
  assert.equal(modelMenu.querySelector(".setting-summary-label").textContent, "Opus");
  const effortMenu = view.container.querySelectorAll(".setting-menu")[2];
  assert.deepEqual(
    [...effortMenu.querySelectorAll(".setting-option strong")].map((item) => item.textContent),
    ["Max effort", "Extra high effort", "High effort", "Medium effort", "Low effort"],
  );
  assert.equal(effortMenu.querySelector(".setting-summary-label").textContent, "High effort");
  await view.unmount();
});

test("workspace hook reads a stored subagent's activity only when it is opened", async () => {
  const project = { id: "project-1", root: "/project", workspaceId: "workspace-1" };
  const task = {
    id: "task-1", title: "Task", projectId: project.id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
    subagents: [{ id: "agent-1", description: "Explore", status: "completed", startedAt: 1, finishedAt: 2, activity: [] }],
  };
  const asked = [];
  const desktop = fakeDesktop({
    loadTaskStore: async () => ({ version: 2, projects: [project], tasks: [task], lastFolder: project.root }),
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
  const task = {
    id: "task-1", title: "Task", projectId: project.id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  };
  const desktop = fakeDesktop({ loadTaskStore: async () => ({ version: 2, projects: [project], tasks: [task], lastFolder: project.root }) });
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
  const outcomes = [null, { id: "wrong", kind: "project", root: "/wrong" }, new Error("dialog failed"), { id: "workspace-1", kind: "project", root: "/project" }];
  const desktop = fakeDesktop({ openFolder: async () => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  } });
  seedLegacyWorkspace();
  window.desktop = desktop;
  let latest;
  function Harness() { latest = useTaskWorkspace(); return null; }
  const view = await mount(React.createElement(Harness));
  await act(async () => { latest.actions.setPrompt("Continue"); });

  for (const message of ["Reopen this project folder", "Choose the same project folder", "dialog failed"]) {
    await act(async () => { await latest.actions.sendPrompt(); });
    assert.match(latest.actionError, new RegExp(message));
    assert.equal(desktop.sent.length, 0);
  }
  await act(async () => { await latest.actions.sendPrompt(); });
  assert.equal(desktop.sent.length, 1);
  await view.unmount();
});

test("workspace hook ignores a changed-files response from a replaced run", async () => {
  let phase = "initial";
  let resolveOld;
  const oldResult = new Promise((resolve) => { resolveOld = resolve; });
  const never = new Promise(() => {});
  const desktop = fakeDesktop({
    openFolder: async () => ({ id: "workspace-1", kind: "project", root: "/project" }),
    changedFiles: async () => {
      if (phase === "initial") return { status: "available", files: ["initial"], branch: "main", additions: 0, deletions: 0 };
      if (phase === "old") { phase = "new"; return oldResult; }
      return never;
    },
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { await workspace.get().actions.openFolder(); });
  await act(async () => { workspace.get().actions.setPrompt("First"); await workspace.get().actions.sendPrompt(); });
  const first = desktop.sent.at(-1);
  phase = "old";
  await act(async () => { desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 1, status: "succeeded" }); });
  await act(async () => { workspace.get().actions.setPrompt("Second"); await workspace.get().actions.sendPrompt(); });
  resolveOld({ status: "available", files: ["stale"], branch: "old", additions: 99, deletions: 99 });
  await act(async () => {});

  assert.notDeepEqual(workspace.get().currentTask.lastChangeSnapshot.files, ["stale"]);
  await workspace.view.unmount();
});

test("a folder the claudex command names opens as a project without the dialog", async () => {
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
  const first = desktop.sent[0];
  await act(async () => {
    desktop.listener({ type: "subagent.started", taskId: first.taskId, runId: first.runId, sequence: 1, id: "agent-1", description: "Inspect", agentType: "Explore" });
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 2, status: "succeeded" });
  });
  await act(async () => { workspace.get().actions.setPrompt("Second"); await workspace.get().actions.sendPrompt(); });

  assert.equal(workspace.get().subagents[0].description, "Inspect");
  await act(async () => {});
  const stored = desktop.persisted.flatMap((delta) => delta.tasks).findLast((change) => change.subagents?.length);
  assert.equal(stored.subagents[0].subagent.description, "Inspect");
  assert.equal(stored.task.subagents, undefined);
  await workspace.view.unmount();
});

test("workspace hook runs tasks concurrently with per-task composer state", async () => {
  const desktop = fakeDesktop({ openFolder: async () => ({ id: "workspace-1", kind: "project", root: "/project" }) });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { await workspace.get().actions.openFolder(); });
  const projectId = workspace.get().currentProject.id;
  await act(async () => { workspace.get().actions.setPrompt("First"); await workspace.get().actions.sendPrompt(); });
  const first = desktop.sent[0];

  await act(async () => { workspace.get().actions.newTask(projectId); });
  assert.equal(workspace.get().runActive, false);
  assert.equal(workspace.get().prompt, "");
  await act(async () => { workspace.get().actions.setPrompt("Second"); await workspace.get().actions.sendPrompt(); });
  const second = desktop.sent[1];

  assert.notEqual(second.taskId, first.taskId);
  assert.equal(workspace.get().runActive, true);
  assert.deepEqual([...workspace.get().runningTaskIds].sort(), [first.taskId, second.taskId].sort());
  assert.deepEqual(workspace.get().orderedTasks.map((task) => task.id), [second.taskId, first.taskId]);

  await act(async () => {
    desktop.listener({ type: "assistant.delta", taskId: first.taskId, runId: first.runId, sequence: 1, messageId: "message-1", text: "one" });
    desktop.listener({ type: "assistant.delta", taskId: second.taskId, runId: second.runId, sequence: 1, messageId: "message-2", text: "two" });
  });
  assert.equal(workspace.get().currentTask.messages.at(-1).text, "two");
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

function transcript(...messages) {
  return messages.map((message, index) => ({ id: `m${index}`, at: index * 1000, ...message }));
}

async function expand(details) {
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

function timelineView(messages, status, streamingTail, runEndedAt, find) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  document.body.append(scroller);
  const task = {
    id: "t1", title: "T", executionPolicy: "confirm", messages,
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
    ...(runEndedAt === undefined ? {} : { runEndedAt }),
  };
  return React.createElement(ConversationTimeline, {
    currentTask: task, folder: "/p", status, compacting: false, streamingTail, scrollContainerRef: { current: scroller }, find,
  });
}

test("find opens the fold the match it is showing was written into", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Bash", detail: "retry the build" },
    { kind: "assistant", text: "Done." },
  );
  const find = {
    target: { kind: "transcript" },
    query: "retry",
    index: 0,
    focus: 1,
    matches: 1,
    hit: { messageId: "m1", field: "detail", start: 0, occurrence: 0 },
  };
  const view = await mount(timelineView(messages, "idle", undefined, undefined, find));

  assert.equal(view.container.querySelector(".work-steps pre").textContent, "retry the build");

  await view.render(timelineView(messages, "idle", undefined, undefined, { ...find, hit: null, matches: 0, query: "" }));
  assert.equal(view.container.querySelector(".work-steps"), null, "the fold closes again once the match is no longer being read");
  await view.unmount();
});

test("a running turn collapses its tool calls behind the newest one", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "I'll investigate." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "tool", text: "Read", detail: "three" },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = view.container.querySelector(".work-group");
  assert.equal(run.querySelector(".work-label").textContent, "Read");
  assert.equal(run.querySelector(".work-count").textContent, "+2");
  assert.equal(view.container.querySelector(".work-note").textContent, "I'll investigate.");
  assert.equal(view.container.querySelectorAll(".work-steps").length, 0);

  await expand(run);
  assert.deepEqual([...view.container.querySelectorAll(".work-steps .work-row .work-label")].map((step) => step.textContent), ["Bash", "Grep", "Read"]);
  await view.unmount();
});

test("a settled turn folds its steps behind the final answer", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "I'll investigate." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "assistant", text: "Fixed the race." },
  );
  const view = await mount(timelineView(messages, "idle"));

  const settled = view.container.querySelector(".work-group");
  assert.equal(settled.querySelector(".work-summary").textContent, "3 steps");
  assert.equal(view.container.querySelector(".message.turn > .message-text").textContent, "Fixed the race.");
  assert.equal(view.container.querySelector(".work-note"), null);

  await expand(settled);
  assert.equal(view.container.querySelector(".work-note").textContent, "I'll investigate.");
  const run = view.container.querySelectorAll(".work-group")[1];
  assert.equal(run.querySelector(".work-label").textContent, "Grep");
  assert.equal(run.querySelector(".work-count").textContent, "+1");

  await view.unmount();
});

test("timeline groups keep user turns apart and leave a lone answer uncollapsed", () => {
  const messages = transcript(
    { kind: "user", text: "One" },
    { kind: "assistant", text: "Sure." },
    { kind: "user", text: "Two" },
    { kind: "assistant", text: "Checking." },
    { kind: "tool", text: "Bash" },
  );

  const settled = groupTimeline(messages, { running: false });
  assert.deepEqual(settled.map((group) => group.kind), ["message", "turn", "message", "turn"]);
  assert.deepEqual(settled[1], { kind: "turn", id: "m1", steps: [], final: messages[1], endsAt: messages[1].at, live: false });
  assert.equal(settled[3].final, null);
  assert.equal(settled[3].steps.length, 2);

  const running = groupTimeline(messages, { running: true });
  assert.equal(running[1].live, false);
  assert.equal(running[3].live, true);
});

test("a settled turn times each step it folds away", async () => {
  const settledMessages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "assistant", text: "Looking." },
    { kind: "tool", text: "Bash", detail: "one" },
    { kind: "tool", text: "Grep", detail: "two" },
    { kind: "assistant", text: "Done." },
  );
  const settledView = await mount(timelineView(settledMessages, "idle"));

  const settled = settledView.container.querySelector(".work-group");
  assert.equal(settled.querySelector(".work-time").textContent, "3s");
  await expand(settled);
  const run = settledView.container.querySelectorAll(".work-group")[1];
  assert.equal(run.querySelector(".work-time").textContent, "2s");
  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-time")].map((time) => time.textContent), ["1s", "1s"]);
  await settledView.unmount();
});

test("a running turn counts up until its work ends", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100_000 });
  const running = [
    { id: "l0", at: 40_000, kind: "tool", text: "Bash", detail: "one" },
    { id: "l1", at: 95_000, kind: "tool", text: "Grep", detail: "two" },
  ];
  const view = await mount(timelineView(running, "running"));
  const elapsed = () => view.container.querySelector(".work-group .work-time").textContent;

  assert.equal(elapsed(), "1m 0s");
  await act(async () => { t.mock.timers.tick(4_000); });
  assert.equal(elapsed(), "1m 4s");

  await view.render(timelineView([...running, { id: "l2", at: 106_000, kind: "assistant", text: "Done." }], "idle"));
  assert.equal(elapsed(), "1m 6s");
  await act(async () => { t.mock.timers.tick(30_000); });
  assert.equal(elapsed(), "1m 6s");

  await view.unmount();
  t.mock.timers.reset();
});

test("a stopped turn freezes at the moment its run ended", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100_000 });
  const running = [
    { id: "l0", at: 40_000, kind: "tool", text: "Bash", detail: "one" },
    { id: "l1", at: 95_000, kind: "tool", text: "Grep", detail: "two" },
  ];
  const view = await mount(timelineView(running, "running"));
  const elapsed = () => view.container.querySelector(".work-group .work-time").textContent;

  assert.equal(elapsed(), "1m 0s");
  await view.render(timelineView(running, "stopped", null, 102_000));
  assert.equal(elapsed(), "1m 2s");
  await act(async () => { t.mock.timers.tick(30_000); });
  assert.equal(elapsed(), "1m 2s", "stopping ends the turn even though no answer closed it");

  await view.render(timelineView(running, "stopped", null));
  await act(async () => { t.mock.timers.tick(30_000); });
  assert.equal(elapsed(), "55s", "work stored before stops were timed rests on its last step");

  await view.unmount();
  t.mock.timers.reset();
});

test("elapsed labels stay readable from seconds to hours", async () => {
  const { formatElapsed } = await vite.ssrLoadModule("/src/renderer/components/ConversationTimeline.tsx");

  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(940), "1s");
  assert.equal(formatElapsed(59_400), "59s");
  assert.equal(formatElapsed(60_000), "1m 0s");
  assert.equal(formatElapsed(3_599_000), "59m 59s");
  assert.equal(formatElapsed(3_600_000), "1h 0m");
  assert.equal(formatElapsed(7_500_000), "2h 5m");
});

const automationView = (overrides = {}) => ({
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
  const view = await mount(React.createElement(AutomationPanel, { automation: null, onUpdate() {}, onDelete() {}, onRunNow() {} }));

  assert.match(view.container.textContent, /Ask Claude to repeat this task/);
  assert.match(view.container.textContent, /No automation yet/);
  assert.equal(view.container.querySelector('input[aria-label="Automation schedule"]'), null);
  await view.unmount();
});

test("the automation panel edits the schedule and prompt in one save", async () => {
  const patches = [];
  const automation = automationView();
  const view = await mount(React.createElement(AutomationPanel, { automation, onUpdate: (patch) => patches.push(patch), onDelete() {}, onRunNow() {} }));

  const schedule = view.container.querySelector('input[aria-label="Automation schedule"]');
  const prompt = view.container.querySelector('textarea[aria-label="Automation prompt"]');
  const save = view.container.querySelector(".automation-actions button");
  const setInput = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  const setTextarea = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  assert.equal(schedule.value, "*/5 * * * *");
  assert.equal(prompt.value, "Check whether the PR is approved");
  assert.equal(save.disabled, true, "an untouched automation has nothing to save");
  assert.match(view.container.textContent, /2 runs/);
  assert.match(view.container.textContent, /succeeded at/);

  await act(async () => {
    setInput.call(schedule, "0 8 * * *");
    schedule.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "0 8 * * *" }));
    schedule.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    setTextarea.call(prompt, "Check the PR and stop once it is approved");
    prompt.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Check the PR and stop once it is approved" }));
    prompt.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { view.container.querySelector(".automation-actions button").click(); });

  assert.deepEqual(patches, [{ schedule: "0 8 * * *", prompt: "Check the PR and stop once it is approved" }]);
  await view.unmount();
});

test("the automation panel pauses, reruns, and removes without editing", async () => {
  const patches = [];
  let deleted = 0;
  let ranNow = 0;
  const view = await mount(React.createElement(AutomationPanel, {
    automation: automationView(),
    onUpdate: (patch) => patches.push(patch),
    onDelete: () => { deleted += 1; },
    onRunNow: () => { ranNow += 1; },
  }));

  await act(async () => { view.container.querySelector('button[aria-label="Pause automation"]').click(); });
  await act(async () => { view.container.querySelector('button[aria-label="Run automation now"]').click(); });
  await act(async () => { view.container.querySelector('button[aria-label="Remove automation"]').click(); });

  assert.deepEqual(patches, [{ paused: true }]);
  assert.equal(ranNow, 1);
  assert.equal(deleted, 1);

  await view.render(React.createElement(AutomationPanel, { automation: automationView({ paused: true, nextRunAt: null }), onUpdate: (patch) => patches.push(patch), onDelete() {}, onRunNow() {} }));
  assert.match(view.container.textContent, /Paused/);
  await act(async () => { view.container.querySelector('button[aria-label="Resume automation"]').click(); });
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
  const first = desktop.sent[0];
  await act(async () => {
    desktop.listener({ type: "continuation.updated", taskId: first.taskId, runId: first.runId, sequence: 1, continuation: { provider: "claude", value: "session-1" } });
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 2, status: "succeeded" });
  });

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: first.taskId, runId: "run-scheduled", prompt: "Check PR 42", runNumber: 3, policy: "autonomous" });
  });

  const scheduled = desktop.sent[1];
  assert.equal(scheduled.taskId, first.taskId, "the tick continues the original thread");
  assert.equal(scheduled.runId, "run-scheduled", "the scheduler's run ID is what comes back to it");
  assert.equal(scheduled.policy, "autonomous", "the automation's policy wins over the task's");
  assert.deepEqual(scheduled.continuation, { provider: "claude", value: "session-1" });
  assert.match(scheduled.prompt, /^Check PR 42/);
  assert.match(scheduled.prompt, /automated run #3/);
  assert.match(scheduled.prompt, /stop tool/);
  assert.deepEqual(desktop.acknowledged, [{ automationId: "automation-1", runId: "run-scheduled", started: true }]);

  const messages = workspace.get().currentTask.messages;
  assert.equal(messages.at(-1).text, "Check PR 42", "the transcript shows the prompt, not the scheduler's framing");
  assert.equal(messages.at(-1).detail, "Automation run #3");
  await workspace.view.unmount();
});

test("a tick that lands on a busy or archived task is declined instead of queued", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Watch PR 42"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const first = desktop.sent[0];

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: first.taskId, runId: "run-overlap", prompt: "Check PR 42", runNumber: 2 });
  });
  assert.equal(desktop.sent.length, 1, "the running task never gets a second run");
  assert.deepEqual(desktop.acknowledged, [{ automationId: "automation-1", runId: "run-overlap", started: false }]);

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: "task-gone", runId: "run-missing", prompt: "Check PR 42", runNumber: 2 });
  });
  assert.equal(desktop.acknowledged.at(-1).started, false, "a tick for a task that no longer exists is declined");
  await workspace.view.unmount();
});

test("removing a project retires the automations of every task it takes with it", async () => {
  const project = { id: "project-1", root: "/project", workspaceId: "workspace-1" };
  const task = (id) => ({
    id, title: id, projectId: project.id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  });
  const desktop = fakeDesktop({
    loadTaskStore: async () => ({ version: 2, projects: [project], tasks: [task("task-1"), task("task-2"), task("task-3")], lastFolder: project.root }),
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
  const first = desktop.sent[0];
  await act(async () => {
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 1, status: "succeeded" });
  });
  await act(async () => { desktop.automationsChanged([automationView({ taskId: first.taskId })]); });
  assert.equal(workspace.get().automation.taskId, first.taskId);

  await act(async () => { workspace.get().actions.archiveTask(first.taskId); });

  assert.deepEqual(desktop.automationChanges, [{ taskId: first.taskId, deleted: true }]);
  await workspace.view.unmount();
});

test("the sidebar marks the threads that run on a schedule and the ones with their own checkout", async () => {
  const task = (id, projectId) => ({
    id, title: id, ...(projectId ? { projectId } : {}), executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const view = await mount(React.createElement(ProjectSidebar, {
    compactOpen: false,
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedTasks: [task("scheduled-task", "project-1"), task("plain-task", "project-1")],
    recentTasks: [task("scheduled-chat"), task("plain-chat")],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningTaskIds: new Set(),
    automatedTaskIds: new Set(["scheduled-task", "scheduled-chat"]),
    worktreeTaskIds: new Set(["plain-task"]),
    projectsOpen: true,
    recentsOpen: true,
    openMenu: null,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetProjectsOpen() {}, onSetRecentsOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onMoveTask() {}, onOpenSettings() {},
  }));

  const marks = (label) => [...view.container.querySelectorAll(`[aria-label="${label}"]`)]
    .map((icon) => icon.closest("[data-rfd-draggable-id]").getAttribute("data-rfd-draggable-id"))
    .sort();

  assert.deepEqual(marks("Runs on a schedule"), ["scheduled-chat", "scheduled-task"]);
  assert.deepEqual(marks("Works in a worktree"), ["plain-task"], "a thread with its own checkout is marked wherever it is listed");
  await view.unmount();
});

test("a folder's menu opens on its trigger and every choice closes it", async () => {
  const opened = [];
  const removed = [];
  const sidebar = (openMenu) => React.createElement(ProjectSidebar, {
    compactOpen: false,
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningTaskIds: new Set(),
    automatedTaskIds: new Set(),
    worktreeTaskIds: new Set(),
    projectsOpen: true,
    recentsOpen: true,
    openMenu,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {},
    onRemoveProject: (id) => { removed.push(id); },
    onSetProjectsOpen() {}, onSetRecentsOpen() {},
    onSetOpenMenu: (menu) => { opened.push(menu); },
    onSelectTask() {}, onArchiveTask() {}, onMoveTask() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar(null));
  const trigger = () => view.container.querySelector('[aria-label="More options for project"]');
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  assert.equal(view.container.querySelector(".project-menu .menu-popover"), null, "a shut menu renders no list");

  await act(async () => { trigger().click(); });
  assert.deepEqual(opened, ["project:project-1"], "the trigger names the menu it opens");

  await view.render(sidebar("project:project-1"));
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  const items = [...view.container.querySelectorAll(".project-menu .menu-popover button")];
  assert.deepEqual(items.map((item) => item.textContent), ["New task", "Collapse", "Remove"]);

  await act(async () => { items[2].click(); });
  assert.deepEqual(removed, ["project-1"]);
  assert.equal(opened.at(-1), null, "choosing an item closes the menu without the item saying so");
  await view.unmount();
});

test("a collapsed folder takes a drop as a strip the drag can measure, still folded", async () => {
  const task = (id, projectId) => ({
    id, title: id, ...(projectId ? { projectId } : {}), executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const projects = [{ id: "open-project", root: "/open" }, { id: "shut-project", root: "/shut" }];
  const tasks = [task("open-task", "open-project"), task("shut-task", "shut-project")];
  const measured = [];
  const view = await mount(React.createElement(ProjectSidebar, {
    compactOpen: false,
    inactive: false,
    projects,
    orderedTasks: tasks,
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["open-project"]),
    runningTaskIds: new Set(),
    automatedTaskIds: new Set(),
    worktreeTaskIds: new Set(),
    projectsOpen: true,
    recentsOpen: true,
    openMenu: null,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetProjectsOpen() {}, onSetRecentsOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onMoveTask() {}, onOpenSettings() {},
  }));

  const shutList = () => view.container.querySelector('[data-rfd-droppable-id="shut-project"]');
  assert.ok(shutList().className.includes("collapsed"), "the folder starts collapsed");

  // The library measures every droppable while lifting; record what it could see.
  const original = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.getAttribute?.("data-rfd-droppable-id") === "shut-project") {
      measured.push(this.className.includes("collapsed") ? "hidden" : "visible");
    }
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
  };
  try {
    const handle = view.container.querySelector('[data-rfd-drag-handle-draggable-id="open-task"]');
    assert.ok(handle, "the open folder's task is draggable");
    await act(async () => {
      handle.focus();
      handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", keyCode: 32, bubbles: true, cancelable: true }));
    });

    assert.equal(shutList().className.includes("collapsed"), false, "the folded folder becomes a drop strip");
    assert.ok(measured.length > 0, "the library measured the collapsed folder");
    assert.equal(measured.includes("hidden"), false, `measured while still collapsed: ${measured.join(",")}`);
    assert.equal(shutList().querySelectorAll("[data-rfd-draggable-id]").length, 0, "the folder takes the drop without showing what it holds");
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = original;
  }
  await view.unmount();
});

/** Each mount gets its own reveal store, the way a timeline does, so tests never share progress. */
function streaming(props) {
  return React.createElement(RevealedTextProvider, null, React.createElement(StreamingText, { id: "m1", streaming: true, ...props }));
}

/** Waits out the reveal loop, which paces itself against the real clock rather than frame count. */
async function settle(view, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  while (Date.now() < deadline) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    const current = view.container.textContent;
    if (current === previous) return view;
    previous = current;
  }
  throw new Error("streamed text never settled");
}

test("streamed text arrives progressively instead of landing whole", async () => {
  const tail = "Checking the reducer before anything else.";
  const view = await mount(streaming({ committed: "", tail }));

  const steps = [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && steps.at(-1) !== tail) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2)); });
    const current = view.container.textContent;
    if (steps.at(-1) !== current) steps.push(current);
  }

  assert.equal(steps.at(-1), tail);
  assert.ok(steps.length >= 3, `expected a progressive reveal, saw ${JSON.stringify(steps)}`);
  assert.ok(steps.every((step) => tail.startsWith(step)), "the reveal only ever grows from the front");
  await view.unmount();
});

test("a revealed word keeps its node, so only new words animate in", async () => {
  const view = await mount(streaming({ committed: "", tail: "One two" }));
  await settle(view);
  const before = [...view.container.querySelectorAll(".stream-word")].map((node) => node.textContent);
  const firstNode = view.container.querySelector(".stream-word");

  await view.render(streaming({ committed: "", tail: "One two three" }));
  await settle(view);
  const after = [...view.container.querySelectorAll(".stream-word")].map((node) => node.textContent);

  assert.deepEqual(before, ["One ", "two"]);
  assert.deepEqual(after, ["One ", "two ", "three"]);
  assert.equal(view.container.querySelector(".stream-word"), firstNode, "an already-revealed word is not re-created");
  await view.unmount();
});

test("half-written markup is held back rather than shown as literal markers", async () => {
  const view = await mount(streaming({ committed: "## Heading\n\n", tail: "Then a **partly" }));
  await settle(view);

  assert.equal(view.container.querySelector("h2").textContent, "Heading");
  assert.equal(view.container.textContent, "HeadingThen a", "the unclosed emphasis run waits instead of showing its markers");
  assert.equal(view.container.querySelector("strong"), null);

  await view.render(streaming({ committed: "## Heading\n\nThen a **partly** written line.\n\n", tail: "" }));
  await settle(view);
  assert.equal(view.container.querySelector("strong").textContent, "partly");
  await view.unmount();
});

test("a streamed code fence renders as a code block instead of literal backticks", async () => {
  const view = await mount(streaming({ committed: "", tail: "```ts\nconst reducer = 1;\n" }));
  await settle(view);

  assert.equal(view.container.querySelector("pre code").textContent.trim(), "const reducer = 1;");
  assert.doesNotMatch(view.container.textContent, /```/, "the opening fence is never shown as text");
  await view.unmount();
});

test("a table waits for its delimiter row instead of showing pipes", async () => {
  const view = await mount(streaming({ committed: "", tail: "| Channel | Reach |\n" }));
  await settle(view);
  assert.equal(view.container.textContent, "", "a header row alone would render as literal pipes");

  await view.render(streaming({ committed: "", tail: "| Channel | Reach |\n| --- | --- |\n| side | tools |\n" }));
  /** The reveal is still typing through rows that render as nothing, so settling on text cannot see it. */
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !view.container.querySelector("table")) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  assert.equal(view.container.querySelector("table th").textContent, "Channel");
  assert.doesNotMatch(view.container.textContent, /\|/);
  await view.unmount();
});

test("text committing into a block does not rewind or repeat the reveal", async () => {
  const view = await mount(streaming({ committed: "", tail: "A whole paragraph of text." }));
  await settle(view);
  assert.equal(view.container.textContent, "A whole paragraph of text.");

  await view.render(streaming({ committed: "A whole paragraph of text.\n\n", tail: "" }));
  assert.equal(view.container.textContent.trim(), "A whole paragraph of text.", "the same text stays put as it becomes a block");
  await view.unmount();
});

test("a tail with no committed message yet still gets a live turn to render into", () => {
  const messages = transcript({ kind: "user", text: "Explain this" });

  assert.deepEqual(groupTimeline(messages, { running: true }).map((group) => group.kind), ["message"]);

  const streaming = groupTimeline(messages, { running: true, tailMessageId: "message-1" });
  assert.deepEqual(streaming.map((group) => group.kind), ["message", "turn"]);
  assert.deepEqual(streaming[1], { kind: "turn", id: "message-1", steps: [], final: null, endsAt: null, live: true });

  const answered = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "Because" });
  assert.deepEqual(groupTimeline(answered, { running: true, tailMessageId: "m1" }).map((group) => group.kind), ["message", "turn"], "the turn that owns the tail is not duplicated");
});

test("a live turn types its newest text and leaves settled turns alone", async () => {
  const messages = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "First block.\n\n" });
  const view = await mount(timelineView(messages, "running", { messageId: "m1", text: "Second block still" }));
  await settle(view);

  assert.equal(view.container.querySelector(".work-note p").textContent, "First block.");
  assert.match(view.container.textContent, /Second block still/);
  await view.unmount();
});

test("a block committing between tails does not replay the text already read", async () => {
  const streamed = transcript({ kind: "user", text: "Explain this" });
  const view = await mount(timelineView(streamed, "running", { messageId: "reply-1", text: "The reducer owns every write." }));
  await settle(view);
  assert.match(view.container.textContent, /The reducer owns every write\./);

  /** The delta clears the tail before the next one arrives, which is where a remount would rewind. */
  const committed = [...streamed, { id: "reply-1", at: 2000, kind: "assistant", text: "The reducer owns every write.\n\n" }];
  await view.render(timelineView(committed, "running", null));
  assert.match(view.container.textContent, /The reducer owns every write\./);

  await view.render(timelineView(committed, "running", { messageId: "reply-1", text: "Then the" }));
  assert.match(view.container.textContent, /The reducer owns every write\./, "the committed block stays put while the next tail types on");
  await view.unmount();
});

/** How long the reveal takes to work through a block that lands in one go. */
async function revealDuration(tail) {
  const view = await mount(streaming({ committed: "", tail }));
  const startedAt = Date.now();
  const deadline = startedAt + 10_000;
  while (Date.now() < deadline && view.container.textContent !== tail) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2)); });
  }
  assert.equal(view.container.textContent, tail, "the reveal never finished");
  const elapsed = Date.now() - startedAt;
  await view.unmount();
  return elapsed;
}

test("a big block takes proportionally longer to read out than a small one", async () => {
  const small = await revealDuration("word ".repeat(22).trim());
  const large = await revealDuration("word ".repeat(110).trim());

  /**
   * A rate derived from the backlog alone reveals any size in about the same time, so a paragraph
   * flashes past while a sentence does not. Typing speed has to set the pace instead.
   */
  assert.ok(large >= small * 3, `5x the text took ${large}ms against ${small}ms, so a big block still flashes past`);
  assert.ok(large <= 9000, `a paragraph took ${large}ms to read out, which is a crawl`);
});

test("a turn that settles keeps reading out rather than snapping to the end", async () => {
  const body = "word ".repeat(80).trim();
  const messages = transcript({ kind: "user", text: "Explain this" });
  /** One scroll container across the handover, so the virtualizer is not what changes. */
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  document.body.append(scroller);
  const scrollContainerRef = { current: scroller };
  const timeline = (list, status, streamingTail) => React.createElement(ConversationTimeline, {
    currentTask: { id: "t1", title: "T", executionPolicy: "confirm", messages: list, continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 },
    folder: "/p", status, compacting: false, streamingTail, scrollContainerRef,
  });
  const view = await mount(timeline(messages, "running", { messageId: "reply-1", text: body }));
  const reading = () => [...view.container.querySelectorAll(".stream-word")].reduce((total, node) => total + node.textContent.length, 0);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  const midway = reading();
  assert.ok(midway > 0 && midway < body.length, `the reveal should be under way and short of ${body.length}, was ${midway}`);

  /** The run ends and the text changes hands to the settled renderer, which is where it used to jump. */
  const settled = [...messages, { id: "reply-1", at: 2000, kind: "assistant", text: `${body}\n\n` }];
  await view.render(timeline(settled, "idle", null));
  assert.ok(reading() >= midway, "settling rewound the reveal");
  assert.ok(reading() < body.length, `settling jumped straight to ${reading()} characters`);

  await settle(view, 8000);
  assert.match(view.container.textContent, /word word/, "the settled turn never finished reading out");
  assert.equal(view.container.querySelector(".stream-word"), null, "finished text is parsed rather than left mid-reveal");
  await view.unmount();
});

test("a tail renders before the task has a message of its own to attach to", async () => {
  const view = await mount(timelineView([], "running", { messageId: "reply-1", text: "Starting on it" }));
  await settle(view);

  assert.equal(view.container.querySelector(".empty-state"), null, "a live tail is not an empty task");
  assert.match(view.container.textContent, /Starting on it/);
  await view.unmount();
});

/** A scroll container with the metrics jsdom cannot work out for itself, recording where it is sent. */
function scrollHarness({ scrollHeight = 4000, clientHeight = 600 } = {}) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: scrollHeight });
  document.body.append(scroller);
  const sentTo = [];
  scroller.scrollTo = (options) => sentTo.push(options.top);
  const scrollContainerRef = { current: scroller };
  const render = (messages, status, streamingTail) => React.createElement(ConversationTimeline, {
    currentTask: { id: "t1", title: "T", executionPolicy: "confirm", messages, continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1 },
    folder: "/p", status, compacting: false, streamingTail, scrollContainerRef,
  });
  /** Entries are empty because the transcript's observer only cares that something resized. */
  const resize = async () => act(async () => {
    for (const observer of [...ResizeObserverStub.live]) observer.callback([], observer);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  return { scroller, sentTo, render, resize, bottom: scrollHeight };
}

test("an answer is read from its top while tool calls still follow the newest line", async () => {
  const harness = scrollHarness();
  const working = transcript({ kind: "user", text: "Explain this" }, { kind: "tool", text: "Bash", detail: "one" });
  const view = await mount(harness.render(working, "running", null));
  await harness.resize();
  assert.equal(harness.sentTo.at(-1), harness.bottom, "a tool call follows the newest line");

  harness.sentTo.length = 0;
  await view.render(harness.render(working, "running", { messageId: "reply-1", text: "Here is what I found." }));
  await harness.resize();
  assert.ok(harness.sentTo.length > 0, "the view moved when the answer started");
  assert.ok(!harness.sentTo.includes(harness.bottom), `the answer snapped to the bottom instead of its top: ${harness.sentTo}`);

  /** More work after an answer is worth following again. */
  harness.sentTo.length = 0;
  const resumed = [...working, { id: "reply-1", at: 3000, kind: "assistant", text: "Here is what I found.\n\n" }, { id: "k2", at: 4000, kind: "tool", text: "Read", detail: "two" }];
  await view.render(harness.render(resumed, "running", null));
  await harness.resize();
  assert.equal(harness.sentTo.at(-1), harness.bottom, "a tool call after an answer follows again");
  await view.unmount();
});

test("a reader who scrolls away keeps the view, and is offered a way back to the end", async () => {
  const harness = scrollHarness();
  const messages = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "An answer.\n\n" });
  const view = await mount(harness.render(messages, "idle", null));
  assert.equal(view.container.querySelector(".scroll-to-end"), null, "hidden while the end is in view");

  /** scrollTop stays at the top, so this scroll event reports a transcript scrolled well away. */
  await act(async () => { harness.scroller.dispatchEvent(new Event("scroll")); });
  const button = view.container.querySelector(".scroll-to-end");
  assert.ok(button, "offered once the end is out of view");

  await act(async () => { harness.scroller.dispatchEvent(new Event("wheel")); });
  harness.sentTo.length = 0;
  await harness.resize();
  assert.deepEqual(harness.sentTo, [], "a transcript the reader scrolled is left where they put it");

  await act(async () => { button.click(); });
  assert.equal(harness.sentTo.at(-1), harness.bottom, "the button returns to the end");
  await view.unmount();
});

test("the window answers thread requests from the reducer's own state", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const started = workspace.get().currentTask;
  assert.ok(started, "a thread exists to ask about");

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: started.id, op: "list" }); });
  const listed = desktop.threadAnswers.at(-1);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result.map((thread) => thread.id), [started.id]);

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: started.id, op: "read", threadId: started.id }); });
  assert.deepEqual(desktop.threadAnswers.at(-1).result.messages.map((message) => message.text), ["Fix the header"]);

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "r3", taskId: started.id, op: "read", threadId: "ghost" }); });
  assert.equal(desktop.threadAnswers.at(-1).ok, false);
  assert.match(desktop.threadAnswers.at(-1).message, /No thread has the ID ghost/);

  await workspace.view.unmount();
});

test("a thread command reaches the reducer and reports the thread it acted on", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const caller = workspace.get().currentTask;

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: caller.id, op: "command", command: { type: "task.send", text: "Implement item 2" } });
  });
  const answer = desktop.threadAnswers.at(-1);
  assert.equal(answer.ok, true);
  assert.notEqual(answer.result.thread.id, caller.id, "the send started its own thread");
  assert.equal(workspace.get().currentTask.id, caller.id, "the user stays where they were");
  assert.equal(desktop.sent.filter((command) => command.type === "start").length, 2);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: caller.id, op: "command", command: { type: "task.archive", taskId: answer.result.thread.id } });
  });
  assert.equal(desktop.threadAnswers.at(-1).result.thread.archived, true);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "r3", taskId: caller.id, op: "command", command: { type: "task.archive", taskId: "ghost" } });
  });
  assert.equal(desktop.threadAnswers.at(-1).ok, false);

  await workspace.view.unmount();
});

test("a wait is held open until the thread it names stops working", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const running = workspace.get().currentTask;
  const runId = desktop.sent.at(-1).runId;

  await act(async () => { desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: running.id, op: "wait", threadId: running.id, timeoutMs: 60_000 }); });
  assert.equal(desktop.threadAnswers.length, 0, "the wait is still open while the run goes");

  await act(async () => {
    desktop.listener({ type: "assistant.delta", taskId: running.id, runId, sequence: 1, text: "Header fixed." });
    desktop.listener({ type: "run.status", taskId: running.id, runId, sequence: 2, status: "succeeded" });
  });
  await act(async () => {});

  const waited = desktop.threadAnswers.at(-1);
  assert.equal(waited.ok, true);
  assert.equal(waited.result.timedOut, false);
  assert.equal(waited.result.reply, "Header fixed.");
  assert.equal(waited.result.thread.status, "idle");

  await workspace.view.unmount();
});

test("a wait on a thread that is already idle answers at once, and an unknown thread fails", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);

  await act(async () => { workspace.get().actions.setPrompt("Fix the header"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const started = workspace.get().currentTask;
  const runId = desktop.sent.at(-1).runId;
  await act(async () => { desktop.listener({ type: "run.status", taskId: started.id, runId, sequence: 1, status: "succeeded" }); });

  await act(async () => { desktop.askThreads({ type: "thread.request", requestId: "r1", taskId: started.id, op: "wait", threadId: started.id, timeoutMs: 60_000 }); });
  assert.equal(desktop.threadAnswers.at(-1).ok, true);
  assert.equal(desktop.threadAnswers.at(-1).result.timedOut, false);

  await act(async () => { desktop.askThreads({ type: "thread.request", requestId: "r2", taskId: started.id, op: "wait", threadId: "ghost", timeoutMs: 60_000 }); });
  assert.equal(desktop.threadAnswers.at(-1).ok, false);

  await workspace.view.unmount();
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
  const showMore = () => view.container.querySelector(".show-more");
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
  await act(async () => { view.container.querySelector(".show-more").click(); });
  const eleventh = [...view.container.querySelectorAll(".project-task-row")].find((row) => row.textContent.startsWith("Task 11"));
  await act(async () => { eleventh.click(); });
  await act(async () => { view.container.querySelector(".show-more").click(); });

  assert.equal(titles().length, 12);
  assert.equal(titles().at(-1), "Task 11");
  assert.equal(view.container.querySelector(".show-more").textContent, "Show 1 more");
  await view.unmount();
});

test("the session panel's thread menu offers the hand-off its location allows, and nothing else", async () => {
  const calls = { worktree: [], menu: [] };
  const panel = (location, openMenu, runActive = false) => React.createElement(SessionPanel, {
    environment: { status: "available", files: [], branch: "main", additions: 0, deletions: 0 },
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
  const items = (view) => [...view.container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);

  const view = await mount(panel({ kind: "local" }, null));
  assert.equal(view.container.querySelector('[role="menu"]'), null, "the menu stays shut until asked for");
  await act(async () => { view.container.querySelector('button[aria-label="Thread options"]').click(); });
  assert.deepEqual(calls.menu, ["session:location"]);

  await view.render(panel({ kind: "local" }, "session:location"));
  assert.deepEqual(items(view), ["Hand off to worktree"], "where a thread works is the only thing this menu decides");
  await act(async () => { view.container.querySelectorAll('[role="menuitem"]')[0].click(); });
  assert.deepEqual(calls.worktree, [true]);

  const worktree = { kind: "worktree", worktree: { id: "wt1", root: "/worktrees/repo-wt1", workspaceId: "w", baseCommit: "abc1234", createdAt: 1, lastUsedAt: 1 } };
  await view.render(panel(worktree, "session:location"));
  assert.deepEqual(items(view), ["Return to local"]);
  assert.match(view.container.querySelector(".session-location-row span:nth-of-type(2)").textContent, /Worktree/);
  await act(async () => { view.container.querySelectorAll('[role="menuitem"]')[0].click(); });
  assert.deepEqual(calls.worktree, [true, false]);

  await view.render(panel(worktree, "session:location", true));
  assert.equal(view.container.querySelector('[role="menuitem"]').disabled, true, "a running thread cannot change where it works");
  await view.unmount();
});

test("the session panel's branch row moves the checkout onto the branch it is given", async () => {
  window.desktop = fakeDesktop();
  const calls = { menu: [], checkout: [] };
  const panel = (openMenu) => React.createElement(SessionPanel, {
    environment: { status: "available", files: [], branch: "main", additions: 0, deletions: 0 },
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
  const trigger = view.container.querySelector('button[aria-label="Branch"]');
  assert.match(trigger.textContent, /main/, "the row says where the checkout already is");
  assert.equal(view.container.querySelector('[role="listbox"]'), null, "no branch is read until the list is asked for");
  await act(async () => { trigger.click(); });
  assert.deepEqual(calls.menu, ["session:branch"]);

  await view.render(panel("session:branch"));
  const menu = document.querySelector(".branch-menu");
  assert.ok(menu && !view.container.contains(menu), "the list hangs outside the panel, which would crop it");
  const options = [...menu.querySelectorAll('[role="option"]')];
  assert.deepEqual(options.map((option) => option.textContent), ["main", "fix-loader", "feature-x"]);
  await act(async () => { options.find((option) => option.textContent === "fix-loader").click(); });
  assert.deepEqual(calls.checkout, [{ branch: "fix-loader", create: false }]);
  assert.deepEqual(calls.menu, ["session:branch", null], "choosing one closes the list");

  await view.render(panel("session:branch"));
  const search = document.querySelector('input[aria-label="Search branches"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(search, "loader-fix");
    search.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  });
  const creating = [...document.querySelectorAll('[role="option"]')].find((option) => /Create branch/.test(option.textContent));
  await act(async () => { creating.click(); });
  assert.deepEqual(calls.checkout.at(-1), { branch: "loader-fix", create: true });

  await view.render(React.createElement(SessionPanel, { ...panel(null).props, workspaceId: undefined, hasProject: false, environment: null }));
  assert.equal(view.container.querySelector('button[aria-label="Branch"]').disabled, true, "with no checkout there is no branch to change");
  await view.unmount();
});

test("the start options say where a thread begins, and searching narrows the branches", async () => {
  const { ThreadStartOptions } = await vite.ssrLoadModule("/src/renderer/components/ThreadStartOptions.tsx");
  window.desktop = fakeDesktop();
  const chosen = { project: [], branch: [], worktree: [] };
  const projects = [{ id: "project-a", root: "/repo/claudex" }, { id: "project-b", root: "/repo/just-speak" }];
  const options = (branch, worktree) => React.createElement(ThreadStartOptions, {
    projects,
    projectId: "project-a",
    workspaceId: "workspace-a",
    branch,
    worktree,
    onSelectProject: (id) => { chosen.project.push(id); },
    onSelectBranch: (name, create) => { chosen.branch.push(create ? { name, create } : name); },
    onSetWorktree: (on) => { chosen.worktree.push(on); },
  });

  const view = await mount(options(null, false));
  const project = view.container.querySelector('button[aria-label="Project"]');
  assert.match(project.textContent, /claudex/, "the project the thread starts in is filled in already");
  assert.match(view.container.querySelector('button[aria-label="Starting branch"]').textContent, /main/, "and so is the branch the checkout is on");
  assert.equal(view.container.querySelector('.thread-start-check input').checked, false, "a worktree is only ever asked for");

  await act(async () => { project.click(); });
  const projectOptions = [...view.container.querySelectorAll('[role="option"]')];
  assert.deepEqual(projectOptions.map((option) => option.textContent), ["claudex", "just-speak"]);
  await act(async () => { projectOptions[1].click(); });
  assert.deepEqual(chosen.project, ["project-b"]);

  await act(async () => { view.container.querySelector('button[aria-label="Starting branch"]').click(); });
  assert.ok(view.container.querySelector('input[aria-label="Search branches"]'), "the branch list is searchable");
  const branchOptions = [...view.container.querySelectorAll('[role="option"]')];
  assert.deepEqual(branchOptions.map((option) => option.textContent), ["main", "fix-loader", "feature-x"], "every local branch is offered, newest first");
  await act(async () => { branchOptions.find((option) => option.textContent === "fix-loader").click(); });
  assert.deepEqual(chosen.branch, ["fix-loader"]);

  await act(async () => { view.container.querySelector('button[aria-label="Starting branch"]').click(); });
  const reopened = [...view.container.querySelectorAll('[role="option"]')];
  await act(async () => { reopened.find((option) => option.textContent === "main").click(); });
  assert.deepEqual(chosen.branch, ["fix-loader", null], "the branch the checkout is already on asks for nothing");

  await view.render(options({ name: "fix-loader", create: false }, false));
  assert.match(view.container.querySelector('button[aria-label="Starting branch"]').textContent, /fix-loader/);
  await act(async () => { view.container.querySelector('.thread-start-check input').click(); });
  assert.deepEqual(chosen.worktree, [true]);
  await view.unmount();
});

test("a branch the repository does not have is offered as one to create", async () => {
  const { ThreadStartOptions } = await vite.ssrLoadModule("/src/renderer/components/ThreadStartOptions.tsx");
  window.desktop = fakeDesktop();
  const chosen = [];
  const options = (branch) => React.createElement(ThreadStartOptions, {
    projects: [{ id: "project-a", root: "/repo/claudex" }],
    projectId: "project-a",
    workspaceId: "workspace-a",
    branch,
    worktree: false,
    onSelectProject() {},
    onSelectBranch: (name, create) => { chosen.push({ name, create }); },
    onSetWorktree() {},
  });

  const view = await mount(options(null));
  await act(async () => { view.container.querySelector('button[aria-label="Starting branch"]').click(); });
  const search = view.container.querySelector('input[aria-label="Search branches"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  const type = async (text) => {
    await act(async () => {
      setValue.call(search, text);
      search.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    });
  };

  await type("main");
  assert.equal(
    [...view.container.querySelectorAll('[role="option"]')].some((option) => /Create branch/.test(option.textContent)),
    false,
    "a name the repository already has is a branch to pick, not one to make",
  );

  await type("loader-fix");
  const creating = [...view.container.querySelectorAll('[role="option"]')].find((option) => /Create branch/.test(option.textContent));
  assert.match(creating.textContent, /loader-fix/);
  await act(async () => { creating.click(); });
  assert.deepEqual(chosen, [{ name: "loader-fix", create: true }]);

  await view.render(options({ name: "loader-fix", create: true }));
  const trigger = view.container.querySelector('button[aria-label="Starting branch"]');
  assert.match(trigger.textContent, /loader-fix/);
  assert.match(trigger.textContent, /new/, "a branch yet to exist says so");
  await view.unmount();
});

test("a branch search keeps what the query names, and everything when it is empty", async () => {
  const { matchBranches, newBranchName } = await vite.ssrLoadModule("/src/renderer/components/BranchMenu.tsx");
  const branches = ["main", "fix-loader", "feature-x", "Fix-Encoding"];

  assert.deepEqual(matchBranches(branches, ""), branches);
  assert.deepEqual(matchBranches(branches, "   "), branches, "an empty search is not a filter");
  assert.deepEqual(matchBranches(branches, "fix"), ["fix-loader", "Fix-Encoding"], "case never decides a match");
  assert.deepEqual(matchBranches(branches, "load"), ["fix-loader"], "a fragment anywhere in the name is enough");
  assert.deepEqual(matchBranches(branches, "nope"), []);

  assert.equal(newBranchName(branches, "nope"), "nope");
  assert.equal(newBranchName(branches, "  spaced  "), "spaced", "a name is what the query says, trimmed");
  assert.equal(newBranchName(branches, "main"), null, "a branch that exists is picked rather than made");
  assert.equal(newBranchName(branches, "   "), null);
});

test("resolving a run hands back the workspace the reducer named, kind and all", async () => {
  const { resolveRunWorkspace } = await vite.ssrLoadModule("/src/renderer/task-workspace/resolve-run-workspace.ts");
  const worktree = { id: "worktree-1", kind: "worktree", root: "/worktrees/repo-wt1" };
  const desktop = {
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
  const { resolveRunWorkspace } = await vite.ssrLoadModule("/src/renderer/task-workspace/resolve-run-workspace.ts");
  const calls = [];
  const desktop = {
    createBranch: async (workspaceId, branch) => { calls.push(["create", workspaceId, branch]); },
    checkoutBranch: async () => { throw new Error("Your local changes would be overwritten."); },
    createWorktree: async () => { throw new Error("unreached"); },
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/tmp" }),
    openFolder: async () => null,
  };

  const effect = {
    type: "resolve-run-workspace",
    pendingId: "pending-2",
    picker: false,
    workspace: { id: "workspace-a", kind: "project", root: "/repo" },
    createBranch: { workspaceId: "workspace-a", branch: "feature-x" },
    checkout: { workspaceId: "workspace-a", branch: "feature-x" },
  };
  const failed = await resolveRunWorkspace(effect, desktop);

  assert.deepEqual(calls, [["create", "workspace-a", "feature-x"]], "the branch is made before anything tries to start from it");
  assert.deepEqual(failed, { type: "run.unresolved", pendingId: "pending-2", message: "Your local changes would be overwritten." });
});

test("resolving a run through the picker insists on the same folder", async () => {
  const { resolveRunWorkspace } = await vite.ssrLoadModule("/src/renderer/task-workspace/resolve-run-workspace.ts");
  const desktop = {
    createBranch: async () => {},
    checkoutBranch: async () => {},
    createWorktree: async () => {},
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/tmp" }),
    openFolder: async () => ({ id: "workspace-b", kind: "project", root: "/elsewhere" }),
  };

  const wrong = await resolveRunWorkspace({ type: "resolve-run-workspace", pendingId: "pending-3", picker: true, root: "/repo" }, desktop);

  assert.equal(wrong.type, "run.unresolved");
  assert.match(wrong.message, /same project folder/);
});

test("the browser panel drives the page through the workspace and reports where it is drawn", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  await act(async () => { [...view.container.querySelectorAll(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel").click(); });

  const address = view.container.querySelector('.browser-bar input[aria-label="Address"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(address, "example.com/docs");
    address.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "example.com/docs" }));
  });
  await act(async () => { address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });

  const opened = window.desktop.browserCalls.find(([name]) => name === "open");
  assert.deepEqual(window.desktop.browserCalls.find(([name]) => name === "navigate"), ["navigate", opened[1], "https://example.com/docs"], "the blank tab the launcher made is the one that loads");
  assert.deepEqual(window.desktop.browserCalls.find(([name]) => name === "show").slice(0, 1), ["show"]);
  assert.ok(window.desktop.browserCalls.some(([name]) => name === "bounds"), "the panel reports its rectangle to main");

  await act(async () => {
    window.desktop.browserEvent({ tabId: opened[1], url: "https://example.com/docs", title: "Docs", loading: false, canGoBack: true });
  });
  assert.match(view.container.querySelector(".right-dock-tab.active").textContent, /Docs/, "a page names its own dock tab");

  await act(async () => { view.container.querySelector('.browser-bar button[aria-label="Back"]').click(); });
  assert.deepEqual(window.desktop.browserCalls.at(-1), ["history", opened[1], -1]);

  await view.unmount();
  assert.deepEqual(window.desktop.browserCalls.at(-1), ["bounds", null], "an unmounted panel leaves no page drawn over the app");
});

test("the add menu takes the page off screen so nothing native is drawn over it", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  await act(async () => { [...view.container.querySelectorAll(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel").click(); });

  /** jsdom lays nothing out, so the viewport is given a rectangle of its own to report. */
  const box = { x: 0, y: 50, width: 400, height: 600 };
  view.container.querySelector(".browser-viewport").getBoundingClientRect = () => box;

  const add = view.container.querySelector('button[aria-label="Add right panel tab"]');
  await act(async () => { add.click(); });
  assert.ok(view.container.querySelector('.right-dock-add div[role="menu"]'), "the menu is open");
  assert.deepEqual(window.desktop.browserCalls.at(-1), ["bounds", null], "the page is not drawn while the menu hangs over it");

  await act(async () => { add.click(); });
  assert.equal(view.container.querySelector('.right-dock-add div[role="menu"]'), null);
  assert.deepEqual(window.desktop.browserCalls.at(-1), ["bounds", box], "closing the menu draws the page again");

  await view.unmount();
});

test("a run reads the page through the window and is told when a site is waiting on the user", async () => {
  const desktop = fakeDesktop();
  const harness = await mountWorkspace(desktop);

  await act(async () => { await harness.get().dispatch({ type: "view.set-prompt", prompt: "look at the dashboard" }); });
  await act(async () => { await harness.get().dispatch({ type: "task.send" }); });
  const taskId = harness.get().currentTask.id;
  await act(async () => { await harness.get().dispatch({ type: "browser.open", url: "https://example.com" }); });
  const tabId = harness.get().browserTabs[0].id;

  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "read-1", taskId, op: "browser", read: { op: "tabs" } }); });
  assert.deepEqual(desktop.threadAnswers.at(-1).result.tabs.map((tab) => tab.id), [tabId]);

  /** A page belongs to the thread whose dock holds it, so no other thread reads it. */
  await act(async () => { await desktop.askThreads({ type: "thread.request", requestId: "read-2", taskId: "elsewhere", op: "browser", read: { op: "tabs" } }); });
  assert.deepEqual(desktop.threadAnswers.at(-1).result.tabs, []);

  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "read-3", taskId, op: "browser", read: { op: "snapshot", timeoutMs: 5_000, textLimit: 500 } });
  });
  assert.deepEqual(desktop.browserCalls.at(-1), ["read", tabId, 500, 5_000]);
  assert.equal(desktop.threadAnswers.at(-1).result.snapshot.title, "Example");

  /** A run asking for a site nobody has allowed is answered with the ask, not with a page. */
  await act(async () => { await harness.get().dispatch({ type: "browser.open", taskId, url: "https://dash.example.com" }); });
  await act(async () => {
    await desktop.askThreads({ type: "thread.request", requestId: "read-4", taskId, op: "browser", read: { op: "snapshot", timeoutMs: 1_000 } });
  });
  assert.deepEqual(desktop.threadAnswers.at(-1).result, { kind: "awaiting-approval", url: "https://dash.example.com/" });

  await harness.view.unmount();
});

test("settings rebind a shortcut, and the window is told what to match", async () => {
  seedTaskWithSubagent();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  assert.deepEqual(desktop.shortcuts, [{}], "the window starts out matching the defaults");

  await act(async () => { view.container.querySelector(".sidebar-settings").click(); });
  await act(async () => { [...view.container.querySelectorAll(".settings-sidebar nav button")].find((button) => button.textContent === "Shortcuts").click(); });
  const row = (label) => [...view.container.querySelectorAll(".shortcut-row")].find((element) => element.querySelector("strong").textContent === label);
  /** jsdom is no Mac, so the panel spells its modifiers out rather than drawing them. */
  assert.equal(row("New thread").querySelector("kbd").textContent, "Ctrl+N");

  await act(async () => { [...row("New thread").querySelectorAll("button")].find((button) => button.textContent === "Change").click(); });
  assert.match(row("New thread").textContent, /Press a keystroke…/);
  assert.deepEqual(desktop.captures, [true]);

  await act(async () => { desktop.captureShortcut("Mod+Shift+K"); });
  assert.equal(row("New thread").querySelector("kbd").textContent, "Ctrl+Shift+K");
  assert.deepEqual(desktop.captures, [true, false], "the window goes back to acting on keystrokes");
  assert.deepEqual(desktop.shortcuts.at(-1), { "thread.new": "Mod+Shift+K" });

  /** Taking a keystroke that another action holds leaves that action with none. */
  await act(async () => { [...row("New tab").querySelectorAll("button")].find((button) => button.textContent === "Change").click(); });
  await act(async () => { desktop.captureShortcut("Mod+W"); });
  assert.equal(row("New tab").querySelector("kbd").textContent, "Ctrl+W");
  assert.match(row("Close").textContent, /Not set/);
  assert.deepEqual(desktop.shortcuts.at(-1), { "thread.new": "Mod+Shift+K", "tab.new": "Mod+W", "tab.close": null });

  await act(async () => { view.container.querySelector(".settings-group-action button").click(); });
  assert.equal(row("New thread").querySelector("kbd").textContent, "Ctrl+N");
  assert.deepEqual(desktop.shortcuts.at(-1), {});

  await view.unmount();
});

test("⌘W closes the page in front, then the dock, and only then the window", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  await act(async () => { [...view.container.querySelectorAll(".right-dock-picker button")].find((button) => button.getAttribute("aria-label") === "Open Browser panel").click(); });

  const address = view.container.querySelector('.browser-bar input[aria-label="Address"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  await act(async () => {
    setValue.call(address, "example.com");
    address.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "example.com" }));
  });
  await act(async () => { address.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 1);

  await act(async () => { window.desktop.pressShortcut("tab.close"); });
  assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 0, "the page is the tab, so it goes first");
  assert.equal(view.container.querySelector(".browser-panel"), null);

  await act(async () => { window.desktop.pressShortcut("tab.close"); });
  assert.equal(view.container.querySelector(".right-dock").hidden, true, "then the dock");

  assert.deepEqual(window.desktop.browserCalls.filter(([name]) => name === "close-window"), []);
  await act(async () => { window.desktop.pressShortcut("tab.close"); });
  assert.deepEqual(window.desktop.browserCalls.filter(([name]) => name === "close-window"), [["close-window"]], "with nothing in front, ⌘W is the window's");

  await view.unmount();
});

/** A workflow still going is drawn against the clock, so its fixture starts where a live one would. */
const workflowStart = Date.now() - 92_000;
const workflowAgents = [
  { index: 0, label: "review:bugs", state: "done", phaseIndex: 0, phaseTitle: "Review", startedAt: workflowStart, durationMs: 60_000, tokens: 41_200, toolCalls: 12, resultPreview: "3 findings", model: "opus" },
  { index: 1, label: "verify:query.ts", state: "error", phaseIndex: 1, phaseTitle: "Verify", startedAt: workflowStart + 60_000, durationMs: 30_000, tokens: 20_500, error: "Agent returned no structured output" },
  { index: 2, label: "verify:store.ts", state: "running", phaseIndex: 1, phaseTitle: "Verify", queuedAt: workflowStart + 60_000, startedAt: workflowStart + 61_000, tokens: 18_600, lastToolName: "Grep", isolation: "worktree", attempt: 2, promptPreview: "Adversarially verify this finding" },
];

const liveWorkflow = {
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

test("the workflow panel groups agents by phase, draws their lanes, and opens one", async () => {
  const stopped = [];
  const view = await mount(React.createElement(WorkflowPanel, { workflow: liveWorkflow, onStop: (id) => { stopped.push(id); } }));

  assert.match(view.container.textContent, /review-changes/);
  assert.match(view.container.textContent, /2\/3/, "done counts both the finished and the failed");
  assert.deepEqual([...view.container.querySelectorAll(".workflow-group-head h3")].map((head) => head.textContent), ["Review", "Verify"]);
  assert.equal(view.container.querySelectorAll(".workflow-lane").length, 3);
  assert.match(view.container.querySelector(".workflow-row .workflow-row-main small").textContent, /3 findings/);
  assert.match(view.container.textContent, /Using Grep/);
  assert.match(view.container.textContent, /retry 2/);
  assert.match(view.container.textContent, /worktree/);
  assert.match(view.container.textContent, /Agent returned no structured output/);

  await act(async () => { view.container.querySelector('button[aria-label="Stop review-changes"]'); });
  await act(async () => { view.container.querySelector(".workflow-stop").click(); });
  assert.deepEqual(stopped, ["wf-1"]);

  await act(async () => { view.container.querySelector('.workflow-row[aria-label="Open verify:store.ts details"]').click(); });
  assert.match(view.container.textContent, /Adversarially verify this finding/);
  assert.match(view.container.textContent, /Previews are the first 400 characters/);
  await act(async () => { view.container.querySelector(".session-back").click(); });
  assert.equal(view.container.querySelectorAll(".workflow-lane").length, 3, "the panel comes back to the whole workflow");
  await view.unmount();
});

test("a workflow that ended stops reporting its agents as live", async () => {
  const view = await mount(React.createElement(WorkflowPanel, {
    workflow: { ...liveWorkflow, status: "stopped", finishedAt: workflowStart + 92_000, summary: 'Dynamic workflow "review-changes" was stopped' },
    onStop() {},
  }));

  assert.equal(view.container.querySelector(".workflow-stop"), null, "a workflow that ended has nothing to stop");
  assert.match(view.container.textContent, /Stopped with the run/);
  assert.match(view.container.textContent, /was stopped/);
  assert.equal(view.container.querySelectorAll(".workflow-lane-track > i.run.running").length, 0);
  await view.unmount();
});

test("the session panel lists a workflow as a process and opens its panel", async () => {
  const opened = [];
  const stopped = [];
  const view = await mount(React.createElement(SessionPanel, {
    environment: { status: "available", files: [], branch: "main", additions: 0, deletions: 0 },
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
  await act(async () => { view.container.querySelector('button[aria-label="Open review-changes workflow"]').click(); });
  assert.deepEqual(opened, ["wf-1"]);
  await act(async () => { view.container.querySelector('button[aria-label="Stop review-changes"]').click(); });
  assert.deepEqual(stopped, ["wf-1"]);

  await view.render(React.createElement(SessionPanel, {
    environment: null, hasProject: true, subagents: [], backgroundProcesses: [], workflows: [{ ...liveWorkflow, status: "completed" }], automationCount: 0,
    onSelect() {}, onOpenAutomations() {}, onOpenWorkflow() {}, onStopProcess() {},
  }));
  assert.equal(view.container.querySelector('button[aria-label="Stop review-changes"]'), null, "a workflow that ended keeps its row without a stop");
  await view.unmount();
});
