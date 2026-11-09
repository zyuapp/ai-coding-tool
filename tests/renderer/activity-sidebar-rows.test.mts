import { renderProjectSidebar, seedProjectTasks } from "../support/sidebar.mts";
import { mountWorkspace } from "../support/workspace-renderer.mts";
import { automationView, fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import type { RunCommand } from "../../src/contracts/ipc.ts";

import type { Thread } from "../../src/domain/thread.ts";

import { dom, item, mount, query, rowHeights } from "../support/renderer-dom.mts";
import { settleFrame, settleUntil } from "../support/settle.mts";

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

const { App } = await import("../../src/renderer/App.tsx");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

const thread = (id: string, overrides: Partial<Thread> = {}): Thread => ({
  id, title: id, engine: "claude", executionPolicy: "confirm", messages: [],
  continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, rankedAt: 1, updatedAt: 1, ...overrides,
});

test("the sidebar ranks threads into priority, running, and the rest, and only priority dismisses", async () => {
  const dismissed: string[] = [];
  let clearedAll = 0;
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "project-1", root: "/work/project" }],
    runningThreadIds: new Set(["busy", "asked"]),
    monitoringThreadIds: new Set(["watching"]),
    blockedThreadIds: new Set(["asked"]),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: {
      priority: [thread("asked", { projectId: "project-1" }), thread("unread", { outcome: "finished", outcomeUnread: true }), thread("seen", { outcome: "finished" })],
      running: [thread("busy"), thread("watching", { outcome: "finished", outcomeUnread: true })],
      threads: [thread("quiet")],
      snoozed: [],
    },
    onDismissThread: (taskId) => { dismissed.push(taskId); },
    onDismissAll: () => { clearedAll += 1; },
  }));

  const listed = (label: string) => [...view.container.querySelectorAll(`nav[aria-label="${label}"] .task-row-text > span`)].map((row) => row.textContent);
  assert.deepEqual(listed("Priority"), ["asked", "unread", "seen"]);
  assert.deepEqual(listed("Running"), ["busy", "watching"]);
  assert.equal(view.container.querySelectorAll('nav[aria-label="Running"] .task-spinner').length, 1, "only the thread with a run spins");
  assert.ok(query(view.container, 'nav[aria-label="Running"] [aria-label="Monitoring"]'), "a thread its background work will wake says so in place of its unread verdict");
  assert.equal(view.container.querySelector('nav[aria-label="Running"] .task-attention.finished'), null);
  assert.deepEqual(listed("Threads"), ["quiet"]);

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
    [...view.container.querySelectorAll('nav[aria-label="Priority"] .row-action:not(.task-more)')].map((button) => button.getAttribute("aria-label")),
    ["Dismiss unread", "Dismiss seen"],
    "the priority list trades archive for dismiss, and a question has nothing to dismiss",
  );
  assert.deepEqual(
    [...view.container.querySelectorAll('nav[aria-label="Running"] .row-action:not(.task-more), nav[aria-label="Threads"] .row-action:not(.task-more)')],
    [],
    "and the other two offer nothing, rather than a second icon meaning something else",
  );

  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Dismiss seen"]').click(); });
  assert.deepEqual(dismissed, ["seen"], "a read row still offers to be filed away");

  await act(async () => { query<HTMLButtonElement>(view.container, '.dismiss-all').click(); });
  assert.equal(clearedAll, 1);
  await view.unmount();
});

test("a row marks and says what waits on the user, as the lists word it", async () => {
  const rows = [thread("suggests", { role: "coordinator" }), thread("quiet", { role: "coordinator" })];
  const said = "A decision and a suggested thread are waiting on you";
  const view = await mount(renderProjectSidebar({
    activityThreads: { priority: rows.slice(0, 1), running: [], threads: rows.slice(1), snoozed: [] },
    sidebarCoordination: { threadsByCoordinator: new Map(), waitingLines: new Map([["suggests", said]]), coordinatorsByComputer: new Map([[null, rows]]), onSetCoordinator() {}, notifications: true, onSetMuted() {}, stoppable: new Set<string>(), onStopAll() {} },
  }));
  assert.deepEqual([...view.container.querySelectorAll(".task-attention.approval")].map((mark) => mark.getAttribute("aria-label")), [said]);
  assert.equal(query(view.container, 'nav[aria-label="Priority"] .task-row-text > small').textContent, said, "and says so under its title");
  await view.unmount();
});

