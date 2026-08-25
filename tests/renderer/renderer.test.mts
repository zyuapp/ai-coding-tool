import assert from "node:assert/strict";
import { test, afterAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import { settleUntil } from "../support/settle.mts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { CliStatus } from "../../src/domain/cli.ts";
import type { PlanUsage } from "../../src/domain/plan-usage.ts";
import type { BackgroundProcess, ExecutionPolicy, Subagent, SubagentActivity } from "../../src/domain/run.ts";
import type { PastedText, RunAttachment, Task } from "../../src/domain/task.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import type { MessageLinkActions } from "../../src/renderer/components/MarkdownMessage.tsx";
import type { ProjectSidebarProps } from "../../src/renderer/components/ProjectSidebar.tsx";
import type { SessionPanelProps } from "../../src/renderer/components/SessionPanel.tsx";
import type { SettingsPanelProps } from "../../src/renderer/components/SettingsPanel.tsx";
import type { TaskComposerProps } from "../../src/renderer/components/TaskComposer.tsx";
import { mobileDesktopStub, mobileSettingsProps } from "../support/mobile-desktop.mts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "localStorage", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver", "Image", "navigator", "File", "Blob", "FileReader", "DOMParser", "innerWidth", "innerHeight"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
/** jsdom has no animation frames. Everything queued for one runs together, on a single timestamp. */
let animationTime = 0;
let frameId = 0;
let drain: ReturnType<typeof setTimeout> | null = null;
const queuedFrames = new Map<number, FrameRequestCallback>();
function runFrame() {
  if (drain !== null) clearTimeout(drain);
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
const animationFunctions = {
  requestAnimationFrame: (fn: FrameRequestCallback) => { const id = (frameId += 1); queuedFrames.set(id, fn); scheduleFrame(); return id; },
  cancelAnimationFrame: (id: number) => queuedFrames.delete(id),
};
for (const name of Object.keys(animationFunctions) as Array<keyof typeof animationFunctions>) {
  const value = animationFunctions[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(dom.window, name, { configurable: true, value });
}
/** jsdom has no ResizeObserver, and the transcript's scrolling is driven by one. */
class ResizeObserverStub implements ResizeObserver {
  static live: ResizeObserverStub[] = [];
  constructor(readonly callback: ResizeObserverCallback) { ResizeObserverStub.live.push(this); }
  observe(_target: Element, _options?: ResizeObserverOptions) {}
  unobserve(_target: Element) {}
  disconnect() { ResizeObserverStub.live = ResizeObserverStub.live.filter((observer) => observer !== this); }
}
for (const target of [globalThis, dom.window]) {
  Object.defineProperty(target, "ResizeObserver", { configurable: true, value: ResizeObserverStub });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
/** React watches the focused field through the event methods only IE ever had, which jsdom has not. */
for (const prototype of [dom.window.HTMLInputElement.prototype, dom.window.HTMLTextAreaElement.prototype]) {
  Object.defineProperty(prototype, "attachEvent", { configurable: true, value: () => {} });
  Object.defineProperty(prototype, "detachEvent", { configurable: true, value: () => {} });
}
/**
 * jsdom lays nothing out and hit tests nothing, so a test places the rectangles it cares about and
 * the document answers from them. The last one placed is the one on top.
 */
type TestBox = { x: number; y: number; width: number; height: number };
const placed: Array<{ selector: string; box: TestBox }> = [];
function place(selector: string, box: TestBox) {
  placed.push({ selector, box });
  const element = document.querySelector(selector);
  if (element) element.getBoundingClientRect = () => ({
    ...box,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    left: box.x,
    toJSON: () => box,
  });
  return box;
}
dom.window.document.elementFromPoint = (x, y) => {
  const hit = [...placed].reverse().find(({ selector, box }) => document.querySelector(selector)
    && x >= box.x && y >= box.y && x <= box.x + box.width && y <= box.y + box.height);
  return hit ? document.querySelector(hit.selector) : null;
};
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", { configurable: true, writable: true, value: () => {} });
Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: () => {} });
Object.defineProperty(dom.window.Element.prototype, "getAnimations", { configurable: true, value: () => [] });

const { SessionPanel } = await import("../../src/renderer/components/SessionPanel.tsx");
const { SubagentInspector } = await import("../../src/renderer/components/SubagentInspector.tsx");
const { AgentsPanel, matchSubagents } = await import("../../src/renderer/components/SubagentList.tsx");
const { WorkspaceHeader } = await import("../../src/renderer/components/WorkspaceHeader.tsx");
const { OpenInMenu } = await import("../../src/renderer/components/OpenInMenu.tsx");
const { MarkdownMessage, MessageLinkProvider } = await import("../../src/renderer/components/MarkdownMessage.tsx");
const { DiagramViewer, naturalDiagram } = await import("../../src/renderer/components/MermaidBlock.tsx");
const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await import("../../src/renderer/App.tsx");
const { TaskComposer } = await import("../../src/renderer/components/TaskComposer.tsx");
const { ImageAnnotator, badgeRadius, drawAnnotations, placeBadges } = await import("../../src/renderer/components/ImageAnnotator.tsx");
const { SettingsPanel } = await import("../../src/renderer/components/SettingsPanel.tsx");
const { ConversationTimeline, groupTimeline, READING_SETTLE_MS } = await import("../../src/renderer/components/ConversationTimeline.tsx");
const { StreamingText } = await import("../../src/renderer/components/StreamingText.tsx");
const { AutomationPanel, automationStatusLabel, formatCountdown } = await import("../../src/renderer/components/AutomationPanel.tsx");
const { ProjectSidebar } = await import("../../src/renderer/components/ProjectSidebar.tsx");
const { SideChat } = await import("../../src/renderer/components/SideChat.tsx");
const { WorkflowPanel } = await import("../../src/renderer/components/WorkflowPanel.tsx");

afterAll(async () => {
  dom.window.close();
});

async function mount(element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    async render(next: React.ReactNode) { await act(async () => { root.render(next); }); },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

function item<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined);
  return value;
}

function query<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const element = root.querySelector<E>(selector);
  assert.ok(element, `Expected ${selector}`);
  return element;
}

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

function renderSessionPanel(overrides: Partial<SessionPanelProps>) {
  return React.createElement(SessionPanel, {
    environment: null,
    hasProject: false,
    runActive: false,
    openMenu: null,
    subagents: [],
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
    onSetWorktree() {},
    onCheckoutBranch() {},
    ...overrides,
  });
}

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

