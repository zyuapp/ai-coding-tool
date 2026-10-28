import { subagents } from "../support/subagents.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { AppCommand } from "../../src/contracts/commands.ts";
import type { InstalledApp } from "../../src/contracts/ipc.ts";
import { NO_PULL_REQUEST } from "../../src/domain/pull-request.ts";
import { OPEN_SUBAGENT_GROUPS, type BackgroundProcess, type Subagent, type SubagentActivity } from "../../src/domain/run.ts";
import type { Thread } from "../../src/domain/thread.ts";

import type { SessionPanelProps } from "../../src/renderer/components/SessionPanel.tsx";

import { dom, item, mount, pumpResizeObservers, query, rowHeights, sizeOf } from "../support/renderer-dom.mts";

/** A session card row, found by the label it shows. */
function sessionRow(container: Element, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button.session-row")].find((row) => row.querySelector(":scope > span:nth-of-type(2)")?.textContent === label);
}

function agentRow(container: Element, name: string) {
  const row = [...container.querySelectorAll<HTMLButtonElement>(".agent-row")].find((button) => button.querySelector("strong")?.textContent === name);
  assert.ok(row, `no subagent row named ${name}`);
  return row;
}

const { MemberPullRequestList, SessionPanel } = await import("../../src/renderer/components/SessionPanel.tsx");
const { MemberWorktreeList } = await import("../../src/renderer/components/Coordination.tsx");
const { SubagentInspector } = await import("../../src/renderer/components/SubagentInspector.tsx");
const { AgentsPanel, matchSubagents } = await import("../../src/renderer/components/SubagentList.tsx");
const { WorkspaceHeader } = await import("../../src/renderer/components/WorkspaceHeader.tsx");
const { OpenInMenu } = await import("../../src/renderer/components/OpenInMenu.tsx");
const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");

function renderSessionPanel(overrides: Partial<SessionPanelProps>) {
  return React.createElement(SessionPanel, {
    environment: null,
    hasProject: false,
    pullRequest: NO_PULL_REQUEST,
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
    onCheckoutBranch() {},
    ...overrides,
  });
}

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

const member = (id: string, title: string): Thread => ({ id, title, engine: "claude", executionPolicy: "allow-edits", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, parentId: "lead" });

