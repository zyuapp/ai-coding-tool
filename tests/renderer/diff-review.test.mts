import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { DesktopAPI, RunCommand, TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { ThreadRequest, ThreadResponse } from "../../src/contracts/threads.ts";
import type { AutomationPatch, AutomationView } from "../../src/domain/automation.ts";
import type { WorkspaceRecord } from "../../src/domain/workspace.ts";
import { mobileDesktopStub } from "../support/mobile-desktop.mts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

const { App } = await import("../../src/renderer/App.tsx");

type MountView = Awaited<ReturnType<typeof mount>>;

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
    diffSummary: async (workspaceId, range) => ({ status: "available", range, ignoreWhitespace: false, files: [], additions: 0, deletions: 0 }),
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
      ignoreWhitespace: false,
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

test("hiding whitespace reads the comparison again, and the file that only moved leaves the list", async () => {
  seedReviewableProject();
  const asked: boolean[] = [];
  window.desktop = fakeDesktop({
    diffSummary: async (workspaceId, range, ignoreWhitespace = false) => {
      asked.push(ignoreWhitespace);
      return {
        status: "available",
        range,
        ignoreWhitespace,
        files: [
          { path: "src/app.ts", status: "modified", additions: 2, deletions: 1, binary: false },
          ...(ignoreWhitespace ? [] : [{ path: "src/spaced.ts", status: "modified" as const, additions: 1, deletions: 1, binary: false }]),
        ],
        additions: ignoreWhitespace ? 2 : 3,
        deletions: ignoreWhitespace ? 1 : 2,
      };
    },
    diffPatch: async () => ({ status: "available", patch: REVIEW_PATCH }),
  });
  const view = await mount(React.createElement(App));
  await openReview(view);

  const names = () => [...view.container.querySelectorAll(".diff-files .diff-file-name")].map((name) => name.textContent);
  assert.deepEqual(names(), ["src/app.ts", "src/spaced.ts"]);

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Hide whitespace changes"]').click(); });
  for (let turn = 0; turn < 100 && names().length > 1; turn += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  assert.deepEqual(asked, [false, true], "the same comparison is read again, counted without whitespace");
  assert.deepEqual(names(), ["src/app.ts"]);
  assert.equal(query(view.container, 'button[aria-label="Show whitespace changes"]').getAttribute("aria-pressed"), "true", "the button offers the way back");
  await view.unmount();
});
