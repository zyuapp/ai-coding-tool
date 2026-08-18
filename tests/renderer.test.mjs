import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "localStorage", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "navigator", "File", "Blob", "FileReader"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
for (const [name, value] of [["requestAnimationFrame", (fn) => setTimeout(() => fn(Date.now()), 0)], ["cancelAnimationFrame", (id) => clearTimeout(id)]]) {
  Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(dom.window, name, { configurable: true, value });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollTo = () => {};

const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
const { SessionPanel } = await vite.ssrLoadModule("/src/renderer/components/SessionPanel.tsx");
const { SideChat } = await vite.ssrLoadModule("/src/renderer/components/SideChat.tsx");
const { SubagentInspector } = await vite.ssrLoadModule("/src/renderer/components/SubagentInspector.tsx");
const { WorkspaceHeader } = await vite.ssrLoadModule("/src/renderer/components/WorkspaceHeader.tsx");
const { MarkdownMessage } = await vite.ssrLoadModule("/src/renderer/components/MarkdownMessage.tsx");
const { useTaskWorkspace } = await vite.ssrLoadModule("/src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await vite.ssrLoadModule("/src/renderer/App.tsx");
const { TaskComposer } = await vite.ssrLoadModule("/src/renderer/components/TaskComposer.tsx");
const { drawAnnotations, wrapLabel } = await vite.ssrLoadModule("/src/renderer/components/ImageAnnotator.tsx");
const { SettingsPanel } = await vite.ssrLoadModule("/src/renderer/components/SettingsPanel.tsx");
const { ConversationTimeline, groupTimeline } = await vite.ssrLoadModule("/src/renderer/components/ConversationTimeline.tsx");
const { AutomationPanel, automationStatusLabel, formatCountdown } = await vite.ssrLoadModule("/src/renderer/components/AutomationPanel.tsx");
const { ProjectSidebar } = await vite.ssrLoadModule("/src/renderer/components/ProjectSidebar.tsx");

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

const subagents = [
  { id: "working", description: "Working agent", status: "working", lastToolName: "Read", totalTokens: 321, startedAt: 1, activity: [] },
  { id: "complete", description: "Complete agent", status: "completed", summary: "Done", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "failed", description: "Failed agent", status: "failed", startedAt: 1, finishedAt: 2, activity: [] },
  { id: "stopped", description: "Stopped agent", status: "stopped", startedAt: 1, finishedAt: 2, activity: [] },
];

test("session panel renders Git and subagent states and selects an agent", async () => {
  let selected;
  const view = await mount(React.createElement(SessionPanel, {
    environment: { status: "available", files: [" M file"], branch: "main", additions: 4, deletions: 2 },
    hasProject: true,
    subagents,
    onSelect: (id) => { selected = id; },
  }));

  assert.match(view.container.textContent, /\+4−2/);
  assert.match(view.container.textContent, /main/);
  assert.match(view.container.textContent, /1 working/);
  await act(async () => { view.container.querySelector('button[aria-label="Open Working agent details"]').click(); });
  assert.equal(selected, "working");

  for (const [environment, message] of [
    [null, "Reopen the project to inspect Git"],
    [{ status: "unknown", workspaceId: "gone" }, "Workspace is no longer registered"],
    [{ status: "unavailable", reason: "missing" }, "Workspace is missing"],
    [{ status: "error", message: "git failed" }, "git failed"],
  ]) {
    await view.render(React.createElement(SessionPanel, { environment, hasProject: true, subagents: [], onSelect() {} }));
    assert.match(view.container.textContent, new RegExp(message));
  }
  await view.render(React.createElement(SessionPanel, { environment: null, hasProject: false, subagents: [], onSelect() {} }));
  assert.match(view.container.textContent, /Open a project to inspect Git/);
  await view.unmount();
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

test("side chat forks once and never changes the main continuation", async () => {
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const source = {
    id: "main-task",
    title: "Main task",
    executionPolicy: "confirm",
    messages: [],
    continuation: { provider: "claude", value: "main-session" },
    continuationStatus: "available",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
  };
  const view = await mount(React.createElement(SideChat, { source, onClose() {} }));
  const textarea = view.container.querySelector('textarea[aria-label="Side chat prompt"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;

  await act(async () => {
    setValue.call(textarea, "What does this code do?");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "What does this code do?" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { view.container.querySelector('button[aria-label="Send side chat message"]').click(); });
  const first = desktop.sent[0];
  assert.equal(first.channel, "side");
  assert.equal(first.forkContinuation, true);
  assert.deepEqual(first.continuation, { provider: "claude", value: "main-session" });

  await act(async () => {
    desktop.listener({ type: "continuation.updated", taskId: first.taskId, runId: first.runId, sequence: 1, continuation: { provider: "claude", value: "side-session" } });
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 2, status: "succeeded" });
  });
  await act(async () => {
    setValue.call(textarea, "Follow up");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Follow up" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { view.container.querySelector('button[aria-label="Send side chat message"]').click(); });

  assert.deepEqual(desktop.sent[1].continuation, { provider: "claude", value: "side-session" });
  assert.equal("forkContinuation" in desktop.sent[1], false);
  assert.deepEqual(source.continuation, { provider: "claude", value: "main-session" });
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
  let listener;
  let automationsChanged;
  let fireAutomation;
  let unsubscribed = false;
  return {
    sent,
    persisted,
    acknowledged,
    automationChanges,
    get listener() { return listener; },
    get automationsChanged() { return automationsChanged; },
    get fireAutomation() { return fireAutomation; },
    get unsubscribed() { return unsubscribed; },
    openFolder: async () => null,
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/scratch" }),
    commands: async () => ({ status: "available", commands: [] }),
    computerUsePermissions: async () => ({ accessibility: true, screenRecording: true }),
    enableComputerUse: async () => ({ accessibility: false, screenRecording: false }),
    restartForComputerUse() {},
    changedFiles: async () => ({ status: "available", files: [], branch: "main", additions: 0, deletions: 0 }),
    saveAttachment: async () => "/tmp/claudex-attachments/pasted.png",
    loadTaskStore: async () => null,
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
    ...overrides,
  };
}

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
  const view = await mount(React.createElement(SettingsPanel, { onClose() {} }));
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

test("slash command palette filters skills and supports keyboard selection", async () => {
  window.desktop = fakeDesktop({
    commands: async () => ({ status: "available", commands: [
      { name: "security-scan", description: "Scan the repository for security issues. Extra details are hidden.", argumentHint: "" },
      { name: "pdf", description: "Work with PDF files.", argumentHint: "<file>" },
    ] }),
  });
  let sends = 0;
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
  assert.equal(textarea.value, "/side");
  assert.equal(view.container.querySelector(".command-menu"), null);
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })); });
  assert.equal(sends, 1);
  dom.window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
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
  const add = view.container.querySelector('summary[aria-label="Add right panel tab"]');
  await act(async () => { add.click(); });
  await act(async () => { [...view.container.querySelectorAll('.right-dock-add button')].find((button) => button.textContent.includes("Side chat")).click(); });
  await act(async () => { add.click(); });
  await act(async () => { [...view.container.querySelectorAll('.right-dock-add button')].find((button) => button.textContent.includes("Side chat")).click(); });

  assert.equal(view.container.querySelectorAll('.right-dock [role="tab"]').length, 3);
  assert.equal(view.container.querySelectorAll('.side-chat').length, 2);
  assert.equal(view.container.querySelectorAll('.right-dock-content > div[hidden]').length, 3);
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

test("the composer offers only model choices, ordered most to least capable", async () => {
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(TaskComposer, {
    prompt: "",
    folder: "/project",
    workspaceId: "workspace-1",
    mode: "confirm",
    model: "opus",
    runActive: false,
    onPromptChange() {},
    onModeChange() {},
    onModelChange() {},
    onSend() {},
    onCancel() {},
  }));
  await act(async () => {});

  const menus = [...view.container.querySelectorAll(".setting-menu summary")].map((item) => item.getAttribute("aria-label"));
  assert.deepEqual(menus, ["Permission mode", "Model"]);
  const modelMenu = view.container.querySelectorAll(".setting-menu")[1];
  assert.deepEqual(
    [...modelMenu.querySelectorAll(".setting-option strong")].map((item) => item.textContent),
    ["Fable", "Opus", "Sonnet", "Haiku"],
  );
  assert.equal(modelMenu.querySelector(".setting-summary-label").textContent, "Opus");
  await view.unmount();
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
  const stored = desktop.persisted.flatMap((delta) => delta.tasks).findLast((change) => change.task.subagents?.length);
  assert.equal(stored.task.subagents[0].description, "Inspect");
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

function timelineView(messages, status) {
  const scroller = document.createElement("div");
  Object.defineProperty(scroller, "offsetWidth", { value: 860 });
  Object.defineProperty(scroller, "offsetHeight", { value: 900 });
  document.body.append(scroller);
  const task = {
    id: "t1", title: "T", executionPolicy: "confirm", messages,
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  };
  return React.createElement(ConversationTimeline, {
    currentTask: task, folder: "/p", status, compacting: false, scrollContainerRef: { current: scroller },
  });
}

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

  const settled = groupTimeline(messages, false);
  assert.deepEqual(settled.map((group) => group.kind), ["message", "turn", "message", "turn"]);
  assert.deepEqual(settled[1], { kind: "turn", id: "m1", steps: [], final: messages[1], live: false });
  assert.equal(settled[3].final, null);
  assert.equal(settled[3].steps.length, 2);

  const running = groupTimeline(messages, true);
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

test("a collapsed folder is revealed before the drag is measured, not after", async () => {
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

    assert.equal(shutList().className.includes("collapsed"), false, "the collapsed folder is revealed for the drag");
    assert.ok(measured.length > 0, "the library measured the collapsed folder");
    assert.equal(measured.includes("hidden"), false, `measured while still collapsed: ${measured.join(",")}`);
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = original;
  }
  await view.unmount();
});