test("a coordinator's session panel keeps its own rows and adds its threads' worktrees and pull requests", async () => {
  window.desktop = fakeDesktop();
  const revealed: string[] = [];
  const deleted: string[] = [];
  const view = await mount(renderSessionPanel({
    hasProject: true,
    children: [
      React.createElement(MemberWorktreeList, {
        key: "worktrees",
        worktrees: [
          { id: "wt-1", root: "/tmp/wt-1", name: "dark-mode", branch: "dark", threads: [member("a", "Dark mode")], busy: false, deleting: false },
          { id: "wt-2", root: "/tmp/wt-2", name: "login", branch: null, threads: [member("b", "Login flake")], busy: true, deleting: false },
        ],
        onReveal: (root: string) => { revealed.push(root); },
        onDelete: (root: string) => { deleted.push(root); },
      }),
      React.createElement(MemberPullRequestList, {
        key: "pull-requests",
        pullRequests: [{ pullRequest: { number: 12, title: "Add dark mode", url: "https://github.com/o/r/pull/12", state: "open" }, threads: [member("a", "Dark mode")] }],
      }),
    ],
  }));
  assert.ok(item(sessionRow(view.container, "Changes")), "a coordinator has its own changes row again");
  assert.ok(item(sessionRow(view.container, "Automations")));
  assert.equal(view.container.querySelector('[aria-label="Threads under this coordinator"]'), null, "its threads live in the Overview");

  const worktrees = query(view.container, '[aria-label="Worktrees these threads work in"]');
  assert.match(worktrees.textContent, /dark-modedark · Dark mode/);
  await act(async () => { query<HTMLButtonElement>(worktrees, 'button[aria-label="Reveal dark-mode"]').click(); });
  await act(async () => { query<HTMLButtonElement>(worktrees, 'button[aria-label="Delete dark-mode"]').click(); });
  assert.deepEqual([revealed, deleted], [["/tmp/wt-1"], ["/tmp/wt-1"]]);
  assert.equal(query<HTMLButtonElement>(worktrees, 'button[aria-label="Delete login"]').disabled, true, "a checkout with a run going cannot be deleted");

  const link = query<HTMLAnchorElement>(query(view.container, '[aria-label="Pull requests from these threads"]'), "a");
  assert.equal(link.href, "https://github.com/o/r/pull/12");
  assert.match(link.textContent, /Add dark mode#12 · Open · Dark mode/);
  await view.unmount();
});

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
  await act(async () => { agentRow(view.container, "Working agent").click(); });
  assert.equal(selected, "working");

  const automations = item(sessionRow(view.container, "Automations"));
  assert.equal(query(automations, ".session-count").textContent, "1", "the card only counts automations");
  assert.equal(automations.querySelector("input.automation-schedule"), null, "editing happens in the sliding panel");
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
  assert.equal((sessionRow(view.container, "Changes") ?? null), null, "a thread with no folder has no changes to review");
  assert.equal((sessionRow(view.container, "Branch") ?? null), null, "nor a branch");
  assert.doesNotMatch(view.container.textContent, /Git/);
  assert.ok(item(sessionRow(view.container, "Automations")), "automations need no folder");
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
  const stopping = query<HTMLButtonElement>(view.container, 'button[aria-label="Stopping Deploy events"]');
  assert.equal(stopping.disabled, true, "a stop already asked for cannot be asked for twice");
  assert.ok(stopping.querySelector("svg.spinning"), "and turns while the process winds down");
  assert.equal(query<HTMLButtonElement>(view.container, 'button[aria-label="Stop npm run dev"]').querySelector("svg.spinning"), null);

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
    { id: "d", description: "Ready reviewer", status: "idle", summary: "Ready for follow-up", startedAt: 4, activity: [] },
  ];

  assert.deepEqual(matchSubagents(subagents, null, "").map((subagent) => subagent.id), ["c", "b", "d", "a"], "failures lead, followed by active and resumable agents");
  assert.deepEqual(matchSubagents(subagents, null, "   ").map((subagent) => subagent.id), ["c", "b", "d", "a"], "an empty search is not a filter");
  assert.deepEqual(matchSubagents(subagents, "working", "").map((subagent) => subagent.id), ["b"]);
  assert.deepEqual(matchSubagents(subagents, "idle", "").map((subagent) => subagent.id), ["d"]);
  assert.deepEqual(matchSubagents(subagents, null, "LOADER").map((subagent) => subagent.id), ["b"], "case never decides a match");
  assert.deepEqual(matchSubagents(subagents, null, "grep").map((subagent) => subagent.id), ["b"], "the tool a subagent is using is searchable");
  assert.deepEqual(matchSubagents(subagents, "failed", "loader"), []);
});

test("subagent details show provider metadata and the exact expandable prompt", async () => {
  const prompt = "  First instruction\n\n" + "Keep this line.\n".repeat(1_000) + "  Last instruction  ";
  const subagent: Subagent = { ...subagents[0], model: "gpt-6-astra", effort: "xhigh", prompt };
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose() {}, onStop() {} }));
  assert.deepEqual([...view.container.querySelectorAll(".agent-configuration dd")].map((node) => node.textContent), ["gpt-6-astra", "Extra high"]);
  const details = query<HTMLDetailsElement>(view.container, ".agent-prompt");
  assert.equal(details.open, false);
  await act(async () => { query<HTMLElement>(details, "summary").click(); });
  assert.equal(details.open, true);
  assert.equal(query(details, "pre").textContent, prompt);
  await view.render(React.createElement(SubagentInspector, { subagent: subagents[0], onClose() {}, onStop() {} }));
  assert.deepEqual([...view.container.querySelectorAll(".agent-configuration dd")].map((node) => node.textContent), ["Not reported", "Not reported"]);
  assert.equal(query(view.container, ".agent-prompt p").textContent, "Not reported");
  await view.render(React.createElement(SubagentInspector, { subagent, finding: true, onClose() {}, onStop() {} }));
  assert.equal(query<HTMLDetailsElement>(view.container, ".agent-prompt").open, true);
  await view.unmount();
});

