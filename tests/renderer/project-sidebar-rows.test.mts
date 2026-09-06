import { renderProjectSidebar, seedProjectTasks } from "../support/sidebar.mts";
import { mountWorkspace } from "../support/workspace-renderer.mts";
import { automationView, fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { RunCommand } from "../../src/contracts/ipc.ts";

import type { Thread } from "../../src/domain/thread.ts";

import { dom, item, mount, query, rowHeights } from "../support/renderer-dom.mts";
import { settleFrame, settleUntil } from "../support/settle.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");
const { App } = await import("../../src/renderer/App.tsx");
const { ProjectSidebar } = await import("../../src/renderer/components/ProjectSidebar.tsx");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

test("activity mode ranks threads into priority, running, and the rest, and only priority dismisses", async () => {
  const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id, title: id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, ...overrides,
  });
  const dismissed: string[] = [];
  let clearedAll = 0;
  const view = await mount(renderProjectSidebar({
    open: true,
    inactive: false,
    projects: [{ id: "project-1", root: "/work/project" }],
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(["busy", "asked"]),
    blockedThreadIds: new Set(["asked"]),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: {
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
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onRenameThread() {},
    onDismissThread: (taskId) => { dismissed.push(taskId); },
    onDismissAll: () => { clearedAll += 1; },
    onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
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
  const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id, title: id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, ...overrides,
  });
  const sidebar = (priority: Thread[]) => renderProjectSidebar({
    open: true,
    inactive: false,
    projects: [],
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority, running: [], threads: [] },
    mode: "activity",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onRenameThread() {}, onDismissThread() {}, onDismissAll() {},
    onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar([]));
  assert.equal(view.container.querySelector('[aria-label="Dismiss all"]'), null, "no dot to take off, so the heading offers nothing");

  await view.render(sidebar([thread("done", { outcome: "failed" })]));
  assert.ok(view.container.querySelector('[aria-label="Dismiss all"]'), "one dot is enough to offer it");
  await view.unmount();
});

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

