import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "localStorage", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "navigator", "File", "Blob", "FileReader", "DOMParser", "innerWidth", "innerHeight"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
/** jsdom has no animation frames. Everything queued for one runs together, on a single timestamp. */
let animationTime = 0;
let frameId = 0;
let drain = null;
const queuedFrames = new Map();
function runFrame() {
  clearTimeout(drain);
  drain = null;
  animationTime += 33;
  /** Only the frames asked for before this one, and only while a frame ahead has not cancelled them. */
  for (const id of [...queuedFrames.keys()]) {
    const callback = queuedFrames.get(id);
    if (!callback) continue;
    queuedFrames.delete(id);
    callback(animationTime);
  }
}
function scheduleFrame() {
  if (drain || queuedFrames.size === 0) return;
  drain = setTimeout(runFrame, 0);
}
for (const [name, value] of [["requestAnimationFrame", (fn) => { const id = (frameId += 1); queuedFrames.set(id, fn); scheduleFrame(); return id; }], ["cancelAnimationFrame", (id) => queuedFrames.delete(id)]]) {
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
/** React watches the focused field through the event methods only IE ever had, which jsdom has not. */
for (const prototype of [dom.window.HTMLInputElement.prototype, dom.window.HTMLTextAreaElement.prototype]) {
  prototype.attachEvent = () => {};
  prototype.detachEvent = () => {};
}
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.Element.prototype.getAnimations = () => [];

/** xterm ships a broken `module` field, so it is bundled here the way the real build bundles it. */
const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom", ssr: { noExternal: [/^@xterm\//] } });
const { SessionPanel } = await vite.ssrLoadModule("/src/renderer/components/SessionPanel.tsx");
const { SubagentInspector } = await vite.ssrLoadModule("/src/renderer/components/SubagentInspector.tsx");
const { AgentsPanel, matchSubagents } = await vite.ssrLoadModule("/src/renderer/components/SubagentList.tsx");
const { WorkspaceHeader } = await vite.ssrLoadModule("/src/renderer/components/WorkspaceHeader.tsx");
const { MarkdownMessage, MessageLinkProvider } = await vite.ssrLoadModule("/src/renderer/components/MarkdownMessage.tsx");
const { DiagramViewer, naturalDiagram } = await vite.ssrLoadModule("/src/renderer/components/MermaidBlock.tsx");
const { useTaskWorkspace } = await vite.ssrLoadModule("/src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await vite.ssrLoadModule("/src/renderer/App.tsx");
const { TaskComposer } = await vite.ssrLoadModule("/src/renderer/components/TaskComposer.tsx");
const { drawAnnotations, wrapLabel } = await vite.ssrLoadModule("/src/renderer/components/ImageAnnotator.tsx");
const { SettingsPanel } = await vite.ssrLoadModule("/src/renderer/components/SettingsPanel.tsx");
const { ConversationTimeline, groupTimeline, READING_SETTLE_MS } = await vite.ssrLoadModule("/src/renderer/components/ConversationTimeline.tsx");
const { StreamingText } = await vite.ssrLoadModule("/src/renderer/components/StreamingText.tsx");
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

test("a diagram keeps the size it was drawn at instead of the container's cap", () => {
  const svg = '<svg aria-roledescription="flowchart-v2" viewBox="0 0 512.5 300" style="max-width: 512.5px; background-color: transparent;" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg"><g></g></svg>';

  const diagram = naturalDiagram(svg);

  assert.deepEqual([diagram.width, diagram.height], [512.5, 300]);
  assert.doesNotMatch(diagram.markup, /max-width/);
  assert.doesNotMatch(diagram.markup, /width="100%"/);
  assert.match(diagram.markup, /background-color/);
});

test("markup without a usable viewBox is left exactly as it came", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g></g></svg>';

  const diagram = naturalDiagram(svg);

  assert.deepEqual([diagram.markup, diagram.width, diagram.height], [svg, 0, 0]);
});

test("the diagram viewer scales between the fitted size and 400%, and reports where it is", async () => {
  const diagram = { markup: '<svg viewBox="0 0 400 200"></svg>', width: 400, height: 200 };
  const view = await mount(React.createElement(DiagramViewer, { diagram, onClose: () => {} }));
  const zoom = (label) => document.querySelector(`.viewer-zoom button[aria-label="${label}"]`);
  const readout = () => document.querySelector(".viewer-zoom span").textContent;
  const drawn = () => document.querySelector(".viewer-stage .mermaid-svg").style.getPropertyValue("--diagram-width");

  assert.equal(readout(), "100%");
  assert.equal(drawn(), "400px");
  assert.equal(zoom("Zoom out").disabled, true);

  await act(async () => { zoom("Zoom in").click(); });
  assert.equal(readout(), "140%");
  assert.equal(drawn(), "560px");

  for (let step = 0; step < 8; step += 1) await act(async () => { zoom("Zoom in").click(); });
  assert.equal(readout(), "400%");
  assert.equal(zoom("Zoom in").disabled, true);

  for (let step = 0; step < 8; step += 1) await act(async () => { zoom("Zoom out").click(); });
  assert.equal(readout(), "100%");
  assert.equal(zoom("Zoom out").disabled, true);
  await view.unmount();
});

test("the diagram viewer closes on Escape and on the backdrop, but not on a drag off the diagram", async () => {
  const closed = [];
  const diagram = { markup: '<svg viewBox="0 0 400 200"></svg>', width: 400, height: 200 };
  const view = await mount(React.createElement(DiagramViewer, { diagram, onClose: () => closed.push("closed") }));
  const backdrop = document.querySelector(".viewer.diagram");
  const drawing = document.querySelector(".viewer-stage .mermaid-svg");
  const press = (target) => target.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
  const release = (target) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  await act(async () => { press(drawing); release(backdrop); });
  assert.deepEqual(closed, []);

  await act(async () => { press(drawing); release(drawing); });
  assert.deepEqual(closed, []);

  await act(async () => { press(backdrop); release(backdrop); });
  assert.deepEqual(closed, ["closed"]);

  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.deepEqual(closed, ["closed", "closed"]);
  await view.unmount();
});

function mountMessage(markdown, actions = {}) {
  return mount(React.createElement(MessageLinkProvider, { actions }, React.createElement(MarkdownMessage, null, markdown)));
}

test("a thread link opens that thread in place, and nothing else under the scheme is a link", async () => {
  const selected = [];
  const markdown = [
    "See [the sidebar work](claudex://thread/task-9) for how it went.",
    "",
    "Not [an archive](claudex://archive/task-9) and not [the docs](https://example.com).",
  ].join("\n");
  const view = await mountMessage(markdown, { selectTask: (taskId) => selected.push(taskId) });

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
  const view = await mountMessage("See [the sidebar work](claudex://thread/task-9).");

  assert.equal(view.container.querySelector("a"), null);
  assert.match(view.container.textContent, /See the sidebar work\./);
  await view.unmount();
});

test("only Markdown file links open a file, at the line they name", async () => {
  const opened = [];
  const markdown = [
    "Plain src/renderer/App.tsx:42 and `AGENTS.md` stay plain.",
    "",
    "Open [the app](/checkout/src/renderer/App.tsx:42), [the notes](docs/My%20Notes.md:7:3) or [the readme](README.md).",
  ].join("\n");
  const view = await mountMessage(markdown, { openFile: (path, line) => opened.push([path, line]) });

  const links = [...view.container.querySelectorAll("a")];
  assert.deepEqual(links.map((link) => link.textContent), ["the app", "the notes", "the readme"]);
  assert.match(view.container.textContent, /Plain src\/renderer\/App\.tsx:42 and AGENTS\.md stay plain\./);

  for (const link of links) await act(async () => { link.click(); });
  assert.deepEqual(opened, [
    ["/checkout/src/renderer/App.tsx", 42],
    ["docs/My Notes.md", 7],
    ["README.md", null],
  ], "the line comes through separately, and the column is dropped");
  await view.unmount();
});

test("a web link opens externally by default and offers the browser panel on right click", async () => {
  const opened = [];
  const view = await mountMessage("Read https://example.com/docs for the rest.", { openUrlInApp: (url) => opened.push(url) });

  const link = view.container.querySelector("a");
  assert.equal(link.target, "_blank", "the main process hands an ordinary click to the default browser");
  await act(async () => { link.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 60 })); });
  const item = document.querySelector(".context-menu-popover button");
  assert.equal(item.textContent, "Open in Claudex");
  await act(async () => { item.click(); });
  assert.deepEqual(opened, ["https://example.com/docs"]);
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

