import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
for (const name of ["window", "document", "localStorage", "Element", "Node", "HTMLElement", "Event", "MouseEvent", "KeyboardEvent", "navigator"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollTo = () => {};

const vite = await createServer({ logLevel: "silent", server: { middlewareMode: true }, appType: "custom" });
const { SessionPanel } = await vite.ssrLoadModule("/src/renderer/components/SessionPanel.tsx");
const { SubagentInspector } = await vite.ssrLoadModule("/src/renderer/components/SubagentInspector.tsx");
const { WorkspaceHeader } = await vite.ssrLoadModule("/src/renderer/components/WorkspaceHeader.tsx");
const { useTaskWorkspace } = await vite.ssrLoadModule("/src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await vite.ssrLoadModule("/src/renderer/App.tsx");

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

test("workspace header exposes session and inspector controls", async () => {
  let sidebarToggles = 0;
  let summaryToggles = 0;
  let inspectorToggles = 0;
  const view = await mount(React.createElement(WorkspaceHeader, {
    folder: "/project",
    sidebarOpen: false,
    sessionPanelOpen: true,
    inspectorOpen: true,
    workingSubagents: 2,
    onToggleSidebar: () => { sidebarToggles += 1; },
    onToggleSessionPanel: () => { summaryToggles += 1; },
    onToggleInspector: () => { inspectorToggles += 1; },
  }));

  assert.equal(view.container.querySelector('button[aria-label="Hide session summary"]').getAttribute("aria-pressed"), "true");
  assert.match(view.container.textContent, /2/);
  await act(async () => {
    view.container.querySelector('button[aria-label="Show sidebar"]').click();
    view.container.querySelector('button[aria-label="Hide session summary"]').click();
    view.container.querySelector('button[aria-label="Hide subagent details"]').click();
  });
  assert.equal(sidebarToggles, 1);
  assert.equal(summaryToggles, 1);
  assert.equal(inspectorToggles, 1);
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
  let listener;
  let unsubscribed = false;
  return {
    sent,
    get listener() { return listener; },
    get unsubscribed() { return unsubscribed; },
    openFolder: async () => null,
    projectlessWorkspace: async () => ({ id: "projectless", kind: "projectless", root: "/scratch" }),
    changedFiles: async () => ({ status: "available", files: [], branch: "main", additions: 0, deletions: 0 }),
    send: (command) => sent.push(command),
    onAgentEvent: (next) => { listener = next; return () => { unsubscribed = true; }; },
    ...overrides,
  };
}

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

test("closing subagent details returns to the session panel", async () => {
  seedTaskWithSubagent();
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  await act(async () => { view.container.querySelector('button[aria-label="Show session summary"]').click(); });
  await act(async () => { view.container.querySelector('button[aria-label="Open Complete agent details"]').click(); });
  assert.ok(view.container.querySelector(".subagent-inspector"));
  await act(async () => { view.container.querySelector('button[aria-label="Close subagent details"]').click(); });
  assert.ok(view.container.querySelector('.session-panel button[aria-label="Open Complete agent details"]'));

  await view.unmount();
});

test("workspace hook runs a projectless task and scopes events, approvals, and cancellation", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Inspect the app"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const start = desktop.sent[0];
  assert.equal(start.type, "start");
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
  const stored = JSON.parse(localStorage.getItem("claudex.store.v2"));
  assert.equal(JSON.parse(stored.tasks).value[0].subagents[0].description, "Inspect");
  await workspace.view.unmount();
});