test("what waits on the user outranks a coordinator's threads at work, and only a row with something to file away offers Dismiss", async () => {
  const said = "A suggested thread is waiting on you";
  const waits = thread("waits", { role: "coordinator", projectId: "p" });
  const worker = thread("worker", { parentId: "waits", projectId: "p" });
  const filed = thread("filed", { role: "coordinator", projectId: "p" });
  const finished = thread("finished", { parentId: "filed", projectId: "p", outcome: "finished" });
  const coordination = { threadsByCoordinator: new Map([["waits", [worker]], ["filed", [finished]]]), waitingLines: new Map([["waits", said]]), coordinatorsByComputer: new Map([[null, [waits, filed]]]), onSetCoordinator() {}, notifications: true, onSetMuted() {}, stoppable: new Set<string>(), onStopAll() {} };
  const activity = await mount(renderProjectSidebar({
    activityThreads: { priority: [waits, filed], running: [], threads: [], snoozed: [] }, runningThreadIds: new Set(["worker"]), sidebarCoordination: coordination,
  }));
  assert.deepEqual([...activity.container.querySelectorAll('nav[aria-label="Priority"] .row-action:not(.task-more)')].map((button) => button.getAttribute("aria-label")), ["Dismiss filed"], "what waits on the user is answered, not dismissed");
  assert.ok(activity.container.querySelector('.dismiss-all'), "Dismiss all counts a coordinator held by a thread under it, which it files away");
  await activity.render(renderProjectSidebar({ activityThreads: { priority: [waits], running: [], threads: [], snoozed: [] }, sidebarCoordination: coordination }));
  assert.equal(activity.container.querySelector('.dismiss-all'), null, "and offers nothing when there is nothing to file away");
  await activity.unmount();
});

test("a row whose role or engine only a newer build knows draws without those marks", async () => {
  const rows = [thread("designer", { role: "designer" as never }), thread("gemini", { engine: "gemini" as never })];
  const view = await mount(renderProjectSidebar({ activityThreads: { priority: [], running: [], threads: rows, snoozed: [] } }));
  assert.deepEqual([...view.container.querySelectorAll('nav[aria-label="Threads"] .task-row-text > span')].map((row) => row.textContent), ["designer", "gemini"]);
  await view.unmount();
});

test("only the priority heading offers to dismiss every dot at once", async () => {
  const sidebar = (priority: Thread[]) => renderProjectSidebar({ activityThreads: { priority, running: [], threads: [], snoozed: [] } });

  const view = await mount(sidebar([]));
  assert.equal(view.container.querySelector('.dismiss-all'), null, "no dot to take off, so the heading offers nothing");

  await view.render(sidebar([thread("done", { outcome: "failed" })]));
  assert.equal(view.container.querySelector('.dismiss-all')?.getAttribute("aria-label"), "Dismiss 1 thread", "one dot is enough to offer it, and the label says how many it clears");
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
  const view = await mount(React.createElement(App));
  try {
    const row = (title: string) => item(query(view.container, `.task-row [data-tip="${title}"]`).closest<HTMLElement>(".task-row"));
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
    assert.ok(query(view.container, 'nav[aria-label="Priority"] .task-row [data-tip="Streaming task"]'));
    assert.equal(quietFormats, beforeStreaming, "a row that did not change is not drawn again");
    await act(async () => { row("Quiet task").click(); });
    assert.ok(row("Quiet task").classList.contains("active"), "selection updates after streaming");
    assert.ok(quietFormats > beforeStreaming, "a row that changed is drawn again");
  } finally {
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", originalFormat);
    await view.unmount();
  }
});