test("assistant markdown renders GFM without executing raw HTML", async () => {
  const view = await mount(React.createElement(MarkdownMessage, null, "## Heading\n\n**Bold**\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] Done\n\n<script>bad()</script>"));

  assert.equal(view.container.querySelector("h2")?.textContent, "Heading");
  assert.equal(view.container.querySelector("strong")?.textContent, "Bold");
  assert.equal(view.container.querySelector("table td")?.textContent, "1");
  assert.equal(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, true);
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
  const zoom = (label: string) => query<HTMLButtonElement>(document, `.viewer-zoom button[aria-label="${label}"]`);
  const readout = () => query(document, ".viewer-zoom span").textContent;
  const drawn = () => query<HTMLElement>(document, ".viewer-stage .mermaid-svg").style.getPropertyValue("--diagram-width");

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
  const closed: string[] = [];
  const diagram = { markup: '<svg viewBox="0 0 400 200"></svg>', width: 400, height: 200 };
  const view = await mount(React.createElement(DiagramViewer, { diagram, onClose: () => closed.push("closed") }));
  const backdrop = query(document, ".viewer.diagram");
  const drawing = query(document, ".viewer-stage .mermaid-svg");
  const press = (target: Element) => target.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
  const release = (target: Element) => target.dispatchEvent(new MouseEvent("click", { bubbles: true }));

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

function mountMessage(markdown: string, actions: MessageLinkActions = {}) {
  return mount(React.createElement(MessageLinkProvider, { actions, children: React.createElement(MarkdownMessage, null, markdown) }));
}

test("a thread link opens that thread in place, and nothing else under the scheme is a link", async () => {
  const selected: string[] = [];
  const markdown = [
    "See [the sidebar work](aicodingtool://thread/task-9) for how it went.",
    "",
    "Not [an archive](aicodingtool://archive/task-9) and not [the docs](https://example.com).",
  ].join("\n");
  const view = await mountMessage(markdown, { selectTask: (taskId) => selected.push(taskId) });

  const links = [...view.container.querySelectorAll("a")];
  assert.deepEqual(links.map((link) => link.textContent), ["the sidebar work", "the docs"], "an unknown aicodingtool:// path stays plain text");
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
  const view = await mountMessage("See [the sidebar work](aicodingtool://thread/task-9).");

  assert.equal(view.container.querySelector("a"), null);
  assert.match(view.container.textContent, /See the sidebar work\./);
  await view.unmount();
});

test("only Markdown file links open a file, at the line they name", async () => {
  const opened: Array<[string, number | null]> = [];
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
  const opened: string[] = [];
  const view = await mountMessage("Read https://example.com/docs for the rest.", { openUrlInApp: (url) => opened.push(url) });

  const link = query<HTMLAnchorElement>(view.container, "a");
  assert.equal(link.target, "_blank", "the main process hands an ordinary click to the default browser");
  await act(async () => { link.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 60 })); });
  const menuItem = query<HTMLButtonElement>(document, ".context-menu-popover button");
  assert.equal(menuItem.textContent, "Open in AI Coding Tool");
  await act(async () => { menuItem.click(); });
  assert.deepEqual(opened, ["https://example.com/docs"]);
  await view.unmount();
});

const subagents: Subagent[] = [
  { id: "working", description: "Working agent", status: "working", lastToolName: "Read", totalTokens: 321, startedAt: 1, activity: [] },
  { id: "complete", description: "Complete agent", status: "completed", summary: "Done", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "failed", description: "Failed agent", status: "failed", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "stopped", description: "Stopped agent", status: "stopped", startedAt: 1, finishedAt: 2, activity: [] },
];

test("session panel renders Git and subagent states and selects an agent", async () => {
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
    [null, "Reopen the project to inspect Git"],
    [{ status: "unknown", workspaceId: "gone" }, "Workspace is no longer registered"],
    [{ status: "unavailable", reason: "missing" }, "Workspace is missing"],
    [{ status: "error", message: "git failed" }, "git failed"],
  ];
  for (const [environment, message] of environments) {
    await view.render(renderSessionPanel({ environment, hasProject: true, subagents: [], backgroundProcesses: [], workflows: [], automationCount: 0, onSelect() {}, onOpenAutomations() {} }));
    assert.match(view.container.textContent, new RegExp(message));
  }
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
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() { return this.classList?.contains("subagent-row") ? 51 : 0; },
  });
  const view = await mount(React.createElement(AgentsPanel, { subagents: many, onSelect() {} }));
  const list = query(view.container, ".agents-panel-list");
  Object.defineProperty(list, "offsetWidth", { value: 360 });
  Object.defineProperty(list, "offsetHeight", { value: 720 });
  await act(async () => { for (const observer of [...ResizeObserverStub.live]) observer.callback([], observer); });

  const rows = view.container.querySelectorAll(".subagent-row").length;
  assert.ok(rows > 0 && rows < 80, `a windowed list should draw a screenful, drew ${rows}`);
  assert.match(query(view.container, ".subagent-group").textContent ?? "", /Failed/);
  assert.match(view.container.textContent, /Agent 700/);

  await act(async () => { query<HTMLButtonElement>(view.container, '.agent-status-strip button.failed').click(); });
  assert.deepEqual(
    [...view.container.querySelectorAll(".subagent-list strong")].map((node) => node.textContent),
    ["Agent 700"],
  );

  Reflect.deleteProperty(window.HTMLElement.prototype, "offsetHeight");
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
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose: () => { closed = true; } }));

  assert.match(view.container.textContent, /Renderer inspected/);
  assert.match(view.container.textContent, /321 tokens/);
  assert.match(view.container.textContent, /Reading/);
  assert.equal(query(view.container, "details summary").textContent, "Read");
  const earlier = query<HTMLButtonElement>(view.container, ".agent-activity-earlier"); assert.equal(earlier.textContent, "Load earlier (1)");
  await act(async () => { earlier.click(); });
  assert.equal(view.container.querySelector(".agent-activity-earlier"), null);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Close subagent details"]').click(); });
  assert.equal(closed, true);
  await view.unmount();
});