test("typing and streaming leave sidebar rows alone while sidebar changes still render", async (t) => {
  const quietAt = 123_456;
  seedProjectTasks([
    { id: "streaming", title: "Streaming task", sortIndex: 0, updatedAt: 2, createdAt: 2 },
    { id: "quiet", title: "Quiet task", sortIndex: 1, updatedAt: quietAt, createdAt: quietAt },
  ]);
  const heights = rowHeights((element) => element.classList.contains("conversation") ? 900 : 0);
  t.onTestFinished(() => heights.restore());
  const desktop = fakeDesktop({ openFolder: async () => ({ id: "project-1", kind: "project", root: "/project" }) });
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  /** Count a quiet row's displayed date, so unchanged DOM cannot hide repeated rendering work. */
  let quietFormats = 0;
  const originalFormat = item(Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format"));
  Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
    ...originalFormat,
    get(this: Intl.DateTimeFormat) {
      const format = item(originalFormat.get).call(this) as Intl.DateTimeFormat["format"];
      return (value?: number | Date) => { if (value === quietAt) quietFormats += 1; return format(value); };
    },
  });
  try {
    const row = (title: string) => query<HTMLElement>(view.container, `.task-row[title="${title}"]`);
    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Rank threads by activity"]').click(); });
    await act(async () => { row("Streaming task").click(); });
    await settleFrame();
    assert.ok(quietFormats > 0, "the quiet row was rendered before the measurement");

    const beforeTyping = quietFormats;
    const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
    const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
    await act(async () => {
      textarea.focus();
      item(setValue).call(textarea, "Inspect the app");
      textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const send = query<HTMLButtonElement>(view.container, '[aria-label="Send task"]');
    assert.equal(send.disabled, false, "typing reached the workspace");
    assert.equal(quietFormats, beforeTyping, "typing does not revisit the sidebar rows");

    await act(async () => { send.click(); });
    await settleUntil(() => desktop.sent.some((command) => command.type === "start"), "the run did not start");
    const start = startCommand(desktop.sent.find((command) => command.type === "start"));
    assert.equal(start.taskId, "streaming");
    assert.ok(query(view.container, 'nav[aria-label="Running"] .task-spinner'), "starting a run updates its sidebar status");
    await settleFrame();
    const beforeStreaming = quietFormats;
    for (const [index, text] of ["An answer", "An answer is", "An answer is streaming"].entries()) {
      await act(async () => { desktop.listener({ type: "assistant.tail", taskId: start.taskId, runId: start.runId, sequence: index + 1, messageId: "answer", text }); });
      await settleFrame();
      assert.equal(quietFormats, beforeStreaming, "streaming does not revisit the sidebar rows");
    }
    assert.match(query(view.container, ".timeline").textContent, /An answer is streaming/, "the streamed text still updates");

    await act(async () => { desktop.listener({ type: "run.status", taskId: start.taskId, runId: start.runId, sequence: 4, status: "succeeded" }); });
    await settleFrame();
    assert.equal(view.container.querySelector(".task-spinner"), null, "finishing removes the running mark");
    assert.ok(query(view.container, 'nav[aria-label="Priority"] .task-row[title="Streaming task"]'));
    assert.ok(quietFormats > beforeStreaming, "a changed sidebar is rendered again");
    await act(async () => { row("Quiet task").click(); });
    assert.ok(row("Quiet task").classList.contains("active"), "selection updates after streaming");
  } finally {
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", originalFormat);
    await view.unmount();
  }
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

test("the sidebar lists a project's threads as one list, and its menu starts another in a checkout", async () => {
  const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
    id, title: id, projectId: "project-1", engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1, ...overrides,
  });
  const worktree = { id: "wt1", projectId: "project-1", root: "/worktrees/project-wt1", workspaceId: "ws-1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 };
  const started: Array<[string | undefined, string | undefined]> = [];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedThreads: [thread("in-checkout", { worktreeId: "wt1" }), thread("in-project")],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [{ worktree, threads: [thread("in-checkout", { worktreeId: "wt1" })] }],
    worktreeThreadIds: new Set(["in-checkout"]),
    activityThreads: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: "project:project-1",
    settingsOpen: false,
    onNewThread(projectId, worktreeId) { started.push([projectId, worktreeId]); },
    onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onDismissThread() {}, onDismissAll() {}, onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
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

test("the sidebar marks each thread's engine, schedule, and checkout", async () => {
  const task = (id: string, projectId?: string, engine: Thread["engine"] = "claude"): Thread => ({
    id, title: id, ...(projectId ? { projectId } : {}), engine, executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedThreads: [task("scheduled-task", "project-1"), task("plain-task", "project-1", "codex")],
    recentThreads: [task("scheduled-chat"), task("plain-chat", undefined, "codex")],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map([["scheduled-task", automationView({ taskId: "scheduled-task" })], ["scheduled-chat", automationView({ taskId: "scheduled-chat" })]]),
    worktreeGroups: [],
    worktreeThreadIds: new Set(["plain-task"]),
    activityThreads: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onDismissThread() {}, onDismissAll() {}, onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  const marks = (label: string) => [...view.container.querySelectorAll(`[aria-label="${label}"]`)]
    .map((icon) => item(icon.closest("[data-rfd-draggable-id]")).getAttribute("data-rfd-draggable-id"))
    .sort();

  assert.deepEqual(marks("Runs on a schedule"), ["scheduled-chat", "scheduled-task"]);
  assert.deepEqual(marks("Works in a worktree"), ["plain-task"], "a thread with its own checkout is marked wherever it is listed");
  assert.deepEqual(marks("Claude thread"), ["scheduled-chat", "scheduled-task"]);
  assert.deepEqual(marks("Codex thread"), ["plain-chat", "plain-task"]);
  await view.unmount();
});

test("the sidebar follows the thread the keyboard steps to", async () => {
  const thread = (id: string): Thread => ({
    id, title: id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  });
  const scrolled: Array<{ className: string; options?: boolean | ScrollIntoViewOptions }> = [];
  const original = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ className: this.className, options }); };
  const sidebar = (currentId: string | null) => renderProjectSidebar({
    open: true,
    inactive: false,
    projects: [],
    orderedThreads: [thread("first"), thread("second")],
    recentThreads: [thread("first"), thread("second")],
    currentId,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: false,
    canGoForward: false,
    onGoBack() {}, onGoForward() {},
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onRenameThread() {},
    onDismissThread() {}, onDismissAll() {},
    onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar("first"));
  await view.render(sidebar("second"));
  dom.window.HTMLElement.prototype.scrollIntoView = original;

  assert.deepEqual(scrolled.at(-1), { className: "task-row active", options: { block: "nearest" } }, "the row now open is brought into view");
  await view.unmount();
});

test("the sidebar steps through visited threads", async () => {
  let backSteps = 0;
  const view = await mount(renderProjectSidebar({
    open: false,
    inactive: false,
    projects: [],
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    canGoBack: true,
    canGoForward: false,
    onGoBack: () => { backSteps += 1; },
    onGoForward() {},
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onDismissThread() {}, onDismissAll() {}, onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  assert.ok(query<HTMLButtonElement>(view.container, 'button[aria-label="Go forward"]').disabled, "nothing ahead to go forward to");
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Go back"]').click(); });
  assert.equal(backSteps, 1);
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
  await settleFrame();
  assert.equal(item(workspace.get().currentThread).outcome, "finished");
  assert.equal(item(workspace.get().currentThread).outcomeUnread, undefined);

  await act(async () => { window.dispatchEvent(new Event("focus")); });
  assert.equal(item(workspace.get().currentThread).outcomeUnread, undefined, "and coming back finds nothing marked");
  await workspace.view.unmount();
});