test("dismissing a thread in the sidebar takes its dot off for good", async () => {
  seedProjectTasks([
    { id: "quiet", title: "Quiet task", sortIndex: 0, updatedAt: 5, createdAt: 5 },
    { id: "settled", title: "Settled task", sortIndex: 1, updatedAt: 9, createdAt: 9, outcome: "finished", outcomeUnread: true },
  ]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

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

  await view.unmount();
});

test("the sidebar marks each thread's engine, schedule, and checkout", async () => {
  const task = (id: string, projectId?: string, engine: Thread["engine"] = "claude"): Thread => thread(id, { ...(projectId ? { projectId } : {}), engine, sortIndex: 0 });
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "project-1", root: "/project" }],
    schedules: new Map([["scheduled-task", automationView({ taskId: "scheduled-task" })], ["scheduled-chat", automationView({ taskId: "scheduled-chat" })]]),
    worktreeThreadIds: new Set(["plain-task"]),
    activityThreads: { priority: [], running: [], threads: [task("scheduled-task", "project-1"), task("plain-task", "project-1", "codex"), task("scheduled-chat"), task("plain-chat", undefined, "codex")], snoozed: [] },
  }));

  const marks = (label: string) => [...view.container.querySelectorAll(`[aria-label="${label}"]`)]
    .map((icon) => item(icon.closest(".task-entry")?.querySelector(".task-row-text > span")).textContent)
    .sort();

  assert.deepEqual(marks("Runs on a schedule"), ["scheduled-chat", "scheduled-task"]);
  assert.deepEqual(marks("Works in a worktree"), ["plain-task"], "a thread with its own checkout is marked wherever it is listed");
  assert.deepEqual(marks("Claude thread"), ["scheduled-chat", "scheduled-task"]);
  assert.deepEqual(marks("Codex thread"), ["plain-chat", "plain-task"]);
  await view.unmount();
});