test("a working subagent can be stopped from its details, once", async () => {
  const stopped: string[] = [];
  const subagent: Subagent = { id: "agent-1", description: "Review", status: "working", startedAt: 1, activity: [] };
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose() {}, onStop: (id: string) => { stopped.push(id); } }));
  await act(async () => { query<HTMLButtonElement>(view.container, ".workflow-stop").click(); });
  assert.deepEqual(stopped, ["agent-1"]);
  await view.render(React.createElement(SubagentInspector, { subagent: { ...subagent, stopping: true }, onClose() {}, onStop() {} }));
  assert.equal(query<HTMLButtonElement>(view.container, ".workflow-stop").disabled, true);
  assert.equal(query(view.container, ".workflow-stop").textContent, "Stopping…");
  await view.render(React.createElement(SubagentInspector, { subagent: { ...subagent, status: "completed" }, onClose() {}, onStop() {} }));
  assert.equal(view.container.querySelector(".workflow-stop"), null);
  await view.unmount();
});

test("Escape closes the subagent details unless a control inside used it", async () => {
  let closed = 0;
  const subagent: Subagent = { id: "agent-1", description: "Review", status: "completed", startedAt: 1, activity: [{ id: "t", kind: "tool", title: "Read", text: "output", at: 1 }] };
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose: () => { closed += 1; }, onStop() {} }));
  const press = (target: Element, used = false) => act(async () => {
    if (used) target.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
    target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await press(query(view.container, ".agent-tool summary"), true);
  assert.equal(closed, 0);
  await press(query(view.container, ".agent-tool summary"));
  assert.equal(closed, 1);
  assert.ok(view.container.querySelector(".agent-tool .copyable .copy-affordance"), "a tool's output can be copied");
  await view.unmount();
});

test("the subagent search reads what each one came back with", async () => {
  const roster: Subagent[] = [
    { id: "a", description: "Audit", status: "completed", startedAt: 1, activity: [], summary: "Found a race in the reducer" },
    { id: "b", description: "Tests", status: "completed", startedAt: 2, activity: [] },
  ];
  assert.deepEqual(matchSubagents(roster, null, "race").map((agent) => agent.id), ["a"]);
});

