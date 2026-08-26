import assert from "node:assert/strict";
import React, { act } from "react";
import { test, vi } from "vitest";
import type { Task } from "../../src/domain/task.ts";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import { mobileDesktopStub } from "../support/mobile-desktop.mts";

import { fireResizeObservers, item, mount, query } from "../support/renderer-dom.mts";

const { ConversationTimeline, groupTimeline, READING_SETTLE_MS } = await import("../../src/renderer/components/ConversationTimeline.tsx");

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
  /** The reader moving the view themselves, which is a scroll with one of their gestures behind it. */
  const scrollTo = async (top: number) => {
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    });
  };
  /** The virtualizer correcting this scroller once a row measures taller than its estimate. */
  const correctTo = async (top: number) => {
    await act(async () => {
      scroller.scrollTop = top;
      scroller.dispatchEvent(new Event("scroll"));
    });
  };
  /** The transcript places itself in a frame, which the shimmed one runs on a timer. */
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
  const resize = async () => act(async () => {
    fireResizeObservers();
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  return {
    scroller,
    scrolls,
    points,
    moves,
    thread,
    scrollTo,
    correctTo,
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

  await scrollTo(900);
  scrolls.length = 0;
  await resize();
  assert.deepEqual(scrolls, [], "the restored row stops holding once the reader moves");

  await done(view);
});

test("the virtualizer correcting its own estimates does not take the view from the thread being restored", async () => {
  const { scrolls, points, thread, scrollTo, correctTo, settle, resize, done } = threadHarness();

  const view = await mount(thread("read", 12));
  await settle();
  await scrollTo(300);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, READING_SETTLE_MS + 80)); });
  const left = item(points["read"]);

  await view.render(thread("other", 12, "o"));
  await settle();
  await view.render(thread("read", 12));
  await settle();

  /** A row measuring taller than its estimate moves this scroller without the reader touching it. */
  scrolls.length = 0;
  await correctTo(1800);
  await resize();
  assert.ok(scrolls.length >= 1, "the restore keeps placing the row it was asked to hold");

  await act(async () => { await new Promise((resolve) => setTimeout(resolve, READING_SETTLE_MS + 80)); });
  assert.deepEqual(points["read"], left, "the correction is never saved as where the reader was");

  await done(view);
});

test("find opens the fold the match it is showing was written into", async () => {
  const messages = transcript(
    { kind: "user", text: "Fix it" },
    { kind: "tool", text: "Bash", detail: "retry the build" },
    { kind: "assistant", text: "Done." },
  );
  const find: NonNullable<TimelineProps["find"]> = {
    target: { kind: "thread", taskId: null },
    query: "retry",
    index: 0,
    focus: 1,
    matches: 1,
    counting: false,
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