test("the sidebar follows the thread the keyboard steps to", async () => {
  const scrolled: Array<{ className: string; options?: boolean | ScrollIntoViewOptions }> = [];
  const original = dom.window.HTMLElement.prototype.scrollIntoView;
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled.push({ className: this.className, options }); };
  const sidebar = (currentId: string | null) => renderProjectSidebar({
    currentId,
    activityThreads: { priority: [], running: [], threads: [thread("first"), thread("second")], snoozed: [] },
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
    canGoBack: true,
    canGoForward: false,
    onGoBack: () => { backSteps += 1; },
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

test("a row's rail reserves slots only for the marks of threads the sidebar draws", async () => {
  const marked = thread("marked", { role: "reviewer", worktreeId: "wt-1", projectId: "project-1" });
  const plain = thread("plain", { projectId: "project-1" });
  const props = {
    projects: [{ id: "project-1", root: "/work/project" }],
    worktreeThreadIds: new Set(["marked"]),
    activityThreads: { priority: [plain], running: [], threads: [marked], snoozed: [] },
  };
  const slots = (view: { container: HTMLElement }) => query<HTMLElement>(view.container, ".sidebar").style.getPropertyValue("--row-slots");
  const sections = { priority: true, running: true, threads: true, snoozed: true };

  const view = await mount(renderProjectSidebar({ ...props, sections }));
  assert.equal(slots(view), "3", "the role, the checkout, and the engine");
  await view.render(renderProjectSidebar({ ...props, sections: { ...sections, threads: false } }));
  assert.equal(slots(view), "1", "a folded list's threads draw no row to make room for");
  await view.unmount();
});

test("a rail counts the away mark and leaves out an engine mark the row does not draw", async () => {
  const sections = { priority: true, running: true, threads: true, snoozed: true };
  const slots = (view: { container: HTMLElement }) => query<HTMLElement>(view.container, ".sidebar").style.getPropertyValue("--row-slots");
  const away = thread("away", { role: "reviewer" });
  const unknown = thread("unknown", { role: "reviewer", worktreeId: "wt-1", engine: "gemini" as Thread["engine"] });
  const props = {
    sections,
    worktreeThreadIds: new Set(["unknown"]),
    threadHosts: new Map([["away", { id: "studio", name: "Studio", offline: true }]]),
  };

  const view = await mount(renderProjectSidebar({ ...props, activityThreads: { priority: [], running: [], threads: [away], snoozed: [] } }));
  assert.equal(slots(view), "3", "the away mark, the role, and the engine");
  assert.equal(view.container.querySelectorAll(".row-marks > .row-mark").length, 3);

  await view.render(renderProjectSidebar({ ...props, activityThreads: { priority: [], running: [], threads: [unknown], snoozed: [] } }));
  assert.equal(slots(view), "2", "the role and the checkout, with no engine mark drawn");
  assert.equal(view.container.querySelectorAll(".row-marks > .row-mark").length, 2);
  await view.unmount();
});

test("a background run's tool call redraws only its own row", async (t) => {
  const quietTimes = new Set([200_000, 300_000, 400_000]);
  seedProjectTasks([
    { id: "busy", title: "Busy task", sortIndex: 0, updatedAt: 2, createdAt: 2, projectId: undefined },
    { id: "quiet-1", title: "Quiet task", sortIndex: 1, updatedAt: 200_000, createdAt: 200_000, projectId: undefined },
    { id: "quiet-2", title: "Other quiet task", sortIndex: 2, updatedAt: 300_000, createdAt: 300_000, projectId: undefined },
    { id: "quiet-3", title: "Scheduled checkout task", sortIndex: 3, updatedAt: 400_000, createdAt: 400_000, worktreeId: "wt-1" },
  ]);
  const store = JSON.parse(localStorage.getItem("aicodingtool.store.v2")!) as Record<string, string>;
  const worktree = { id: "wt-1", projectId: "project-1", root: "/worktrees/project-wt1", workspaceId: "ws-wt1", baseCommit: "abcdef1", createdAt: 1, lastUsedAt: 1 };
  localStorage.setItem("aicodingtool.store.v2", JSON.stringify({ ...store, worktrees: JSON.stringify({ version: 2, value: [worktree] }) }));
  const heights = rowHeights((element) => element.classList.contains("conversation") ? 900 : 0);
  t.onTestFinished(() => heights.restore());
  const desktop = fakeDesktop({ listAutomations: async () => [automationView({ taskId: "quiet-3" })] });
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  const row = (title: string) => item([...view.container.querySelectorAll<HTMLElement>(".task-row")].find((entry) => entry.querySelector<HTMLElement>("[data-tip-overflow]")?.dataset.tip === title));

  await act(async () => { row("Busy task").click(); });
  const textarea = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Task prompt"]');
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  await act(async () => {
    textarea.focus();
    item(setValue).call(textarea, "Inspect the app");
    textarea.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Send task"]').click(); });
  await settleUntil(() => desktop.sent.some((command) => command.type === "start"), "the run did not start");
  const start = desktop.sent.find((command): command is Extract<RunCommand, { type: "start" }> => command.type === "start")!;
  await act(async () => { row("Quiet task").click(); });
  await settleFrame();
  const checkoutRow = row("Scheduled checkout task");
  assert.ok(query(checkoutRow, ".task-worktree.worktree-mark") && query(checkoutRow, ".task-automation"), "the checkout row carries its worktree and schedule");

  const formatted: unknown[] = [];
  const originalFormat = item(Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format"));
  Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
    ...originalFormat,
    get(this: Intl.DateTimeFormat) {
      const format = item(originalFormat.get).call(this) as Intl.DateTimeFormat["format"];
      return (value?: number | Date) => { formatted.push(value); return format(value); };
    },
  });
  let sequence = 0;
  const toolCall = async () => {
    formatted.length = 0;
    sequence += 1;
    await act(async () => { desktop.listener({ type: "tool.intent", taskId: start.taskId, runId: start.runId, sequence, intent: { toolId: `tool-${sequence}`, name: "Read", input: { file_path: "src/App.tsx" } } }); });
    await settleFrame();
    assert.ok(formatted.length > 0, "the busy row is drawn again");
    assert.equal(formatted.some((value) => quietTimes.has(value as number)), false, "the quiet rows are left alone");
  };
  try {
    await toolCall();
    assert.ok(query(row("Busy task"), ".task-spinner"), "the busy row keeps its spinner");
    assert.ok(row("Quiet task").classList.contains("active"));

    await act(async () => { row("Other quiet task").click(); });
    assert.ok(row("Other quiet task").classList.contains("active"), "selection still moves the active row");
    assert.equal(row("Quiet task").classList.contains("active"), false);
    await act(async () => { row("Busy task").dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
    assert.ok(document.querySelector(".context-menu-popover"), "the busy row still opens its menu");
  } finally {
    Object.defineProperty(Intl.DateTimeFormat.prototype, "format", originalFormat);
    await view.unmount();
  }
});