test("expanding a tall prompt keeps the beginning of a virtual activity log reachable", async () => {
  const subagent: Subagent = { ...subagents[0], prompt: "Long prompt", activity: Array.from({ length: 60 }, (_, index) => ({ id: `step-${index}`, kind: "text", text: `Step ${index}`, at: index })) };
  const heights = rowHeights((node) => node.classList?.contains("agent-activity-row") ? 40 : 0);
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose() {}, onStop() {} }));
  const scroll = query(view.container, ".inspector-scroll");
  sizeOf(scroll, 360, 400);
  const log = query(view.container, ".agent-activity-items");
  log.getBoundingClientRect = () => ({ top: 6_000 - scroll.scrollTop }) as DOMRect;
  await pumpResizeObservers();
  await act(async () => {
    scroll.scrollTop = 6_000;
    scroll.dispatchEvent(new dom.window.Event("scroll"));
  });
  assert.equal(query(view.container, ".agent-activity-row").getAttribute("data-index"), "0");
  assert.equal(query(view.container, ".agent-activity-row").style.transform, "translateY(0px)");
  heights.restore();
  await view.unmount();
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
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose: () => { closed = true; }, onStop() {} }));
  sizeOf(query(view.container, ".inspector-scroll"), 360, 720);
  await pumpResizeObservers();

  assert.match(view.container.textContent, /Renderer inspected/);
  assert.match(view.container.textContent, /321 tokens/);
  assert.match(view.container.textContent, /Reading/);
  assert.equal(query(view.container, ".agent-tool summary").textContent, "Read");
  const earlier = query<HTMLButtonElement>(view.container, ".agent-activity-earlier"); assert.equal(earlier.textContent, "Show 1 earlier");
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
  const view = await mount(React.createElement(SubagentInspector, { subagent, finding: true, onClose() {}, onStop() {} }));
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
  let zenEntries = 0;
  const view = await mount(React.createElement(WorkspaceHeader, {
    currentThread: {
      id: "codex-thread", title: "Codex thread", engine: "codex", executionPolicy: "confirm", messages: [],
      continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
    } satisfies Thread,
    folder: "/project",
    folderLabel: "project",
    sidebarOpen: false,
    sessionPanelOpen: true,
    rightDockOpen: true,
    zen: { available: true, tip: "Zen mode (⌘⇧F)", onEnter: () => { zenEntries += 1; } },
    workingSubagents: 2,
    openMenu: null,
    canOpenFolder: true,
    apps: null,
    onListApps: () => {},
    onSetOpenMenu: () => {},
    onOpenInApp: () => {},
    onRenameThread: () => {},
    onForkThread: () => {},
    onSetThreadRole: () => {},
    coordinators: [],
    onSetCoordinator: () => {},
    notifications: true,
    onSetMuted: () => {},
    stoppable: false,
    onStopAll: () => {},
    onArchiveThread: () => {},
    onToggleSidebar: () => { sidebarToggles += 1; },
    onToggleSessionPanel: () => { summaryToggles += 1; },
    onToggleRightDock: () => { rightPanelToggles += 1; },
    onChooseFolder: () => {},
  }));

  assert.equal(query(view.container, 'button[aria-label="Hide right panel"]').getAttribute("aria-pressed"), "true");
  const summary = query(view.container, 'button[aria-label="Hide session summary, 2 agents working"]');
  assert.equal(summary.getAttribute("aria-pressed"), "true");
  assert.equal(summary.dataset.tip, "Session summary · 2 agents working");
  assert.match(query(view.container, 'button[aria-label="Show sidebar"]').dataset.tip ?? "", /^Sidebar \(.+B\)$/);
  assert.match(query(view.container, 'button[aria-label="Hide right panel"]').dataset.tip ?? "", /^Right panel \(.+\\\)$/);
  assert.equal(query(view.container, ".open-in .session-toggle").dataset.tip, "Open in…");
  assert.match(view.container.textContent, /2/);
  await act(async () => {
    query<HTMLButtonElement>(view.container, 'button[aria-label="Show sidebar"]').click();
    query<HTMLButtonElement>(view.container, 'button[aria-label="Hide session summary, 2 agents working"]').click();
    query<HTMLButtonElement>(view.container, 'button[aria-label="Hide right panel"]').click();
    query<HTMLButtonElement>(view.container, 'button[aria-label="Enter zen mode"]').click();
  });
  assert.equal(query(view.container, 'button[aria-label="Enter zen mode"]').dataset.tip, "Zen mode (⌘⇧F)");
  assert.equal(zenEntries, 1);
  assert.equal(sidebarToggles, 1);
  assert.equal(summaryToggles, 1);
  assert.equal(rightPanelToggles, 1);
  await view.unmount();
});