test("the sidebar follows the thread the keyboard steps to", async () => {
  const thread = (id) => ({
    id, title: id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  });
  const scrolled = [];
  const original = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ className: this.className, options }); };
  const sidebar = (currentId) => React.createElement(ProjectSidebar, {
    open: true,
    inactive: false,
    projects: [],
    orderedTasks: [thread("first"), thread("second")],
    recentTasks: [thread("first"), thread("second")],
    currentId,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onRenameTask() {},
    onDismissTask() {}, onDismissAll() {},
    onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar("first"));
  await view.render(sidebar("second"));
  dom.window.HTMLElement.prototype.scrollIntoView = original;

  assert.deepEqual(scrolled.at(-1), { className: "task-row active", options: { block: "nearest" } }, "the row now open is brought into view");
  await view.unmount();
});

test("activity mode ranks threads into priority, running, and the rest, and only priority dismisses", async () => {
  const thread = (id, overrides = {}) => ({
    id, title: id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, ...overrides,
  });
  const dismissed = [];
  let clearedAll = 0;
  const view = await mount(React.createElement(ProjectSidebar, {
    open: true,
    inactive: false,
    projects: [{ id: "project-1", root: "/work/project" }],
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(["busy", "asked"]),
    blockedTaskIds: new Set(["asked"]),
    automatedTaskIds: new Set(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: {
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
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onRenameTask() {},
    onDismissTask: (taskId) => { dismissed.push(taskId); },
    onDismissAll: () => { clearedAll += 1; },
    onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  const listed = (label) => [...view.container.querySelectorAll(`nav[aria-label="${label}"] .task-row-text > span`)].map((row) => row.textContent);
  assert.deepEqual(listed("Priority"), ["asked", "unread", "seen"]);
  assert.deepEqual(listed("Running"), ["busy"]);
  assert.deepEqual(listed("Threads"), ["quiet"]);
  assert.equal(view.container.querySelector('[data-rfd-draggable-id]'), null, "activity mode ranks its own rows, so none of them drag");

  assert.match(
    view.container.querySelector('nav[aria-label="Priority"] .task-row-text > small').textContent,
    /^project · /,
    "a flat list still says which folder a thread lives in",
  );
  assert.deepEqual(
    [...view.container.querySelectorAll('nav[aria-label="Priority"] .task-attention.finished')].length,
    1,
    "a verdict the user has read ranks without a mark of its own",
  );
  assert.equal(
    view.container.querySelector('nav[aria-label="Priority"] [aria-label="Needs approval"]').className,
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

  await act(async () => { view.container.querySelector('[aria-label="Dismiss seen"]').click(); });
  assert.deepEqual(dismissed, ["seen"], "a read row still offers to be filed away");

  await act(async () => { view.container.querySelector('[aria-label="Dismiss all"]').click(); });
  assert.equal(clearedAll, 1);
  await view.unmount();
});

test("only the priority heading offers to dismiss every dot at once", async () => {
  const thread = (id, overrides = {}) => ({
    id, title: id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, ...overrides,
  });
  const sidebar = (priority) => React.createElement(ProjectSidebar, {
    open: true,
    inactive: false,
    projects: [],
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority, running: [], threads: [] },
    mode: "activity",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onRenameTask() {}, onDismissTask() {}, onDismissAll() {},
    onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar([]));
  assert.equal(view.container.querySelector('[aria-label="Dismiss all"]'), null, "no dot to take off, so the heading offers nothing");

  await view.render(sidebar([thread("done", { outcome: "failed" })]));
  assert.ok(view.container.querySelector('[aria-label="Dismiss all"]'), "one dot is enough to offer it");
  assert.equal(view.container.querySelector(".activity-heading .section-count").textContent, "1");
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
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: true,
    canGoForward: false,
    onGoBack: () => { backSteps += 1; },
    onGoForward() {},
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onDismissTask() {}, onDismissAll() {}, onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
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
  let windowGrabbed;
  let shortcutRefused;
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
    get grabWindow() { return windowGrabbed; },
    get refuseShortcut() { return shortcutRefused; },
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
    branches: async () => ({ status: "available", branches: ["main", "fix-loader", "feature-x"], remotes: ["origin/main"], current: "main" }),
    pullRequest: async () => null,
    diffSummary: async (workspaceId, range) => ({ status: "available", range, files: [], additions: 0, deletions: 0 }),
    diffPatch: async () => ({ status: "available", patch: "" }),
    checkoutBranch: async () => {},
    createBranch: async () => {},
    createWorktree: async () => ({ id: "wt1", root: "/worktrees/repo-wt1", workspaceId: "worktree-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 }),
    releaseWorktree: async () => ({ commit: null, shortCommit: null, ref: null }),
    deleteWorktree: async () => {},
    saveAttachment: async () => "/tmp/claudex-attachments/pasted.png",
    readAttachment: async () => "iVBORw0KGgo=",
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
    themes: [],
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
    focusBrowserTab: async (tabId) => { browserCalls.push(["focus", tabId]); },
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
    setCaptureSound(playing) { this.captureSounds.push(playing); },
    setTheme(theme) { this.themes.push(theme); },
    setShortcutCapture(capturing) { this.captures.push(capturing); },
    captureSounds: [],
    onShortcut: (next) => { shortcutPressed = next; return () => {}; },
    onShortcutCaptured: (next) => { shortcutCaptured = next; return () => {}; },
    onWindowScreenshot: (next) => { windowGrabbed = next; return () => {}; },
    onDesktopShortcutRefused: (next) => { shortcutRefused = next; return () => {}; },
    closeWindow: () => { browserCalls.push(["close-window"]); },
    focusWindow: () => { browserCalls.push(["focus-window"]); },
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
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, archivedTasks: [], theme: "claudex-dark", allowedOrigins: [], shortcuts: [], captureSound: true, capturingShortcut: null, onSetTheme() {}, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onSetCaptureSound() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
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
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, archivedTasks: [], theme: "claudex-dark", allowedOrigins: [], shortcuts: [], captureSound: true, capturingShortcut: null, onSetTheme() {}, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onSetCaptureSound() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
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
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, archivedTasks: [], theme: "claudex-dark", allowedOrigins: [], shortcuts: [], captureSound: true, capturingShortcut: null, onSetTheme() {}, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onSetCaptureSound() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
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
  const view = await mount(React.createElement(SettingsPanel, { onClose() {}, archivedTasks: [], theme: "claudex-dark", allowedOrigins: [], shortcuts: [], captureSound: true, capturingShortcut: null, onSetTheme() {}, onRestoreTask() {}, onClearArchive() {}, onClearBrowserData() {}, onSetCaptureSound() {}, onCaptureShortcut() {}, onSetShortcut() {}, onResetShortcuts() {} }));
  await act(async () => { [...view.container.querySelectorAll(".settings-sidebar nav button")].find((button) => button.textContent === "Usage").click(); });

  assert.match(view.container.querySelector(".settings-error").textContent, /Untrusted IPC sender/);
  await view.unmount();
});

test("a window grabbed by the desktop hotkey waits in the composer, and never twice", async () => {
  localStorage.clear();
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));

  await act(async () => { desktop.grabWindow({ app: "Figma", title: "Untitled", path: "/tmp/claudex-attachments/grabbed.png" }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(view.container.querySelectorAll(".attachment-chip").length, 1);
  assert.equal(view.container.querySelector('button[aria-label="Send task"]').disabled, false);

  await act(async () => { view.container.querySelector('button[aria-label="Remove image 1"]').click(); });
  assert.equal(view.container.querySelectorAll(".attachment-chip").length, 0);

  await act(async () => { desktop.grabWindow({ app: "Figma", title: "Untitled", path: "/tmp/claudex-attachments/again.png" }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(view.container.querySelectorAll(".attachment-chip").length, 1, "a second press attaches the newer window");
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

test("the appearance page sets the type, and only the conversation and the terminal follow the size", async () => {
  localStorage.clear();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  await act(async () => { view.container.querySelector(".sidebar-settings").click(); });
  await act(async () => { [...view.container.querySelectorAll(".settings-sidebar nav button")].find((button) => button.textContent === "Appearance").click(); });

  const root = dom.window.document.documentElement;
  assert.equal(root.dataset.uiFont, "system");
  assert.equal(root.dataset.readingSize, "regular");

  const card = (family) => [...view.container.querySelectorAll(".theme-choice")].find((choice) => choice.textContent.includes(family));
  await act(async () => { card("Inter").click(); });
  assert.equal(root.dataset.uiFont, "inter");
  await act(async () => { card("JetBrains Mono").click(); });
  assert.equal(root.dataset.monoFont, "jetbrains-mono");

  const steps = view.container.querySelectorAll(".size-steps");
  await act(async () => { [...steps[0].querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Large").click(); });
  await act(async () => { [...steps[1].querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Small").click(); });
  assert.equal(root.dataset.readingSize, "large");
  assert.equal(root.dataset.terminalSize, "small");

  const stored = JSON.parse(localStorage.getItem("claudex.view-preferences.v1"));
  assert.deepEqual(
    { uiFont: stored.uiFont, monoFont: stored.monoFont, readingSize: stored.readingSize, terminalSize: stored.terminalSize },
    { uiFont: "inter", monoFont: "jetbrains-mono", readingSize: "large", terminalSize: "small" },
  );
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
  await act(async () => { settings[0].querySelector("summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
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

test("one outside pointer press dismisses the slash menu until the draft changes", async () => {
  window.desktop = fakeDesktop({ commands: async () => ({ status: "available", commands: [{ name: "review", description: "Review this change.", argumentHint: "" }] }) });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return React.createElement(TaskComposer, {
      prompt, folder: "/project", workspaceId: "workspace-1", mode: "confirm", model: "opus", effort: "medium", runActive: false,
      onPromptChange: setPrompt, onModeChange() {}, onModelChange() {}, onEffortChange() {}, queuedMessages: [], onSteerQueued() {}, onDropQueued() {}, onSend() {}, onCancel() {},
    });
  }
  const view = await mount(React.createElement(Harness));
  const textarea = view.container.querySelector("textarea");
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  await act(async () => {
    textarea.focus();
    setValue.call(textarea, "/");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  assert.ok(view.container.querySelector(".command-menu"));
  await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  assert.equal(view.container.querySelector(".command-menu"), null);
  await act(async () => {
    setValue.call(textarea, "/r");
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

test("a view opened in the dock takes the caret with it", async () => {
  localStorage.clear();
  localStorage.setItem("claudex.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "task-1",
      title: "Inspect",
      executionPolicy: "confirm",
      messages: [],
      continuation: { provider: "claude", value: "main-session" },
      continuationStatus: "available",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      updatedAt: 2,
    }] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  await act(async () => { view.container.querySelector('button[aria-label="Open Side chat panel"]').click(); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Side chat prompt"]'), "the chat is opened to type in");

  await act(async () => { view.container.querySelector('button[aria-label="Add right panel tab"]').click(); });
  await act(async () => { [...view.container.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Browser")).click(); });
  assert.equal(document.activeElement, view.container.querySelector('.browser-bar input[aria-label="Address"]'), "a page with no address yet asks for one");

  await view.unmount();
});

test("hiding the panel hands the caret back instead of losing it", async () => {
  localStorage.clear();
  localStorage.setItem("claudex.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "task-1",
      title: "Inspect",
      executionPolicy: "confirm",
      messages: [],
      continuation: { provider: "claude", value: "main-session" },
      continuationStatus: "available",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      updatedAt: 2,
    }] }),
    projects: JSON.stringify({ version: 2, value: [] }),
    lastFolder: JSON.stringify({ version: 2, value: null }),
  }));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show right panel"]').click(); });
  await act(async () => { view.container.querySelector('button[aria-label="Open Side chat panel"]').click(); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Side chat prompt"]'));

  await act(async () => { view.container.querySelector('button[aria-label="Hide right panel"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Task prompt"]'), "the composer takes the keyboard the hidden panel was holding");

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
  assert.equal(view.container.querySelectorAll('.right-dock-content > div[hidden]').length, 6);
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

test("the sidebar switches to activity mode, and dismissing there takes the dot off for good", async () => {
  seedProjectTasks([
    { id: "quiet", title: "Quiet task", sortIndex: 0, updatedAt: 5, createdAt: 5 },
    { id: "settled", title: "Settled task", sortIndex: 1, updatedAt: 9, createdAt: 9, outcome: "finished", outcomeUnread: true },
  ]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const toggle = () => view.container.querySelector('[aria-label="Rank threads by activity"]');
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
  await act(async () => { view.container.querySelector('nav[aria-label="Priority"] .task-row').click(); });
  assert.deepEqual(priority(), ["Settled task"]);
  assert.equal(view.container.querySelector(".task-attention.finished"), null);

  await act(async () => { view.container.querySelector('[aria-label="Dismiss Settled task"]').click(); });
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

  const waiting = [...view.container.querySelectorAll(".project-task-row")].find((row) => row.textContent.includes("Waiting task"));
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

test("a run settling on the thread on screen ranks it without marking it, even behind a blurred window", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Inspect the app"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const start = desktop.sent[0];

  await act(async () => { window.dispatchEvent(new Event("blur")); });
  await act(async () => {
    desktop.listener({ type: "run.status", taskId: start.taskId, runId: start.runId, sequence: 1, status: "succeeded" });
  });
  assert.equal(workspace.get().currentTask.outcome, "finished");
  assert.equal(workspace.get().currentTask.outcomeUnread, undefined);

  await act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.equal(workspace.get().currentTask.outcomeUnread, undefined, "and coming back finds nothing marked");
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
    loadTaskStore: async () => ({ version: 2, projects: [BRANCH_PROJECT], worktrees: [], tasks: [task], lastFolder: BRANCH_PROJECT.root }),
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
  await act(async () => { modelMenu.querySelector("summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(
    [...modelMenu.querySelectorAll(".setting-option strong")].map((item) => item.textContent),
    ["Fable", "Opus", "Sonnet", "Haiku"],
  );
  assert.equal(modelMenu.querySelector(".setting-summary-label").textContent, "Opus");
  const effortMenu = view.container.querySelectorAll(".setting-menu")[2];
  await act(async () => { effortMenu.querySelector("summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
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
  const task = {
    id: "task-1", title: "Task", projectId: project.id, executionPolicy: "confirm", messages: [],
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

function timelineView(messages, status, streamingTail, runEndedAt, find, waitingOn) {
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
    currentTask: task, folder: "/p", status, compacting: false, waitingOn, streamingTail, scrollContainerRef: { current: scroller }, find,
  });
}

const BOTTOM = 4000;

function threadHarness() {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 900 });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: BOTTOM });
  let offset = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => offset, set: (next) => { offset = next; } });
  const scrolls = [];
  scroller.scrollTo = ({ top }) => { scrolls.push(top); offset = top; };
  document.body.append(scroller);
  const scrollContainerRef = { current: scroller };
  /** What the workspace would hold, fed back in as each thread is opened. */
  const points = {};
  const moves = [];
  const thread = (id, count, prefix) => React.createElement(ConversationTimeline, {
    currentTask: {
      id, title: id, executionPolicy: "confirm", continuationStatus: "none", updatedAt: 1,
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      messages: transcript(...Array.from({ length: count }, (_, index) => ({ kind: index % 2 === 0 ? "user" : "assistant", text: `${id} ${index}` })))
        .map((message, index) => (prefix ? { ...message, id: `${prefix}${index}` } : message)),
    },
    folder: "/p", status: "idle", compacting: false, waitingOn: null, scrollContainerRef,
    readingPoint: points[id] ?? null,
    onReadingPointMove: (point) => { points[id] = point; moves.push({ id, point }); },
  });
  const scrollTo = async (top) => {
    await act(async () => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    });
  };
  /** The transcript places itself in a frame, which the shimmed one runs on a timer. */
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const resize = async () => act(async () => {
    for (const observer of [...ResizeObserverStub.live]) observer.callback([], observer);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  return { scroller, scrolls, points, moves, thread, scrollTo, settle, resize, done: (view) => { view.unmount(); scroller.remove(); } };
}

test("a thread reopens where its reader left it, and one left at the foot reopens there", async () => {
  const { scrolls, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("foot", 12));
  await settle();
  await scrollTo(BOTTOM - 900);

  scrolls.length = 0;
  await view.render(thread("read", 12));
  await settle();
  assert.ok(scrolls.length > 0, "returning to a thread places its view");
  assert.ok(!scrolls.includes(BOTTOM), "a thread left mid-transcript does not reopen at its foot");

  scrolls.length = 0;
  await view.render(thread("foot", 12));
  await settle();
  assert.equal(scrolls.at(-1), BOTTOM, "a thread left at its foot reopens there");

  await done(view);
});

test("a thread that gained messages while its reader was away reopens where they were", async () => {
  const { scrolls, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("foot", 12));
  await settle();
  await scrollTo(BOTTOM - 900);

  scrolls.length = 0;
  await view.render(thread("read", 14));
  await settle();
  /** New work is appended below, so the reading place above it stands: the view is not sent to its foot. */
  assert.ok(scrolls.length > 0, "the thread still places its view");
  assert.ok(!scrolls.includes(BOTTOM), "an append does not send a returning reader to its foot");

  await done(view);
});

test("a thread whose saved place no longer exists opens at its foot", async () => {
  const { scrolls, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("foot", 12));
  await settle();

  /** The history above the place was rewritten out from under it, as a compaction does. */
  scrolls.length = 0;
  await view.render(thread("read", 12, "n"));
  await settle();
  assert.ok(scrolls.length > 0, "the thread still places its view");
  assert.equal(scrolls.at(-1), BOTTOM, "a place whose row is gone opens at the foot");

  await done(view);
});

test("the workspace hears where a reader settles without a switch having to carry it", async () => {
  const { moves, thread, scrollTo, settle, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await new Promise((resolve) => setTimeout(resolve, READING_SETTLE_MS + 80));

  assert.ok(moves.length >= 1, "the settled place was reported");
  const reported = moves.filter((move) => move.id === "read").at(-1);
  assert.ok(reported.point !== null, "a mid-transcript reader is not reported at the foot");
  assert.ok(typeof reported.point.depth === "number", "the report carries how far into the row the view sat");

  /** Reporting the same place again adds nothing for the workspace to hear. */
  const heard = moves.length;
  await scrollTo(300);
  await new Promise((resolve) => setTimeout(resolve, READING_SETTLE_MS + 80));
  assert.equal(moves.length, heard, "an unchanged place is never reported twice");

  await done(view);
});

test("a reader who scrolls after a restore is left where they put themselves", async () => {
  const { scrolls, thread, scrollTo, settle, resize, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await view.render(thread("foot", 12));
  await settle();
  await view.render(thread("read", 12));
  await settle();

  /** A plain scroll, with no gesture behind it: a keyboard or the scrollbar reads exactly like this. */
  await scrollTo(900);
  scrolls.length = 0;
  await resize();
  assert.deepEqual(scrolls, [], "the restored row stops holding once the reader moves");

  await done(view);
});

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

  const run = view.container.querySelector(".work-run");
  assert.equal(run.querySelector(".work-arg").textContent, "Read");
  assert.equal(run.querySelector(".work-count").textContent, "+2");
  assert.equal(view.container.querySelector(".work-note").textContent, "I'll investigate.");
  assert.equal(view.container.querySelectorAll(".work-steps").length, 0);

  await expand(run);
  assert.deepEqual([...view.container.querySelectorAll(".work-steps .work-row .work-tool")].map((step) => step.textContent), ["Bash", "Grep", "Read"]);
  await view.unmount();
});

test("a run of tool calls leads with the argument, not the tool name", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Bash", detail: JSON.stringify({ command: "git status --short" }) },
    { kind: "tool", text: "Bash", detail: JSON.stringify({ command: "yarn tsc --noEmit" }) },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = view.container.querySelector(".work-run");
  assert.equal(run.querySelector(".work-arg").textContent, "$yarn tsc --noEmit");

  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-arg")].map((step) => step.textContent), ["$git status --short", "$yarn tsc --noEmit"]);
  assert.equal(run.querySelector(".work-row .work-tool"), null, "a run of one tool names it once, in its own summary");
  await view.unmount();
});

test("a run of mixed tools names the tool on every call", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Read", detail: JSON.stringify({ file_path: "/repo/src/renderer/styles.css" }) },
    { kind: "tool", text: "Grep", detail: JSON.stringify({ pattern: "work-row", path: "src/renderer" }) },
  );
  const view = await mount(timelineView(messages, "running"));

  const run = view.container.querySelector(".work-run");
  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-tool")].map((step) => step.textContent), ["Read", "Grep"]);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-arg")].map((step) => step.textContent), ["…/renderer/styles.css", "work-row in src/renderer"]);
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
  const run = view.container.querySelector(".work-run");
  assert.equal(run.querySelector(".work-arg").textContent, "Grep");
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
  const run = settledView.container.querySelector(".work-run");
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
  /** The turn's own elapsed: the outermost fold's, whichever fold a running or settled turn draws. */
  const elapsed = () => view.container.querySelector(".work-time").textContent;

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
  /** The turn's own elapsed: the outermost fold's, whichever fold a running or settled turn draws. */
  const elapsed = () => view.container.querySelector(".work-time").textContent;

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
    loadTaskStore: async () => ({ version: 2, projects: [project], worktrees: [], tasks: [task("task-1"), task("task-2"), task("task-3")], lastFolder: project.root }),
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

test("the sidebar lists a project's threads as one list, and its menu starts another in a checkout", async () => {
  const thread = (id, overrides = {}) => ({
    id, title: id, projectId: "project-1", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1, ...overrides,
  });
  const worktree = { id: "wt1", projectId: "project-1", root: "/worktrees/project-wt1", workspaceId: "ws-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 };
  const started = [];
  const view = await mount(React.createElement(ProjectSidebar, {
    compactOpen: false,
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedTasks: [thread("in-checkout", { worktreeId: "wt1" }), thread("in-project")],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(),
    worktreeGroups: [{ worktree, tasks: [thread("in-checkout", { worktreeId: "wt1" })] }],
    worktreeTaskIds: new Set(["in-checkout"]),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: "project:project-1",
    settingsOpen: false,
    onNewTask(projectId, worktreeId) { started.push([projectId, worktreeId]); },
    onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onDismissTask() {}, onDismissAll() {}, onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  assert.deepEqual(
    [...view.container.querySelectorAll(".project-tasks [data-rfd-draggable-id]")].map((row) => row.getAttribute("data-rfd-draggable-id")),
    ["in-checkout", "in-project"],
    "a checkout opens no list of its own, so the project holds every thread in one order",
  );
  const marked = view.container.querySelector('[data-rfd-draggable-id="in-checkout"] .task-worktree');
  assert.equal(marked.getAttribute("aria-label"), "Works in project-wt1", "the row's own mark says which checkout it works in");

  const item = [...view.container.querySelectorAll(".project-menu [role=menuitem]")].find((button) => button.textContent === "New thread in project-wt1");
  await act(async () => { item.click(); });
  assert.deepEqual(started, [["project-1", "wt1"]], "the project's menu is where a checkout it already has is started in");
  await view.unmount();
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
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(["scheduled-task", "scheduled-chat"]),
    worktreeGroups: [],
    worktreeTaskIds: new Set(["plain-task"]),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onDismissTask() {}, onDismissAll() {}, onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
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
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(),
    worktreeGroups: [],
    worktreeTaskIds: new Set(),
    activityTasks: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu,
    settingsOpen: false,
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {},
    onRemoveProject: (id) => { removed.push(id); },
    onSetMode() {}, onSetSectionOpen() {},
    onSetOpenMenu: (menu) => { opened.push(menu); },
    onSelectTask() {}, onArchiveTask() {}, onDismissTask() {}, onDismissAll() {}, onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
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

test("a folder is lifted by its own row, and lifting one leaves every folded folder folded", async () => {
  const moves = [];
  const projects = [{ id: "first-project", root: "/first", sortIndex: 0 }, { id: "second-project", root: "/second", sortIndex: 1 }];
  const view = await mount(React.createElement(ProjectSidebar, {
    compactOpen: false,
    inactive: false,
    projects,
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(),
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

  const handle = view.container.querySelector('[data-rfd-drag-handle-draggable-id="second-project"]');
  assert.ok(handle, "a folder is draggable");
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
  const task = (id, projectId) => ({
    id, title: id, ...(projectId ? { projectId } : {}), executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const projects = [{ id: "open-project", root: "/open" }, { id: "shut-project", root: "/shut" }];
  const tasks = [task("open-task", "open-project"), task("shut-task", "shut-project")];
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
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(),
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

  const handle = view.container.querySelector('[data-rfd-drag-handle-draggable-id="open-task"]');
  assert.ok(handle, "the open folder's task is draggable");
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

function streaming(props) {
  return React.createElement(StreamingText, { streaming: true, ...props });
}

test("streamed text shows everything that has arrived, with its newest words fading in", async () => {
  const tail = "Checking the reducer before anything else.";
  const view = await mount(streaming({ committed: "", tail }));

  assert.equal(view.container.textContent, tail, "text is never held back behind a paced reveal");
  assert.ok(view.container.querySelector(".stream-word"), "the live block's words are split so each can fade in");
  await view.unmount();
});

test("a finished message renders whole, so returning to a thread does not replay it", async () => {
  const settled = React.createElement(StreamingText, { committed: "The reducer owns every write.\n\n" });
  const view = await mount(settled);

  assert.match(view.container.textContent, /The reducer owns every write\./);
  assert.equal(view.container.querySelector(".stream-word"), null, "finished text is parsed rather than animated in");
  await view.unmount();
});

test("a revealed word keeps its node, so only new words animate in", async () => {
  const view = await mount(streaming({ committed: "", tail: "One two" }));
  const before = [...view.container.querySelectorAll(".stream-word")].map((node) => node.textContent);
  const firstNode = view.container.querySelector(".stream-word");

  await view.render(streaming({ committed: "", tail: "One two three" }));
  const after = [...view.container.querySelectorAll(".stream-word")].map((node) => node.textContent);

  assert.deepEqual(before, ["One ", "two"]);
  assert.deepEqual(after, ["One ", "two ", "three"]);
  assert.equal(view.container.querySelector(".stream-word"), firstNode, "an already-revealed word is not re-created");
  await view.unmount();
});

test("half-written markup is held back rather than shown as literal markers", async () => {
  const view = await mount(streaming({ committed: "## Heading\n\n", tail: "Then a **partly" }));

  assert.equal(view.container.querySelector("h2").textContent, "Heading");
  assert.equal(view.container.textContent, "HeadingThen a", "the unclosed emphasis run waits instead of showing its markers");
  assert.equal(view.container.querySelector("strong"), null);

  await view.render(streaming({ committed: "## Heading\n\nThen a **partly** written line.\n\n", tail: "" }));
  assert.equal(view.container.querySelector("strong").textContent, "partly");
  await view.unmount();
});

test("a streamed code fence renders as a code block instead of literal backticks", async () => {
  const view = await mount(streaming({ committed: "", tail: "```ts\nconst reducer = 1;\n" }));

  assert.equal(view.container.querySelector("pre code").textContent.trim(), "const reducer = 1;");
  assert.doesNotMatch(view.container.textContent, /```/, "the opening fence is never shown as text");
  await view.unmount();
});

test("a table waits for its delimiter row instead of showing pipes", async () => {
  const view = await mount(streaming({ committed: "", tail: "| Channel | Reach |\n" }));
  assert.equal(view.container.textContent, "", "a header row alone would render as literal pipes");

  await view.render(streaming({ committed: "", tail: "| Channel | Reach |\n| --- | --- |\n| side | tools |\n" }));
  assert.equal(view.container.querySelector("table th").textContent, "Channel");
  assert.doesNotMatch(view.container.textContent, /\|/);
  await view.unmount();
});

test("text committing into a block does not rewind or repeat the reveal", async () => {
  const view = await mount(streaming({ committed: "", tail: "A whole paragraph of text." }));
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

test("a live turn streams its newest text and leaves settled turns alone", async () => {
  const messages = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "First block.\n\n" });
  const view = await mount(timelineView(messages, "running", { messageId: "m1", text: "Second block still" }));

  assert.equal(view.container.querySelector(".work-note p").textContent, "First block.");
  assert.match(view.container.textContent, /Second block still/);
  await view.unmount();
});

test("a block committing between tails does not replay the text already read", async () => {
  const streamed = transcript({ kind: "user", text: "Explain this" });
  const view = await mount(timelineView(streamed, "running", { messageId: "reply-1", text: "The reducer owns every write." }));
  assert.match(view.container.textContent, /The reducer owns every write\./);

  /** The delta clears the tail before the next one arrives, which is where a remount would rewind. */
  const committed = [...streamed, { id: "reply-1", at: 2000, kind: "assistant", text: "The reducer owns every write.\n\n" }];
  await view.render(timelineView(committed, "running", null));
  assert.match(view.container.textContent, /The reducer owns every write\./);

  await view.render(timelineView(committed, "running", { messageId: "reply-1", text: "Then the" }));
  assert.match(view.container.textContent, /The reducer owns every write\./, "the committed block stays put while the next tail streams on");
  await view.unmount();
});

test("re-opening a running thread shows the text it already streamed, not a replay of it", async () => {
  const messages = transcript({ kind: "user", text: "Explain this" }, { kind: "assistant", text: "A whole block already read.\n\n" });
  const tail = { messageId: "m1", text: "and the line still being written" };
  const first = await mount(timelineView(messages, "running", tail));
  await first.unmount();

  /** Leaving the thread and coming back is a fresh mount, which is where the reveal used to restart. */
  const reopened = await mount(timelineView(messages, "running", tail));
  assert.match(reopened.container.textContent, /A whole block already read\./);
  assert.match(reopened.container.textContent, /and the line still being written/);
  await reopened.unmount();
});

test("a tail renders before the task has a message of its own to attach to", async () => {
  const view = await mount(timelineView([], "running", { messageId: "reply-1", text: "Starting on it" }));

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
  let offset = 0;
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => offset, set: (next) => { offset = next; } });
  document.body.append(scroller);
  const sentTo = [];
  scroller.scrollTo = ({ top }) => { sentTo.push(top); offset = top; };
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
  await harness.resize();
  assert.equal(harness.sentTo.at(-1), harness.bottom, "an idle transcript opens at its foot");
  assert.equal(view.container.querySelector(".scroll-to-end"), null, "hidden while the end is in view");

  /** The reader drags the scrollbar well away from the end. */
  await act(async () => {
    harness.scroller.scrollTop = 600;
    harness.scroller.dispatchEvent(new Event("scroll"));
  });
  const button = view.container.querySelector(".scroll-to-end");
  assert.ok(button, "offered once the end is out of view");

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

  await view.render(panel({ kind: "creating" }, "session:location"));
  assert.match(view.container.querySelector(".session-location-row span:nth-of-type(2)").textContent, /Creating worktree/);
  assert.equal(view.container.querySelector('[role="menuitem"]').disabled, true, "a checkout being made cannot be asked for twice");
  await view.unmount();
});

test("a thread waiting on its checkout says so in the transcript, and its composer holds", async () => {
  window.desktop = fakeDesktop();
  const messages = transcript({ kind: "user", text: "Refactor the loader" });

  const view = await mount(timelineView(messages, "idle"));
  assert.equal(view.container.querySelector(".waiting-row"), null, "an idle thread is not waiting on anything");

  await view.render(timelineView(messages, "idle", undefined, undefined, undefined, "worktree"));
  const waiting = view.container.querySelector(".waiting-row");
  assert.match(waiting.textContent, /Creating worktree/);
  assert.equal(waiting.getAttribute("role"), "status", "the wait is announced rather than only drawn");

  await view.render(timelineView(messages, "idle", undefined, undefined, undefined, "run"));
  assert.match(view.container.querySelector(".waiting-row").textContent, /Starting/);
  await view.unmount();
});

test("the send button holds while the checkout a send needs is still being made", async () => {
  window.desktop = fakeDesktop();
  const sent = [];
  const composer = (waiting) => React.createElement(TaskComposer, {
    prompt: "Refactor the loader", folder: "/project", workspaceId: "workspace-1", mode: "confirm", model: "opus", effort: "medium",
    runActive: false, waiting, queuedMessages: [],
    onPromptChange() {}, onModeChange() {}, onModelChange() {}, onEffortChange() {}, onSteerQueued() {}, onDropQueued() {},
    onSend: () => { sent.push("sent"); }, onCancel() {},
  });

  const view = await mount(composer(true));
  const send = view.container.querySelector(".send-button");
  assert.equal(send.disabled, true, "a second Enter is refused visibly rather than swallowed");
  await act(async () => { send.click(); });
  assert.deepEqual(sent, []);

  await view.render(composer(false));
  await act(async () => { view.container.querySelector(".send-button").click(); });
  assert.deepEqual(sent, ["sent"], "the button works again once the checkout has landed");
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

test("the session panel names the pull request the checkout belongs to, and only when there is one", async () => {
  window.desktop = fakeDesktop();
  const opened = [];
  const panel = (pullRequest) => React.createElement(MessageLinkProvider, {
    actions: { openUrlInApp: (url) => { opened.push(url); } },
  }, React.createElement(SessionPanel, {
    environment: { status: "available", files: [], branch: "pr-chip", additions: 0, deletions: 0 },
    hasProject: true,
    workspaceId: pullRequest ? "workspace-with-pr" : "workspace-without-pr",
    location: { kind: "local" },
    runActive: false,
    openMenu: null,
    subagents: [],
    backgroundProcesses: [], workflows: [],
    automationCount: 0,
    onSelect() {},
    onOpenAutomations() {},
    onSetOpenMenu() {},
    onSetWorktree() {},
    onCheckoutBranch() {},
  }));

  const view = await mount(panel(null));
  assert.equal(view.container.querySelector(".session-pull-request"), null, "no pull request is no row at all");

  window.desktop.pullRequest = async () => ({ number: 12, title: "Name the two families", url: "https://github.com/o/r/pull/12", state: "merged" });
  await view.render(panel(true));
  const row = view.container.querySelector(".session-pull-request");
  assert.match(row.textContent, /#12/, "the row says which pull request the work belongs to");
  assert.match(row.getAttribute("title"), /Name the two families/);
  assert.equal(row.querySelector(".session-row-icon").dataset.state, "merged", "the icon carries the state");
  assert.equal(row.getAttribute("href"), "https://github.com/o/r/pull/12");
  assert.equal(row.getAttribute("target"), "_blank", "a click leaves Claudex the way any other link does");

  await act(async () => { row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
  await act(async () => { [...document.querySelectorAll(".context-menu-popover button")].find((item) => /Open in Claudex/.test(item.textContent)).click(); });
  assert.deepEqual(opened, ["https://github.com/o/r/pull/12"], "its context menu offers the browser panel instead");
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
  const worktreeToggle = view.container.querySelector(".thread-start-toggle");
  assert.equal(worktreeToggle.textContent, "Worktree");
  assert.equal(worktreeToggle.getAttribute("aria-pressed"), "false", "a worktree is only ever asked for");
  assert.equal(view.container.querySelector(".thread-mode"), null, "the mode is asked for above these, not among them");

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
  const branchTrigger = view.container.querySelector('button[aria-label="Starting branch"]');
  assert.match(branchTrigger.textContent, /fix-loader/);
  await act(async () => { view.container.querySelector(".thread-start-toggle").click(); });
  assert.deepEqual(chosen.worktree, [true]);

  await act(async () => { branchTrigger.click(); });
  const branchSearch = view.container.querySelector('input[aria-label="Search branches"]');
  assert.equal(document.activeElement, branchSearch, "the branch search takes focus when it opens");
  await act(async () => { branchSearch.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.container.querySelector(".branch-menu"), null, "Escape closes the branch list");
  assert.equal(document.activeElement, branchTrigger, "closing the list returns focus to its trigger");

  await act(async () => { branchTrigger.click(); });
  await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(view.container.querySelector(".branch-menu"), null, "one outside pointer press closes the branch list");
  assert.equal(document.activeElement, branchTrigger);
  await view.unmount();
});

test("the mode is chat or work, and a chat is left with nothing else to answer", async () => {
  const { ThreadModeSwitch, ThreadStartOptions } = await vite.ssrLoadModule("/src/renderer/components/ThreadStartOptions.tsx");
  window.desktop = fakeDesktop();
  const chosen = [];
  const projects = [{ id: "project-a", root: "/repo/claudex" }, { id: "project-b", root: "/repo/just-speak" }];
  const view = await mount(React.createElement(ThreadModeSwitch, { projects, projectId: "project-a", onSelectProject: (id) => { chosen.push(id); } }));

  const modes = () => [...view.container.querySelectorAll('[role="radio"]')];
  assert.deepEqual(modes().map((mode) => [mode.textContent, mode.getAttribute("aria-checked")]), [["Chat", "false"], ["Work", "true"]], "a thread in a project is work");
  await act(async () => { modes()[1].click(); });
  assert.deepEqual(chosen, [], "the mode it is already in asks for nothing");
  await act(async () => { modes()[0].click(); });
  assert.deepEqual(chosen, [undefined], "turning to chat leaves the project behind");
  chosen.length = 0;

  await view.render(React.createElement(ThreadModeSwitch, { projects, projectId: null, onSelectProject: (id) => { chosen.push(id); } }));
  assert.deepEqual(modes().map((mode) => mode.getAttribute("aria-checked")), ["true", "false"], "a thread with no project is a chat");
  await act(async () => { modes()[1].click(); });
  assert.deepEqual(chosen, ["project-a"], "turning to work starts the thread in the first project");

  await view.render(React.createElement(ThreadModeSwitch, { projects: [], projectId: null, onSelectProject() {} }));
  assert.equal(view.container.querySelector(".thread-mode"), null, "with nowhere to work there is no mode to choose");

  await view.render(React.createElement(ThreadStartOptions, {
    projects,
    projectId: null,
    branch: null,
    worktree: false,
    onSelectProject() {},
    onSelectBranch() {},
    onSetWorktree() {},
  }));
  assert.equal(view.container.querySelector(".thread-start"), null, "a chat has no project, branch, or checkout to answer for");
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
  assert.deepEqual(failed, {
    type: "run.unresolved",
    pendingId: "pending-2",
    message: "Could not check out feature-x: Your local changes would be overwritten.",
  }, "Git says what went wrong, and the message says what was being attempted");
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

test("a folder lifts from a press on its name, which is a button", async () => {
  const moves = [];
  const folded = [];
  const projects = [{ id: "first-project", root: "/first", sortIndex: 0 }, { id: "second-project", root: "/second", sortIndex: 1 }];
  const view = await mount(React.createElement(ProjectSidebar, {
    compactOpen: false,
    inactive: false,
    projects,
    orderedTasks: [],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    automatedTaskIds: new Set(),
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

  const name = view.container.querySelectorAll(".project-main")[1];
  const mouse = (type, target, y) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: y }));
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

const REVIEW_PATCH = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const first = 1;",
  "-const second = 2;",
  "+const second = 22;",
  "+const third = 3;",
  "",
].join("\n");

function seedReviewableProject() {
  localStorage.clear();
  localStorage.setItem("claudex.store.v2", JSON.stringify({
    tasks: JSON.stringify({ version: 2, value: [{
      id: "review-task",
      title: "Review",
      executionPolicy: "confirm",
      messages: [],
      continuationStatus: "none",
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      projectId: "project-1",
      updatedAt: 2,
    }] }),
    projects: JSON.stringify({ version: 2, value: [{ id: "project-1", root: "/project", workspaceId: "workspace-1" }] }),
    lastFolder: JSON.stringify({ version: 2, value: "/project" }),
  }));
}

/** Opens the review from the session panel and lets its patches land. */
async function openReview(view) {
  await act(async () => { view.container.querySelector('button[aria-label="Show session summary"]').click(); });
  await act(async () => { view.container.querySelector('button[aria-label="Review changes"]').click(); });
  /** Patches are read a file at a time, so the list arrives a turn before the lines in it do. */
  await act(async () => {});
}

/** A review opens side by side, so the one-column view is what a test has to ask for. */
async function showOneColumn(view) {
  await act(async () => { view.container.querySelector('button[aria-label="Show one column"]').click(); });
}

/** Opens the session panel, which is where the Changes row that reaches the review lives. */
async function showSession(view) {
  await act(async () => { view.container.querySelector('button[aria-label="Show session summary"]').click(); });
}

/** A desktop whose comparison holds one changed file with a patch to draw. */
function reviewableDesktop() {
  return fakeDesktop({
    diffSummary: async (workspaceId, range) => ({
      status: "available",
      range,
      files: [{ path: "src/app.ts", status: "modified", additions: 2, deletions: 1, binary: false }],
      additions: 2,
      deletions: 1,
    }),
    diffPatch: async () => ({ status: "available", patch: REVIEW_PATCH }),
  });
}

test("the session panel's Changes row opens the review, and the same click closes it", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await showSession(view);

  const tabs = () => [...view.container.querySelectorAll('.right-dock-tab [role="tab"]')].map((tab) => tab.textContent);
  await act(async () => { view.container.querySelector('button[aria-label="Review changes"]').click(); });

  assert.deepEqual(tabs(), ["Changes1"], "the review opens as the dock's tab, counting the file still to read");
  assert.equal(view.container.querySelector(".diff-file-name").textContent, "src/app.ts");
  assert.match(view.container.querySelector(".diff-progress").textContent, /0 of 1 viewed/);

  /** The dock takes the session panel's place, so the row that opened the review is closed from the tab. */
  await act(async () => { view.container.querySelector('.right-dock-tab.active button[aria-label="Close Changes"]').click(); });
  assert.deepEqual(tabs(), [], "closing the tab puts the review away");
  await showSession(view);
  assert.ok(view.container.querySelector('button[aria-label="Review changes"]'), "the row is back to open it again");
  await view.unmount();
});

test("a file is drawn expanded, with both sides' line numbers, without being opened first", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  await showOneColumn(view);

  const lines = [...view.container.querySelectorAll(".diff-line")];
  assert.equal(lines[0].className, "diff-line hunk", "the patch is already on screen");
  assert.deepEqual(
    lines.slice(1).map((line) => [...line.querySelectorAll(".diff-gutter span")].map((cell) => cell.textContent)),
    [["1", "1"], ["2", ""], ["", "2"], ["", "3"]],
  );
  assert.deepEqual(lines.slice(1).map((line) => line.className.replace("diff-line ", "")), ["context", "delete", "add", "add"]);

  await act(async () => { view.container.querySelector(".diff-file-open").click(); });
  assert.equal(view.container.querySelectorAll(".diff-line").length, 0, "the header folds it away");
  await view.unmount();
});

test("a file's lines are coloured by the grammar its extension names", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  await showOneColumn(view);

  const coloured = [...view.container.querySelectorAll(".diff-line code span")];
  assert.ok(coloured.length > 0, "the grammar produced tokens");
  assert.ok(coloured.every((token) => token.style.color.startsWith("var(--syntax")|| token.style.color.startsWith("var(--code")), "every colour comes from a token");
  assert.ok(coloured.some((token) => token.textContent === "const" && token.style.color === "var(--syntax-keyword)"));
  await view.unmount();
});

test("a range picked in the gutter becomes a composer pill naming the file and its lines", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  await showOneColumn(view);

  const gutters = [...view.container.querySelectorAll(".diff-gutter")];
  await act(async () => { gutters[2].click(); });
  await act(async () => { gutters[3].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })); });

  assert.equal(view.container.querySelectorAll(".diff-line.selected").length, 2, "shift extends the selection");
  assert.match(view.container.querySelector(".diff-comment-range").textContent, /^src\/app\.ts:L2-L3$/);

  /** The note is written among the lines it is about, not docked away below the whole review. */
  const drawn = [...view.container.querySelectorAll(".diff-files .diff-line, .diff-files .diff-comment")];
  const composer = drawn.findIndex((node) => node.classList.contains("diff-comment"));
  assert.ok(composer > 0, "the composer is drawn with the rows, inside the scroller");
  assert.ok(drawn[composer - 1].classList.contains("selected"), "it follows the last selected line");

  const note = view.container.querySelector('.diff-comment textarea');
  await act(async () => {
    note.value = "Name these properly";
    note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { view.container.querySelector('button[aria-label="Comment on the selected lines"]').click(); });

  const pill = view.container.querySelector(".annotation-pill");
  assert.ok(pill, "the note lands in the composer as a pill");
  assert.match(pill.getAttribute("title"), /src\/app\.ts:L2-L3/);
  assert.match(pill.getAttribute("title"), /\+const second = 22;/);
  assert.match(pill.getAttribute("title"), /— Name these properly/);
  assert.equal(view.container.querySelector(".diff-comment"), null, "commenting clears the selection");
  await view.unmount();
});

test("ticking a file off folds its patch away and empties the tab's count", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  assert.ok(view.container.querySelectorAll(".diff-line").length > 0, "the patch is open");

  await act(async () => { view.container.querySelector('input[aria-label="Mark src/app.ts viewed"]').click(); });

  assert.equal(view.container.querySelectorAll(".diff-line").length, 0);
  assert.match(view.container.querySelector(".diff-progress").textContent, /1 of 1 viewed/);
  assert.deepEqual([...view.container.querySelectorAll('.right-dock-tab [role="tab"]')].map((tab) => tab.textContent), ["Changes"]);
  await view.unmount();
});

test("the two-column view colours its lines the way the one-column view does", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);

  assert.ok(view.container.querySelector(".diff-split-row"), "a review opens in two columns");
  const coloured = [...view.container.querySelectorAll(".diff-split-cell code span")];
  assert.ok(coloured.some((token) => token.textContent === "const" && token.style.color === "var(--syntax-keyword)"));
  await view.unmount();
});

test("a comment can be taken from either column of the two-column view", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);

  const gutters = [...view.container.querySelectorAll(".diff-split-cell .diff-gutter")];
  /** Each side says what happened to its line, so the two columns never announce the same thing. */
  assert.deepEqual(gutters.map((gutter) => gutter.getAttribute("aria-label")), [
    "Unchanged line 1",
    "Unchanged line 1",
    "Removed line 2",
    "Added line 2",
    "Added line 3",
  ]);
  await act(async () => { gutters.find((gutter) => gutter.getAttribute("aria-label") === "Added line 3").click(); });

  assert.match(view.container.querySelector(".diff-comment-range").textContent, /^src\/app\.ts:L3$/);
  await view.unmount();
});

test("the two sides are picked apart, and remote branches are offered to compare against", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);

  const sides = () => [...view.container.querySelectorAll(".diff-side-trigger code")].map((code) => code.textContent);
  assert.deepEqual(sides(), ["HEAD", "Working tree"], "uncommitted work reads as HEAD against disk");

  /** The trigger names the side and what it is set to, so a screen reader hears the comparison. */
  assert.equal(view.container.querySelector('.diff-side button').getAttribute("aria-label"), "Base: HEAD");
  await act(async () => { view.container.querySelector('button[aria-label^="Base"]').click(); });
  const options = [...document.querySelectorAll('.branch-menu [role="option"]')].map((option) => option.textContent);
  assert.equal(options[0], "HEAD", "the side that is not a branch comes first, inside the list");
  assert.ok(options.includes("origin/main"), "a remote branch can be a base");

  await act(async () => { [...document.querySelectorAll('.branch-menu [role="option"]')].find((option) => option.textContent === "origin/main").click(); });
  assert.deepEqual(sides(), ["origin/main", "Working tree"]);
  await view.unmount();
});