test("a side chat opened from the right panel sends on the side channel and stops on request", async () => {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
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

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add button')].find((button) => button.textContent.includes("Side chat"))).click(); });

  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Side chat prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  await act(async () => {
    item(setValue).call(textarea, "What does this code do?");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "What does this code do?" }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Send side chat message"]').click(); });

  const start = startCommand(desktop.sent[0]);
  assert.equal(start.channel, "side");
  assert.equal(start.forkContinuation, true);
  assert.deepEqual(start.continuation, { provider: "claude", value: "main-session" });
  assert.equal(textarea.value, "");

  assert.ok(
    desktop.persisted.every((delta) => (delta.tasks ?? []).every((entry) => entry.task.id !== start.taskId)),
    "a side chat's thread never reaches the store",
  );

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Stop side chat"]').click(); });
  assert.deepEqual(desktop.sent.at(-1), { type: "cancel", taskId: start.taskId, runId: start.runId });
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

test("the sidebar follows the thread the keyboard steps to", async () => {
  const thread = (id: string): Task => ({
    id, title: id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  });
  const scrolled: Array<{ className: string; options?: boolean | ScrollIntoViewOptions }> = [];
  const original = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ className: this.className, options }); };
  const sidebar = (currentId: string | null) => renderProjectSidebar({
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
    schedules: new Map(),
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
  const thread = (id: string, overrides: Partial<Task> = {}): Task => ({
    id, title: id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, ...overrides,
  });
  const dismissed: string[] = [];
  let clearedAll = 0;
  const view = await mount(renderProjectSidebar({
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
    schedules: new Map(),
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

  const listed = (label: string) => [...view.container.querySelectorAll(`nav[aria-label="${label}"] .task-row-text > span`)].map((row) => row.textContent);
  assert.deepEqual(listed("Priority"), ["asked", "unread", "seen"]);
  assert.deepEqual(listed("Running"), ["busy"]);
  assert.deepEqual(listed("Threads"), ["quiet"]);
  assert.equal(view.container.querySelector('[data-rfd-draggable-id]'), null, "activity mode ranks its own rows, so none of them drag");

  assert.match(
    query(view.container, 'nav[aria-label="Priority"] .task-row-text > small').textContent,
    /^project · /,
    "a flat list still says which folder a thread lives in",
  );
  assert.deepEqual(
    [...view.container.querySelectorAll('nav[aria-label="Priority"] .task-attention.finished')].length,
    1,
    "a verdict the user has read ranks without a mark of its own",
  );
  assert.equal(
    query(view.container, 'nav[aria-label="Priority"] [aria-label="Needs approval"]').className,
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

  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Dismiss seen"]').click(); });
  assert.deepEqual(dismissed, ["seen"], "a read row still offers to be filed away");

  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Dismiss all"]').click(); });
  assert.equal(clearedAll, 1);
  await view.unmount();
});

test("only the priority heading offers to dismiss every dot at once", async () => {
  const thread = (id: string, overrides: Partial<Task> = {}): Task => ({
    id, title: id, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, ...overrides,
  });
  const sidebar = (priority: Task[]) => renderProjectSidebar({
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
    schedules: new Map(),
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
  await view.unmount();
});

test("the sidebar steps through visited threads", async () => {
  let backSteps = 0;
  const view = await mount(renderProjectSidebar({
    open: false,
    inactive: false,
    projects: [],
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
    canGoBack: true,
    canGoForward: false,
    onGoBack: () => { backSteps += 1; },
    onGoForward() {},
    onNewTask() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectTask() {}, onArchiveTask() {}, onDismissTask() {}, onDismissAll() {}, onMoveTask() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  assert.ok(query<HTMLButtonElement>(view.container, 'button[aria-label="Go forward"]').disabled, "nothing ahead to go forward to");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Go back"]').click(); });
  assert.equal(backSteps, 1);
  await view.unmount();
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
    diffSummary: async (workspaceId, range) => ({ status: "available", range, files: [], additions: 0, deletions: 0 }),
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

test("the workspace hook hands the thread's checkout to the application the list chose", async () => {
  const desktop = fakeDesktop({ openFolder: async () => ({ id: "workspace-1", kind: "project", root: "/project" }) });
  const workspace = await mountWorkspace(desktop);
  await act(async () => { await workspace.get().actions.openFolder(); });
  await act(async () => { await workspace.get().actions.openFolderInApp("cursor"); });

  assert.deepEqual(desktop.appCalls, [["cursor", "/project"]]);
  await workspace.view.unmount();
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

/** Opens settings on one of its pages, named the way its sidebar names it. */
type MountView = Awaited<ReturnType<typeof mount>>;

async function openSettingsPage(view: MountView, name: string) {
  await act(async () => { query<HTMLButtonElement>(view.container, ".sidebar-settings").click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === name)).click(); });
}

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

test("context usage stays within 100% when the window shrinks below the used tokens", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(renderTaskComposer({
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

  const usage = query(view.container, ".context-usage");
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
  const decisions: boolean[] = [];
  const policies: ExecutionPolicy[] = [];
  const chatTask: Task = {
    id: "chat-1",
    title: "Side chat",
    executionPolicy: "allow-edits",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    contextUsage: { tokens: 120_000, limit: 200_000, model: "claude-opus-5" },
  };
  type SideChatProps = React.ComponentProps<typeof SideChat>;
  const sideChatProps = (prompt: string, onPrompt: SideChatProps["onPrompt"]): SideChatProps => ({
    chat: {
      id: "chat-1",
      title: "Chat 1",
      sourceTaskId: "main-task",
      error: null,
      task: chatTask,
      compacting: false,
      status: "running",
      streamingTail: null,
      queuedMessages: [],
      annotations: [], pastes: [], images: [], files: [],
      readingPoint: null,
      running: true,
      approval: { approvalId: "approval-1", taskId: "chat-1", runId: "run-1", title: "Run a command", description: "ls", toolName: "Bash", input: { command: "ls" } },
      prompt,
    },
    source: { ...chatTask, id: "main-task", title: "Main", continuation: { provider: "claude", value: "main-session" } },
    onPrompt,
    onAnnotateAdd() {},
    onAnnotateNote() {},
    onAnnotateRecall() {},
    onAnnotateRemove() {},
    onPasteAdd() {},
    onPasteRecall() {},
    onPasteRemove() {},
    onFilesAdd() {}, onFileRecall() {}, onFileRemove() {}, onImageRecall() {},
    onImageRemove() {},
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

  const usage = query(view.container, ".context-usage");
  assert.equal(usage.getAttribute("aria-label"), "60% of context window used");
  assert.match(usage.textContent, /120K \/ 200K tokens used/);

  const settings = view.container.querySelectorAll<HTMLDetailsElement>(".composer-settings .setting-menu");
  assert.equal(settings.length, 3, "permission mode, model, and effort");
  assert.equal(query(item(settings[0]), ".setting-value").textContent, "Edits", "the chat's own policy is selected, not the first one on offer");
  await act(async () => { query<HTMLElement>(item(settings[0]), "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { item([...item(settings[0]).querySelectorAll<HTMLButtonElement>(".setting-option")].find((option) => option.textContent.includes("Auto mode"))).click(); });
  assert.deepEqual(policies, ["autonomous"]);

  const approval = query(view.container, ".approval-card");
  assert.match(approval.textContent, /Run a command/);
  await act(async () => { item([...approval.querySelectorAll("button")].at(-1)).click(); });
  assert.deepEqual(decisions, [true]);

  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Side chat prompt"]');
  assert.ok(view.container.querySelector(".composer-wrap.side .composer"), "the side chat uses the shared composer");

  const paste = new dom.window.Event("paste", { bubbles: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [new dom.window.File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" })] } });
  await act(async () => { textarea.dispatchEvent(paste); });
  await settleUntil(() => view.container.querySelectorAll(".attachment-chip").length === 1, "a side chat takes a pasted image");
  await view.unmount();
});

test("one outside pointer press dismisses the slash menu until the draft changes", async () => {
  window.desktop = fakeDesktop({ commands: async () => ({ status: "available", commands: [{ name: "review", description: "Review this change.", argumentHint: "" }] }) });
  function Harness() {
    const [prompt, setPrompt] = React.useState("");
    return renderTaskComposer({
      prompt, folder: "/project", workspaceId: "workspace-1", mode: "confirm", model: "opus", effort: "medium", runActive: false,
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
      model: "opus",
      runActive: false,
      history: ["first question", "first question", "second question"].map((text) => ({ text, annotations: [], pastes: [], files: [], attachments: [] })),
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
    return renderTaskComposer({
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

type RecordingContext = CanvasRenderingContext2D & {
  calls: { text: string[]; strokes: number; fills: number };
};

function recordingContext(): RecordingContext {
  const calls = { text: [] as string[], strokes: 0, fills: 0 };
  const context = {
    measureText: (value: string) => ({ width: value.length * 7 }),
    fillText: (value: string) => calls.text.push(value),
    strokeRect: () => { calls.strokes += 1; },
    fillRect: () => {},
    beginPath: () => {},
    arc: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    fill: () => { calls.fills += 1; },
  };
  return Object.assign(context, { calls }) as unknown as RecordingContext;
}

test("arrows draw without a mark and never renumber the boxes around them", () => {
  const context = recordingContext();
  drawAnnotations(context, [
    { kind: "box", x: 0.1, y: 0.1, width: 0.2, height: 0.2, text: "first" },
    { kind: "arrow", x: 0.8, y: 0.8, width: -0.3, height: -0.3, text: "" },
    { kind: "box", x: 0.5, y: 0.5, width: 0.2, height: 0.2, text: "second" },
  ], 1000, 800);

  assert.deepEqual(context.calls.text, ["1", "2"]);
  assert.equal(context.calls.strokes, 2);
});

test("marks take their screenshot's letter when a send carries more than one", () => {
  const context = recordingContext();
  drawAnnotations(context, [
    { kind: "box", x: 0.1, y: 0.1, width: 0.2, height: 0.2, text: "text 1" },
    { kind: "box", x: 0.5, y: 0.5, width: 0.2, height: 0.2, text: "text 2" },
  ], 1000, 800, "B");

  assert.deepEqual(context.calls.text, ["B1", "B2"]);
});

test("a mark carries its number alone, however long the note behind it is", () => {
  const context = recordingContext();
  drawAnnotations(context, [
    { kind: "box", x: 0.1, y: 0.4, width: 0.2, height: 0.2, text: "this note is long enough to have needed more than one line of chip" },
  ], 1000, 800);

  assert.deepEqual(context.calls.text, ["1"]);
});

test("badges on boxes drawn over each other are moved apart rather than stacked", () => {
  const radius = badgeRadius(1000, 800);
  const spots = placeBadges([
    { x: 300, y: 300, width: 200, height: 160 },
    { x: 306, y: 304, width: 200, height: 160 },
    { x: 312, y: 308, width: 200, height: 160 },
  ], 1000, 800);

  assert.equal(spots.length, 3);
  for (let one = 0; one < spots.length; one += 1) {
    for (let other = one + 1; other < spots.length; other += 1) {
      const oneSpot = item(spots[one]);
      const otherSpot = item(spots[other]);
      assert.ok(
        Math.hypot(oneSpot.x - otherSpot.x, oneSpot.y - otherSpot.y) >= radius * 2,
        `badges ${one + 1} and ${other + 1} overlap`,
      );
    }
  }
});

test("a badge on a box at the edge stays inside the image", () => {
  const radius = badgeRadius(1000, 800);
  const [corner] = placeBadges([{ x: 0, y: 0, width: 120, height: 90 }], 1000, 800);
  assert.ok(corner);

  assert.ok(corner.x >= radius && corner.x <= 1000 - radius);
  assert.ok(corner.y >= radius && corner.y <= 800 - radius);
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

test("closing subagent details returns to the agents tab", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  assert.ok(view.container.querySelector('[aria-label="Choose a right panel"]'));
  assert.equal(view.container.querySelector('.right-dock [role="tab"]'), null);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Subagents panel"]').click(); });
  assert.match(query(view.container, '.right-dock [role="tab"]').textContent, /Subagents/);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Complete agent details"]').click(); });
  assert.ok(view.container.querySelector(".subagent-inspector"));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Close subagent details"]').click(); });
  assert.ok(view.container.querySelector('.agents-panel button[aria-label="Open Complete agent details"]'));

  await view.unmount();
});

test("a view opened in the dock takes the caret with it", async () => {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
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

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Side chat panel"]').click(); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Side chat prompt"]'), "the chat is opened to type in");

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]').click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((candidate) => candidate.textContent.includes("Browser"))).click(); });
  assert.equal(document.activeElement, view.container.querySelector('.browser-bar input[aria-label="Address"]'), "a page with no address yet asks for one");

  await view.unmount();
});

test("hiding the panel hands the caret back instead of losing it", async () => {
  localStorage.clear();
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
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

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Side chat panel"]').click(); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Side chat prompt"]'));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Hide right panel"]').click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(document.activeElement, view.container.querySelector('textarea[aria-label="Task prompt"]'), "the composer takes the keyboard the hidden panel was holding");

  await view.unmount();
});

test("session summary stays outside the tabbed right panel", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show session summary"]').click(); });
  assert.ok(view.container.querySelector('.workspace > .session-panel'));
  assert.equal(view.container.querySelector('.right-dock .session-panel'), null);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Open Complete agent details"]').click(); });
  assert.equal(view.container.querySelector('.workspace > .session-panel'), null);
  assert.ok(view.container.querySelector('.right-dock .subagent-inspector'));

  await view.unmount();
});

test("right panel keeps multiple side chats mounted as tabs", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  const add = query<HTMLButtonElement>(view.container, 'button[aria-label="Add right panel tab"]');
  await act(async () => { add.click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add button')].find((button) => button.textContent.includes("Side chat"))).click(); });
  await act(async () => { add.click(); });
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>('.right-dock-add button')].find((button) => button.textContent.includes("Side chat"))).click(); });

  assert.equal(view.container.querySelectorAll('.right-dock [role="tab"]').length, 2);
  assert.equal(view.container.querySelectorAll('.side-chat').length, 2);
  assert.equal(view.container.querySelectorAll('.right-dock-content > div[hidden]').length, 2, "only the picker and inactive chat stay hidden");
  await view.unmount();
});

test("every right panel view opens as a closable tab", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  const labels = [...view.container.querySelectorAll<HTMLButtonElement>(".right-dock-picker button:not([disabled])")].map((button) => button.getAttribute("aria-label"));
  assert.ok(labels.length >= 3);

  for (const label of labels) {
    await act(async () => { query<HTMLButtonElement>(view.container, `.right-dock-picker button[aria-label="${label}"]`).click(); });
    const tab = [...view.container.querySelectorAll<HTMLElement>(".right-dock-tab")].find((candidate) => candidate.classList.contains("active"));
    assert.ok(tab, `${label} opened no tab`);
    assert.ok(view.container.querySelector(".right-dock-content > div:not([hidden])"), `${label} opened no panel content`);

    const close = tab.querySelector<HTMLButtonElement>('button[aria-label^="Close "]');
    assert.ok(close, `${label} opened a tab that cannot be closed`);
    await act(async () => { close.click(); });
    assert.equal(view.container.querySelectorAll(".right-dock-tab").length, 0, `${label} left a tab behind`);
    assert.equal(query<HTMLElement>(view.container, ".right-dock-picker").hidden, false);
  }

  await view.unmount();
});

test("right panel resizes with the keyboard", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show right panel"]').click(); });
  const workspace = query<HTMLElement>(view.container, ".workspace");
  const panel = query<HTMLElement>(view.container, ".right-dock");
  workspace.getBoundingClientRect = () => dom.window.DOMRect.fromRect({ width: 1000 });
  panel.getBoundingClientRect = () => dom.window.DOMRect.fromRect({ x: 600 });
  await act(async () => { query<HTMLElement>(panel, '[aria-label="Resize right panel"]').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
  assert.equal(workspace.style.getPropertyValue("--right-dock-width"), "410px");
  await view.unmount();
});

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

test("the sidebar switches to activity mode, and dismissing there takes the dot off for good", async () => {
  seedProjectTasks([
    { id: "quiet", title: "Quiet task", sortIndex: 0, updatedAt: 5, createdAt: 5 },
    { id: "settled", title: "Settled task", sortIndex: 1, updatedAt: 9, createdAt: 9, outcome: "finished", outcomeUnread: true },
  ]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const toggle = () => query<HTMLButtonElement>(view.container, '[aria-label="Rank threads by activity"]');
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
  await act(async () => { query<HTMLElement>(view.container, 'nav[aria-label="Priority"] .task-row').click(); });
  assert.deepEqual(priority(), ["Settled task"]);
  assert.equal(view.container.querySelector(".task-attention.finished"), null);

  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Dismiss Settled task"]').click(); });
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

  const waiting = [...view.container.querySelectorAll<HTMLElement>(".project-task-row")].find((row) => row.textContent.includes("Waiting task"));
  assert.ok(waiting);
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
  const start = startCommand(desktop.sent[0]);

  await act(async () => { window.dispatchEvent(new Event("blur")); });
  await act(async () => {
    desktop.listener({ type: "run.status", taskId: start.taskId, runId: start.runId, sequence: 1, status: "succeeded" });
  });
  assert.equal(item(workspace.get().currentTask).outcome, "finished");
  assert.equal(item(workspace.get().currentTask).outcomeUnread, undefined);

  await act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.equal(item(workspace.get().currentTask).outcomeUnread, undefined, "and coming back finds nothing marked");
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
    id: "task-1", title: "Task", projectId: BRANCH_PROJECT.id, executionPolicy: "confirm", messages: [],
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
  const modelMenu = item(view.container.querySelectorAll<HTMLElement>(".setting-menu")[1]);
  await act(async () => { query<HTMLElement>(modelMenu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(
    [...modelMenu.querySelectorAll(".setting-option strong")].map((item) => item.textContent),
    ["Fable", "Opus", "Sonnet", "Haiku"],
  );
  assert.equal(query(modelMenu, ".setting-value").textContent, "Opus");
  const effortMenu = item(view.container.querySelectorAll<HTMLElement>(".setting-menu")[2]);
  await act(async () => { query<HTMLElement>(effortMenu, "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.deepEqual(
    [...effortMenu.querySelectorAll(".setting-option strong")].map((item) => item.textContent),
    ["Max effort", "Extra high effort", "High effort", "Medium effort", "Low effort"],
  );
  assert.equal(query(effortMenu, ".setting-value").textContent, "High");
  await view.unmount();
});

test("workspace hook reads a stored subagent's activity only when it is opened", async () => {
  const project = { id: "project-1", root: "/project", workspaceId: "workspace-1" };
  const task: Task = {
    id: "task-1", title: "Task", projectId: project.id, executionPolicy: "confirm", messages: [],
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

type TimelineProps = React.ComponentProps<typeof ConversationTimeline>;
type TimelineMessage = Task["messages"][number];
type TimelineMessageSeed = Omit<TimelineMessage, "id" | "at">;
type TimelineReadingPoint = Parameters<NonNullable<TimelineProps["onReadingPointMove"]>>[0];
type ThreadMountedView = Awaited<ReturnType<typeof mount>>;

function transcript(...messages: TimelineMessageSeed[]): TimelineMessage[] {
  return messages.map((message, index) => ({ id: `m${index}`, at: index * 1000, ...message }));
}

async function expand(details: HTMLDetailsElement) {
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

function timelineView(
  messages: TimelineMessage[],
  status: TimelineProps["status"],
  streamingTail: TimelineProps["streamingTail"] = undefined,
  runEndedAt?: number,
  find: TimelineProps["find"] = undefined,
  waitingOn: TimelineProps["waitingOn"] = null,
) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  document.body.append(scroller);
  const task: Task = {
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
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => offset, set: (next: number) => { offset = next; } });
  const scrolls: number[] = [];
  function recordScroll(options?: ScrollToOptions): void;
  function recordScroll(x: number, y: number): void;
  function recordScroll(options: ScrollToOptions | number = {}, y = 0) {
    const top = typeof options === "number" ? y : (options.top ?? 0);
    scrolls.push(top);
    offset = top;
  }
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: recordScroll });
  document.body.append(scroller);
  const scrollContainerRef = { current: scroller };
  /** What the workspace would hold, fed back in as each thread is opened. */
  const points: Record<string, TimelineReadingPoint> = {};
  const moves: Array<{ id: string; point: TimelineReadingPoint }> = [];
  const thread = (id: string, count: number, prefix?: string) => {
    const currentTask: Task = {
      id, title: id, executionPolicy: "confirm", continuationStatus: "none", updatedAt: 1,
      lastChangeSnapshot: { files: [], capturedAt: 1 },
      messages: transcript(...Array.from({ length: count }, (_, index): TimelineMessageSeed => ({
        kind: index % 2 === 0 ? "user" : "assistant",
        text: `${id} ${index}`,
      })))
        .map((message, index) => (prefix ? { ...message, id: `${prefix}${index}` } : message)),
    };
    return React.createElement(ConversationTimeline, {
      currentTask,
      folder: "/p", status: "idle", compacting: false, waitingOn: null, scrollContainerRef,
      readingPoint: points[id] ?? null,
      onReadingPointMove: (point: TimelineReadingPoint) => { points[id] = point; moves.push({ id, point }); },
    });
  };
  const scrollTo = async (top: number) => {
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
  return {
    scroller,
    scrolls,
    points,
    moves,
    thread,
    scrollTo,
    settle,
    resize,
    done: async (view: ThreadMountedView) => { await view.unmount(); scroller.remove(); },
  };
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
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, READING_SETTLE_MS + 80)); });

  assert.ok(moves.length >= 1, "the settled place was reported");
  const reported = item(moves.filter((move) => move.id === "read").at(-1));
  assert.ok(reported.point !== null, "a mid-transcript reader is not reported at the foot");
  assert.ok(typeof reported.point.depth === "number", "the report carries how far into the row the view sat");

  /** Reporting the same place again adds nothing for the workspace to hear. */
  const heard = moves.length;
  await scrollTo(300);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, READING_SETTLE_MS + 80)); });
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
  const find: NonNullable<TimelineProps["find"]> = {
    target: { kind: "transcript" },
    query: "retry",
    index: 0,
    focus: 1,
    matches: 1,
    hit: { messageId: "m1", field: "detail", start: 0, occurrence: 0 },
  };
  const view = await mount(timelineView(messages, "idle", undefined, undefined, find));

  assert.equal(query(view.container, ".work-steps pre").textContent, "retry the build");

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

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "Read");
  assert.equal(query(run, ".work-count").textContent, "+2");
  assert.equal(query(view.container, ".work-note").textContent, "I'll investigate.");
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

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "$yarn tsc --noEmit");

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

  const run = query<HTMLDetailsElement>(view.container, ".work-run");
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

  const settled = query<HTMLDetailsElement>(view.container, ".work-group");
  assert.equal(query(settled, ".work-summary").textContent, "3 steps");
  assert.equal(query(view.container, ".message.turn > .message-text").textContent, "Fixed the race.");
  assert.equal(view.container.querySelector(".work-note"), null);

  await expand(settled);
  assert.equal(query(view.container, ".work-note").textContent, "I'll investigate.");
  const run = query<HTMLDetailsElement>(view.container, ".work-run");
  assert.equal(query(run, ".work-arg").textContent, "Grep");
  assert.equal(query(run, ".work-count").textContent, "+1");

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
  const settledTurn = item(settled[3]);
  if (settledTurn.kind !== "turn") assert.fail("expected the last settled group to be a turn");
  assert.equal(settledTurn.final, null);
  assert.equal(settledTurn.steps.length, 2);

  const running = groupTimeline(messages, { running: true });
  const earlierTurn = item(running[1]);
  const liveTurn = item(running[3]);
  if (earlierTurn.kind !== "turn" || liveTurn.kind !== "turn") assert.fail("expected grouped turns");
  assert.equal(earlierTurn.live, false);
  assert.equal(liveTurn.live, true);
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

  const settled = query<HTMLDetailsElement>(settledView.container, ".work-group");
  assert.equal(query(settled, ".work-time").textContent, "3s");
  await expand(settled);
  const run = query<HTMLDetailsElement>(settledView.container, ".work-run");
  assert.equal(query(run, ".work-time").textContent, "2s");
  await expand(run);
  assert.deepEqual([...run.querySelectorAll(".work-row .work-time")].map((time) => time.textContent), ["1s", "1s"]);
  await settledView.unmount();
});

test("a running turn counts up until its work ends", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.setSystemTime(100_000);
  t.onTestFinished(() => { vi.useRealTimers(); });
  const running: TimelineMessage[] = [
    { id: "l0", at: 40_000, kind: "tool", text: "Bash", detail: "one" },
    { id: "l1", at: 95_000, kind: "tool", text: "Grep", detail: "two" },
  ];
  const view = await mount(timelineView(running, "running"));
  /** The turn's own elapsed: the outermost fold's, whichever fold a running or settled turn draws. */
  const elapsed = () => query(view.container, ".work-time").textContent;

  assert.equal(elapsed(), "1m 0s");
  await act(async () => { vi.advanceTimersByTime(4_000); });
  assert.equal(elapsed(), "1m 4s");

  await view.render(timelineView([...running, { id: "l2", at: 106_000, kind: "assistant", text: "Done." }], "idle"));
  assert.equal(elapsed(), "1m 6s");
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "1m 6s");

  await view.unmount();
});

test("a stopped turn freezes at the moment its run ended", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
  vi.setSystemTime(100_000);
  t.onTestFinished(() => { vi.useRealTimers(); });
  const running: TimelineMessage[] = [
    { id: "l0", at: 40_000, kind: "tool", text: "Bash", detail: "one" },
    { id: "l1", at: 95_000, kind: "tool", text: "Grep", detail: "two" },
  ];
  const view = await mount(timelineView(running, "running"));
  /** The turn's own elapsed: the outermost fold's, whichever fold a running or settled turn draws. */
  const elapsed = () => query(view.container, ".work-time").textContent;

  assert.equal(elapsed(), "1m 0s");
  await view.render(timelineView(running, "stopped", null, 102_000));
  assert.equal(elapsed(), "1m 2s");
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "1m 2s", "stopping ends the turn even though no answer closed it");

  await view.render(timelineView(running, "stopped", null));
  await act(async () => { vi.advanceTimersByTime(30_000); });
  assert.equal(elapsed(), "55s", "work stored before stops were timed rests on its last step");

  await view.unmount();
});

test("elapsed labels stay readable from seconds to hours", async () => {
  const { formatElapsed } = await import("../../src/renderer/components/ConversationTimeline.tsx");

  assert.equal(formatElapsed(-5), "0s");
  assert.equal(formatElapsed(940), "1s");
  assert.equal(formatElapsed(59_400), "59s");
  assert.equal(formatElapsed(60_000), "1m 0s");
  assert.equal(formatElapsed(3_599_000), "59m 59s");
  assert.equal(formatElapsed(3_600_000), "1h 0m");
  assert.equal(formatElapsed(7_500_000), "2h 5m");
});

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
    automation: null, lastFoundAt: null, lastChecked: null, onUpdate() {}, onDelete() {}, onRunNow() {},
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
    automation, lastFoundAt: null, lastChecked: null, onUpdate: (patch) => { patches.push(patch); }, onDelete() {}, onRunNow() {},
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

test("the sidebar lists a project's threads as one list, and its menu starts another in a checkout", async () => {
  const thread = (id: string, overrides: Partial<Task> = {}): Task => ({
    id, title: id, projectId: "project-1", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1, ...overrides,
  });
  const worktree = { id: "wt1", projectId: "project-1", root: "/worktrees/project-wt1", workspaceId: "ws-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 };
  const started: Array<[string | undefined, string | undefined]> = [];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedTasks: [thread("in-checkout", { worktreeId: "wt1" }), thread("in-project")],
    recentTasks: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    schedules: new Map(),
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
  const marked = query<HTMLElement>(view.container, '[data-rfd-draggable-id="in-checkout"] .task-worktree');
  assert.equal(marked.getAttribute("aria-label"), "Works in project-wt1", "the row's own mark says which checkout it works in");

  const menuItem = [...view.container.querySelectorAll<HTMLButtonElement>(".project-menu [role=menuitem]")].find((button) => button.textContent === "New thread in project-wt1");
  assert.ok(menuItem);
  await act(async () => { menuItem.click(); });
  assert.deepEqual(started, [["project-1", "wt1"]], "the project's menu is where a checkout it already has is started in");
  await view.unmount();
});

test("the sidebar marks the threads that run on a schedule and the ones with their own checkout", async () => {
  const task = (id: string, projectId?: string): Task => ({
    id, title: id, ...(projectId ? { projectId } : {}), executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedTasks: [task("scheduled-task", "project-1"), task("plain-task", "project-1")],
    recentTasks: [task("scheduled-chat"), task("plain-chat")],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningTaskIds: new Set(),
    blockedTaskIds: new Set(),
    schedules: new Map([["scheduled-task", automationView({ taskId: "scheduled-task" })], ["scheduled-chat", automationView({ taskId: "scheduled-chat" })]]),
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

  const marks = (label: string) => [...view.container.querySelectorAll(`[aria-label="${label}"]`)]
    .map((icon) => item(icon.closest("[data-rfd-draggable-id]")).getAttribute("data-rfd-draggable-id"))
    .sort();

  assert.deepEqual(marks("Runs on a schedule"), ["scheduled-chat", "scheduled-task"]);
  assert.deepEqual(marks("Works in a worktree"), ["plain-task"], "a thread with its own checkout is marked wherever it is listed");
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

function streaming(props: React.ComponentProps<typeof StreamingText>) {
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

  assert.equal(query(view.container, "h2").textContent, "Heading");
  assert.equal(view.container.textContent, "HeadingThen a", "the unclosed emphasis run waits instead of showing its markers");
  assert.equal(view.container.querySelector("strong"), null);

  await view.render(streaming({ committed: "## Heading\n\nThen a **partly** written line.\n\n", tail: "" }));
  assert.equal(query(view.container, "strong").textContent, "partly");
  await view.unmount();
});

test("a streamed code fence renders as a code block instead of literal backticks", async () => {
  const view = await mount(streaming({ committed: "", tail: "```ts\nconst reducer = 1;\n" }));

  assert.equal(query(view.container, "pre code").textContent.trim(), "const reducer = 1;");
  assert.doesNotMatch(view.container.textContent, /```/, "the opening fence is never shown as text");
  await view.unmount();
});

test("a table waits for its delimiter row instead of showing pipes", async () => {
  const view = await mount(streaming({ committed: "", tail: "| Channel | Reach |\n" }));
  assert.equal(view.container.textContent, "", "a header row alone would render as literal pipes");

  await view.render(streaming({ committed: "", tail: "| Channel | Reach |\n| --- | --- |\n| side | tools |\n" }));
  assert.equal(query(view.container, "table th").textContent, "Channel");
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

  assert.equal(query(view.container, ".work-note p").textContent, "First block.");
  assert.match(view.container.textContent, /Second block still/);
  await view.unmount();
});

test("a block committing between tails does not replay the text already read", async () => {
  const streamed = transcript({ kind: "user", text: "Explain this" });
  const view = await mount(timelineView(streamed, "running", { messageId: "reply-1", text: "The reducer owns every write." }));
  assert.match(view.container.textContent, /The reducer owns every write\./);

  /** The delta clears the tail before the next one arrives, which is where a remount would rewind. */
  const committed: Task["messages"] = [...streamed, { id: "reply-1", at: 2000, kind: "assistant", text: "The reducer owns every write.\n\n" }];
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
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => offset, set: (next: number) => { offset = next; } });
  document.body.append(scroller);
  const sentTo: number[] = [];
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: (optionsOrX?: ScrollToOptions | number, y?: number) => {
    const top = typeof optionsOrX === "number" ? y ?? 0 : optionsOrX?.top ?? 0;
    sentTo.push(top);
    offset = top;
  } });
  const scrollContainerRef = { current: scroller };
  type TimelineProps = React.ComponentProps<typeof ConversationTimeline>;
  const render = (messages: Task["messages"], status: TimelineProps["status"], streamingTail: TimelineProps["streamingTail"]) => React.createElement(ConversationTimeline, {
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
  const resumed: Task["messages"] = [...working, { id: "reply-1", at: 3000, kind: "assistant", text: "Here is what I found.\n\n" }, { id: "k2", at: 4000, kind: "tool", text: "Read", detail: "two" }];
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
  const button = query<HTMLButtonElement>(view.container, ".scroll-to-end");

  harness.sentTo.length = 0;
  await harness.resize();
  assert.deepEqual(harness.sentTo, [], "a transcript the reader scrolled is left where they put it");

  await act(async () => { button.click(); });
  assert.equal(harness.sentTo.at(-1), harness.bottom, "the button returns to the end");
  await view.unmount();
});

type ThreadSummary = import("../../src/contracts/threads.ts").ThreadSummary;
type ThreadTranscript = import("../../src/contracts/threads.ts").ThreadTranscript;
type ThreadCommandResult = import("../../src/contracts/threads.ts").ThreadCommandResult;
type ThreadWaitResult = import("../../src/contracts/threads.ts").ThreadWaitResult;
type BrowserReadResult = import("../../src/contracts/threads.ts").BrowserReadResult;
type ThreadLocation = import("../../src/application/workspace-state.ts").ThreadLocation;

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

function browserReadResult(response: ThreadResponse | undefined): BrowserReadResult {
  const result = responseRecord(response);
  assert.ok(["tabs", "snapshot", "awaiting-approval", "no-tab"].includes(String(result.kind)));
  return result as BrowserReadResult;
}

function failedThreadResponse(response: ThreadResponse | undefined): Extract<ThreadResponse, { ok: false }> {
  const actual = item(response);
  assert.equal(actual.ok, false);
  if (actual.ok) assert.fail("Expected the thread request to fail");
  return actual;
}

function callNamed(calls: unknown[][], name: string): unknown[] {
  return item(calls.find((call) => call[0] === name));
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") assert.fail("Expected a string");
  return value;
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

  const worktree: ThreadLocation = { kind: "worktree", worktree: { id: "wt1", root: "/worktrees/repo-wt1", projectId: "p", workspaceId: "w", baseCommit: "abc1234", createdAt: 1, lastUsedAt: 1 } };
  await view.render(panel(worktree, "session:location"));
  assert.deepEqual(items(view), ["Return to local"]);
  assert.match(query(view.container, ".session-location-row span:nth-of-type(2)").textContent, /Worktree/);
  await act(async () => { item(view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[0]).click(); });
  assert.deepEqual(calls.worktree, [true, false]);

  await view.render(panel(worktree, "session:location", true));
  assert.equal(query<HTMLButtonElement>(view.container, '[role="menuitem"]').disabled, true, "a running thread cannot change where it works");

  await view.render(panel({ kind: "creating" }, "session:location"));
  assert.match(query(view.container, ".session-location-row span:nth-of-type(2)").textContent, /Creating worktree/);
  assert.equal(query<HTMLButtonElement>(view.container, '[role="menuitem"]').disabled, true, "a checkout being made cannot be asked for twice");
  await view.unmount();
});

test("a thread waiting on its checkout says so in the transcript, and its composer holds", async () => {
  window.desktop = fakeDesktop();
  const messages = transcript({ kind: "user", text: "Refactor the loader" });

  const view = await mount(timelineView(messages, "idle"));
  assert.equal(view.container.querySelector(".waiting-row"), null, "an idle thread is not waiting on anything");

  await view.render(timelineView(messages, "idle", undefined, undefined, undefined, "worktree"));
  const waiting = query(view.container, ".waiting-row");
  assert.match(waiting.textContent, /Creating worktree/);
  assert.equal(waiting.getAttribute("role"), "status", "the wait is announced rather than only drawn");

  await view.render(timelineView(messages, "idle", undefined, undefined, undefined, "run"));
  assert.match(query(view.container, ".waiting-row").textContent, /Starting/);
  await view.unmount();
});

test("the send button holds while the checkout a send needs is still being made", async () => {
  window.desktop = fakeDesktop();
  const sent: string[] = [];
  const composer = (waiting: boolean) => React.createElement(TaskComposer, {
    prompt: "Refactor the loader", folder: "/project", workspaceId: "workspace-1", mode: "confirm", model: "opus", effort: "medium",
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

test("the workflow panel groups agents by phase, draws their lanes, and opens one", async () => {
  const stopped: string[] = [];
  const view = await mount(React.createElement(WorkflowPanel, { workflow: liveWorkflow, onStop: (id) => { stopped.push(id); } }));

  assert.match(view.container.textContent, /review-changes/);
  assert.match(view.container.textContent, /2\/3/, "done counts both the finished and the failed");
  assert.deepEqual([...view.container.querySelectorAll(".workflow-group-head h3")].map((head) => head.textContent), ["Review", "Verify"]);
  assert.equal(view.container.querySelectorAll(".workflow-lane").length, 3);
  assert.match(query(view.container, ".workflow-row .workflow-row-main small").textContent, /3 findings/);
  assert.match(view.container.textContent, /Using Grep/);
  assert.match(view.container.textContent, /retry 2/);
  assert.match(view.container.textContent, /worktree/);
  assert.match(view.container.textContent, /Agent returned no structured output/);

  await act(async () => { view.container.querySelector('button[aria-label="Stop review-changes"]'); });
  await act(async () => { query<HTMLButtonElement>(view.container, ".workflow-stop").click(); });
  assert.deepEqual(stopped, ["wf-1"]);

  await act(async () => { query<HTMLElement>(view.container, '.workflow-row[aria-label="Open verify:store.ts details"]').click(); });
  assert.match(view.container.textContent, /Adversarially verify this finding/);
  assert.match(view.container.textContent, /Previews are the first 400 characters/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".session-back").click(); });
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
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({
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
async function openReview(view: MountView) {
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show session summary"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Review changes"]').click(); });
  /** Names are held back until a patch lands, and the first patch waits on its grammar being imported. */
  for (let turn = 0; turn < 100 && !view.container.querySelector(".diff-file-row"); turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** A review opens side by side, so the one-column view is what a test has to ask for. */
async function showOneColumn(view: MountView) {
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show one column"]').click(); });
}

/** Opens the session panel, which is where the Changes row that reaches the review lives. */
async function showSession(view: MountView) {
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Show session summary"]').click(); });
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

  const tabs = () => [...view.container.querySelectorAll('.right-dock-tab [role="tab"]')].map((tab) => tab.textContent);
  await openReview(view);

  assert.deepEqual(tabs(), ["Changes1"], "the review opens as the dock's tab, counting the file still to read");
  assert.equal(query(view.container, ".diff-file-name").textContent, "src/app.ts");
  assert.match(query(view.container, ".diff-progress").textContent, /0 of 1 viewed/);

  /** The dock takes the session panel's place, so the row that opened the review is closed from the tab. */
  await act(async () => { query<HTMLButtonElement>(view.container, '.right-dock-tab.active button[aria-label="Close Changes"]').click(); });
  assert.deepEqual([tabs(), view.container.querySelector(".diff-panel")], [[], null], "closing the tab unmounts its retained patch data");
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

  await act(async () => { query<HTMLButtonElement>(view.container, ".diff-file-open").click(); });
  assert.equal(view.container.querySelectorAll(".diff-line").length, 0, "the header folds it away");
  await view.unmount();
});

test("a file's lines are coloured by the grammar its extension names", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  await showOneColumn(view);

  const coloured = [...view.container.querySelectorAll<HTMLElement>(".diff-line code span")];
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

  const gutters = [...view.container.querySelectorAll<HTMLElement>(".diff-gutter")];
  await act(async () => { gutters[2].click(); });
  await act(async () => { gutters[3].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })); });

  assert.equal(view.container.querySelectorAll(".diff-line.selected").length, 2, "shift extends the selection");
  assert.match(query(view.container, ".diff-comment-range").textContent, /^src\/app\.ts:L2-L3$/);

  /** The note is written among the lines it is about, not docked away below the whole review. */
  const drawn = [...view.container.querySelectorAll(".diff-files .diff-line, .diff-files .diff-comment")];
  const composer = drawn.findIndex((node) => node.classList.contains("diff-comment"));
  assert.ok(composer > 0, "the composer is drawn with the rows, inside the scroller");
  assert.ok(drawn[composer - 1].classList.contains("selected"), "it follows the last selected line");

  const note = query<HTMLTextAreaElement>(view.container, '.diff-comment textarea');
  await act(async () => {
    note.value = "Name these properly";
    note.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Comment on the selected lines"]').click(); });

  const pill = view.container.querySelector(".annotation-pill");
  assert.ok(pill, "the note lands in the composer as a pill");
  assert.equal(query(pill, ".annotation-pill-label").textContent, "Name these properly", "the pill wears the note, not the quote");
  assert.match(query(pill, ".annotation-card-quote").textContent, /src\/app\.ts:L2-L3/);
  assert.match(query(pill, ".annotation-card-quote").textContent, /\+const second = 22;/);
  assert.equal(view.container.querySelector(".diff-comment"), null, "commenting clears the selection");

  const marker = query<HTMLButtonElement>(view.container, ".diff-inline-comment-markers button"); assert.deepEqual([marker.textContent, view.container.querySelectorAll(".diff-line.commented").length], ["1", 2], "the range keeps the pill's numbered marker");
  await act(async () => { marker.click(); }); assert.equal(query<HTMLTextAreaElement>(view.container, ".diff-comment textarea").value, "Name these properly", "the marker reopens its note");
  await view.unmount();
});

test("ticking a file off folds its patch away and empties the tab's count", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);
  assert.ok(view.container.querySelectorAll(".diff-line").length > 0, "the patch is open");

  await act(async () => { query<HTMLInputElement>(view.container, 'input[aria-label="Mark src/app.ts viewed"]').click(); });

  assert.equal(view.container.querySelectorAll(".diff-line").length, 0);
  assert.match(query(view.container, ".diff-progress").textContent, /1 of 1 viewed/);
  assert.deepEqual([...view.container.querySelectorAll('.right-dock-tab [role="tab"]')].map((tab) => tab.textContent), ["Changes"]);
  await view.unmount();
});

test("the two-column view colours its lines the way the one-column view does", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);

  assert.ok(view.container.querySelector(".diff-split-row"), "a review opens in two columns");
  const coloured = [...view.container.querySelectorAll<HTMLElement>(".diff-split-cell code span")];
  assert.ok(coloured.some((token) => token.textContent === "const" && token.style.color === "var(--syntax-keyword)"));
  await view.unmount();
});

test("a comment can be taken from either column of the two-column view", async () => {
  seedReviewableProject();
  window.desktop = reviewableDesktop();
  const view = await mount(React.createElement(App));
  await openReview(view);

  const gutters = [...view.container.querySelectorAll<HTMLElement>(".diff-split-cell .diff-gutter")];
  /** Each side says what happened to its line, so the two columns never announce the same thing. */
  assert.deepEqual(gutters.map((gutter) => gutter.getAttribute("aria-label")), [
    "Add comment on unchanged line 1",
    "Add comment on unchanged line 1",
    "Add comment on removed line 2",
    "Add comment on added line 2",
    "Add comment on added line 3",
  ]);
  await act(async () => { item(gutters.find((gutter) => gutter.getAttribute("aria-label") === "Add comment on added line 3")).click(); });

  assert.match(query(view.container, ".diff-comment-range").textContent, /^src\/app\.ts:L3$/);
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
  assert.equal(query<HTMLButtonElement>(view.container, '.diff-side button').getAttribute("aria-label"), "Base: HEAD");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label^="Base"]').click(); });
  const options = [...document.querySelectorAll('.branch-menu [role="option"]')].map((option) => option.textContent);
  assert.equal(options[0], "HEAD", "the side that is not a branch comes first, inside the list");
  assert.ok(options.includes("origin/main"), "a remote branch can be a base");

  await act(async () => { item([...document.querySelectorAll<HTMLElement>('.branch-menu [role="option"]')].find((option) => option.textContent === "origin/main")).click(); });
  assert.deepEqual(sides(), ["origin/main", "Working tree"]);
  await view.unmount();
});