test("the open-in list groups the applications this machine has, and hands one the folder", async () => {
  const chosen: string[] = [];
  let menu: string | null = null;
  let lists = 0;
  const apps: InstalledApp[] = [
    { id: "cursor", label: "Cursor", kind: "editor", icon: "data:image/png;base64,AAA" },
    { id: "terminal", label: "Terminal", kind: "terminal", icon: null },
    { id: "finder", label: "Finder", kind: "files", icon: null },
  ];
  const openIn = (found: InstalledApp[] | null) => React.createElement(OpenInMenu, {
    openMenu: menu,
    onSetOpenMenu: (next: string | null) => { menu = next; },
    blocked: null,
    apps: found,
    onListApps: () => { lists += 1; },
    onOpenInApp: (appId: string) => chosen.push(appId),
  });
  const view = await mount(openIn(null));
  const trigger = () => query<HTMLButtonElement>(view.container, ".open-in .session-toggle");

  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  assert.equal(lists, 0, "a list nobody has opened is not worth a scan");
  await act(async () => { trigger().click(); });
  assert.equal(menu, "workspace:open-in");

  await view.render(openIn(null));
  await act(async () => {});
  assert.equal(lists, 1, "opening the list asks the machine what it has");
  assert.match(view.container.textContent, /Looking for applications…/);

  await view.render(openIn(apps));
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

test("the open-in list says what it waits for while the folder cannot be handed over", async () => {
  window.desktop = fakeDesktop();
  let menu: string | null = null;
  const apps: InstalledApp[] = [{ id: "finder", label: "Finder", kind: "files", icon: null }];
  const openIn = (blocked: string | null) => React.createElement(OpenInMenu, { openMenu: menu, onSetOpenMenu: (next: string | null) => { menu = next; }, blocked, apps, onListApps: () => {}, onOpenInApp: () => {} });
  const view = await mount(openIn("Worktree is still being created"));

  const trigger = query<HTMLButtonElement>(view.container, ".open-in .session-toggle");
  assert.equal(trigger.disabled, false);
  await act(async () => { trigger.click(); });
  await view.render(openIn("Worktree is still being created"));
  assert.equal(query(view.container, ".open-in-empty").textContent, "Worktree is still being created");
  assert.equal(view.container.querySelectorAll(".open-in-popover button").length, 0, "no application is offered a folder that is not there yet");

  await view.render(openIn(null));
  assert.equal(view.container.querySelector(".open-in-empty"), null);
  assert.equal(view.container.querySelectorAll(".open-in-popover button").length, 1);
  await view.unmount();
});

test("the session panel's branch row moves the checkout onto the branch it is given", async () => {
  window.desktop = fakeDesktop();
  const calls: { menu: Array<string | null>; checkout: Array<{ branch: string; create: boolean }> } = { menu: [], checkout: [] };
  const panel = (openMenu: string | null) => renderSessionPanel({
    environment: { status: "available", files: [], branch: "main", baseline: null, additions: 0, deletions: 0 },
    hasProject: true,
    workspaceId: "workspace-a",
    openMenu,
    subagents: [],
    backgroundProcesses: [], workflows: [],
    automationCount: 0,
    onSelect() {},
    onOpenAutomations() {},
    onSetOpenMenu: (menu) => { calls.menu.push(menu); },
    onCheckoutBranch: (branch, create) => { calls.checkout.push({ branch, create }); },
  });

  const view = await mount(panel(null));
  const trigger = item(sessionRow(view.container, "Branch"));
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

  await view.render(renderSessionPanel({ ...panel(null).props, workspaceId: undefined, environment: null }));
  const disabled = item(sessionRow(view.container, "Branch"));
  assert.equal(disabled.disabled, true, "with no checkout there is no branch to change");
  assert.equal(disabled.dataset.tip, "Reopen the project to inspect Git", "and the row says why");
  assert.equal(disabled.getAttribute("aria-label"), null, "the row is read by what it shows");
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

test("the subagent search clears from its button or Escape", async () => {
  const roster: Subagent[] = [
    { id: "a", description: "Read the reducer", status: "completed", startedAt: 1, activity: [] },
    { id: "b", description: "Write the tests", status: "completed", startedAt: 2, activity: [] },
  ];
  const view = await mount(React.createElement(AgentsPanel, { subagents: roster, groups: OPEN_SUBAGENT_GROUPS, onSelect() {}, onSetGroup() {} }));
  const search = query<HTMLInputElement>(view.container, 'input[aria-label="Search subagents"]');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
  const type = (text: string) => act(async () => {
    setValue.call(search, text);
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const names = () => [...view.container.querySelectorAll(".subagent-list strong")].map((node) => node.textContent);

  assert.equal(view.container.querySelector(".agent-search-clear"), null, "an empty search has nothing to clear");
  await type("reducer");
  assert.deepEqual(names(), ["Read the reducer"]);
  await act(async () => { query<HTMLButtonElement>(view.container, ".agent-search-clear").click(); });
  assert.equal(search.value, "");
  assert.equal(names().length, 2);

  await type("tests");
  await act(async () => { search.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  assert.equal(search.value, "");
  assert.equal(names().length, 2);
  await view.unmount();
});

test("an empty subagents panel offers the composer, and a search that matches nothing offers the whole roster", async () => {
  const sent: AppCommand[] = [];
  const controls = { available: () => true, dispatch: (command: AppCommand) => { sent.push(command); } };
  const empty = await mount(React.createElement(CommandControlsProvider, { value: controls },
    React.createElement(AgentsPanel, { subagents: [], groups: OPEN_SUBAGENT_GROUPS, onSelect() {}, onSetGroup() {} })));
  const message = query<HTMLButtonElement>(empty.container, ".agents-panel-empty button");
  assert.equal(message.textContent, "Message the thread");
  await act(async () => { message.click(); });
  assert.deepEqual(sent, [{ type: "view.shortcut", action: "composer.focus", surface: "any" }]);
  await empty.unmount();

  const roster: Subagent[] = [{ id: "a", description: "Read the reducer", status: "failed", startedAt: 1, activity: [] }];
  const view = await mount(React.createElement(AgentsPanel, { subagents: roster, groups: OPEN_SUBAGENT_GROUPS, onSelect() {}, onSetGroup() {} }));
  assert.equal(view.container.querySelector(".agents-panel-empty"), null, "a panel with subagents has no empty state");
  const search = query<HTMLInputElement>(view.container, 'input[aria-label="Search subagents"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(search, "nothing");
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const all = query<HTMLButtonElement>(view.container, ".agents-panel-none button");
  await act(async () => { all.click(); });
  assert.equal(search.value, "");
  assert.equal(agentRow(view.container, "Read the reducer").querySelector('[role="img"]')?.getAttribute("aria-label"), "Failed");
  await view.unmount();
});

test("each press of Show earlier in the inspector reads back twice as far as the last", async () => {
  const subagent: Subagent = {
    ...subagents[0],
    activity: Array.from({ length: 200 }, (_, index) => ({ id: `step-${index}`, kind: "text" as const, text: `Step ${index}`, at: index })),
  };
  const measuredRows = rowHeights((node) => node.classList?.contains("agent-activity-row") ? 40 : 0);
  const view = await mount(React.createElement(SubagentInspector, { subagent, onClose() {}, onStop() {} }));
  sizeOf(query(view.container, ".inspector-scroll"), 360, 720);
  await pumpResizeObservers();
  const earlier = () => view.container.querySelector<HTMLButtonElement>(".agent-activity-earlier");
  assert.equal(earlier()?.textContent, "Show 60 earlier");
  await act(async () => { earlier()?.click(); });
  assert.equal(earlier()?.textContent, "Show 80 earlier", "the second press reaches the start of the log");
  await act(async () => { earlier()?.click(); });
  assert.equal(earlier(), null);
  measuredRows.restore();
  await view.unmount();
});
