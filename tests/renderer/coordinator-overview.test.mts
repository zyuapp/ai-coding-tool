import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { Thread } from "../../src/domain/thread.ts";
import type { CoordinatedThreadStatus } from "../../src/application/coordination.ts";
import type { CoordinatedThreadView } from "../../src/application/coordination-view.ts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { activeRun, required } from "../application/workspace-reducer-fixtures.mts";
import { emptyWorkspaceState, deriveView, OVERVIEW_PANEL } from "../../src/application/workspace-state.ts";
import type { WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { workspaceActions } from "../../src/renderer/task-workspace/workspace-actions.ts";

const { CoordinatorOverview } = await import("../../src/renderer/components/Coordination.tsx");
const { EVERY_ENGINE_READY } = await import("../../src/renderer/components/ComposerSettings.tsx");
const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");
const { buildDock } = await import("../../src/renderer/components/dock-registry.tsx");

/** What the Overview's header picks from, with every engine ready and nothing chosen yet. */
const header = { taskId: "lead", threadModel: { model: "opus" as const, effort: "high" as const }, engineAccess: EVERY_ENGINE_READY, onSetThreadModel() {}, onEngineRead() {}, onSignIn() {} };

/** A coordinator that keeps nothing in memory yet. */
const memory = { taskId: "lead", purpose: null, notes: [], onSetPurpose() {}, onAdd() {}, onEdit() {} };

const member = (id: string, title: string): Thread => ({ id, title, engine: "claude", executionPolicy: "allow-edits", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, parentId: "lead" });

/** A thread's row as the Overview is handed it, with no pull request and nothing to do next. */
const row = (thread: Thread, status: CoordinatedThreadStatus, summary: string | null = null): CoordinatedThreadView => ({ thread, status, summary, pullRequest: null, steps: [], startedAt: null, host: null });

test("a coordinator's Overview groups its threads by what they need, each opening as a tab", async () => {
  window.desktop = fakeDesktop();
  const worktree = { id: "wt-1", name: "dark-mode", projectId: "p", root: "/tmp/wt-1", workspaceId: "ws-1", baseCommit: "abc", createdAt: 1, lastUsedAt: 1 };
  let opened: string | undefined;
  const folded: unknown[] = [];
  const done = Array.from({ length: 7 }, (_, index) => row(member(`d${index}`, `Done ${index}`), "done"));
  const working = Array.from({ length: 7 }, (_, index) => row(member(`w${index}`, `Working ${index}`), "working"));
  const overview = (folds: object) => React.createElement(CoordinatorOverview, {
    header,
    memory,
    members: [
      row({ ...member("a", "Dark mode"), worktreeId: "wt-1" }, "working", "Tokens pass"),
      row(member("b", "Login flake"), "asking", "Retry or skip?"),
      ...working,
      ...done,
    ],
    usage: null,
    worktreeGroups: [{ worktree, threads: [] }],
    folds,
    onSetFold: (group: string, change: object) => { folded.push([group, change]); },
    onSelect: (id: string) => { opened = id; },
    stoppable: true,
  });
  const view = await mount(overview({}));
  const needs = query(view.container, '[aria-label="Needs you"]');
  assert.match(needs.textContent, /Needs you1/);
  assert.match(needs.textContent, /Needs you · Retry or skip\?/);
  const busy = query(view.container, '[aria-label="Working"]');
  assert.ok(query(busy, 'button[aria-label="Open Dark mode"] [aria-label="Works in dark-mode"]'), "a thread in a worktree carries its sidebar mark");
  assert.equal(busy.querySelectorAll(".coordination-row").length, 5, "a group shows five threads");
  await act(async () => { query<HTMLButtonElement>(busy, ".coordination-more").click(); });
  const finished = query(view.container, '[aria-label="Done"]');
  assert.equal(query(finished, ".coordination-group-head").getAttribute("aria-expanded"), "false", "a long Done starts folded");
  assert.equal(finished.querySelectorAll(".coordination-row").length, 0);
  await act(async () => { query<HTMLButtonElement>(finished, ".coordination-group-head").click(); });
  assert.deepEqual(folded, [["working", { all: true }], ["done", { open: true }]], "folding and showing more are commands");

  await view.render(overview({ working: { all: true }, done: { open: true } }));
  assert.equal(query(view.container, '[aria-label="Working"]').querySelectorAll(".coordination-row").length, 8, "a group the user asked to see whole shows every thread");
  assert.equal(query(view.container, '[aria-label="Done"]').querySelectorAll(".coordination-row").length, 5);

  await act(async () => { query<HTMLButtonElement>(busy, 'button[aria-label="Open Dark mode"]').click(); });
  assert.equal(opened, "a");

  await view.render(React.createElement(CoordinatorOverview, { header, memory, members: [], usage: null, worktreeGroups: [], folds: {}, onSetFold() {}, onSelect() {}, stoppable: true }));
  assert.match(view.container.textContent, /Threads run onModelOpusEffortHigh/, "a coordinator with no threads yet still says what they will run on");
  assert.match(view.container.textContent, /No threads yet/);
  await view.unmount();
});

test("the Overview files threads ready for review and resolved apart, and resolves or reopens one from its row", async () => {
  window.desktop = fakeDesktop();
  const dispatched: unknown[] = [];
  const folded: unknown[] = [];
  const overview = (folds: object) => React.createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command) => { dispatched.push(command); } } }, React.createElement(CoordinatorOverview, {
    header,
    memory,
    members: [
      row(member("review", "Dark mode"), "review", "#212 · Checks failing"),
      row(member("busy", "Login flake"), "working"),
      row(member("done", "Docs"), "done", "Shipped"),
      row(member("asking", "Retry"), "asking", "Retry or skip?"),
      row(member("old", "Old work"), "resolved"),
      row(member("older", "Older work"), "resolved"),
    ],
    usage: null,
    worktreeGroups: [],
    folds,
    onSetFold: (group: string, change: object) => { folded.push([group, change]); },
    onSelect() {},
    stoppable: true,
  }));
  const view = await mount(overview({}));
  const labels = [...view.container.querySelectorAll(".coordination-group:not(.coordination-memory) .coordination-group-head > span:not(.coordination-group-count)")].map((node) => node.textContent);
  assert.deepEqual(labels, ["Needs you", "Ready for review", "Working", "Done", "Resolved"]);
  const review = query(view.container, '[aria-label="Ready for review"]');
  assert.match(review.textContent, /Ready for review · #212 · Checks failing/);
  const resolve = query<HTMLButtonElement>(review, 'button[aria-label="Resolve Dark mode"]');
  assert.equal(resolve.closest('button[aria-label="Open Dark mode"]'), null, "the row's action sits beside its open button, never inside it");
  assert.ok(resolve.parentElement?.querySelector('button[aria-label="Open Dark mode"]'));
  await act(async () => { resolve.click(); });
  assert.equal(query(view.container, '[aria-label="Working"]').querySelector('button[aria-label^="Resolve"]'), null, "a working thread cannot be resolved");
  assert.equal(query(view.container, '[aria-label="Needs you"]').querySelector('button[aria-label^="Resolve"]'), null, "nor one waiting on the user");
  assert.ok(query(view.container, '[aria-label="Done"]').querySelector('button[aria-label="Resolve Docs"]'));

  const resolved = query(view.container, '[aria-label="Resolved"]');
  assert.equal(query(resolved, ".coordination-group-head").getAttribute("aria-expanded"), "false", "Resolved starts folded");
  assert.match(query(resolved, ".coordination-group-head").textContent, /Resolved2/);
  assert.equal(resolved.querySelectorAll(".coordination-row").length, 0);
  await act(async () => { query<HTMLButtonElement>(resolved, ".coordination-group-head").click(); });
  await view.render(overview({ resolved: { open: true } }));
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Reopen Old work"]').click(); });

  assert.deepEqual(dispatched, [{ type: "task.resolve", taskId: "review" }, { type: "task.reopen", taskId: "old" }]);
  assert.deepEqual(folded, [["resolved", { open: true }]]);
  await view.unmount();
});

test("the Overview says what a coordinator's threads run on, and picks another with the composer's chips", async () => {
  const picked: unknown[] = [];
  const overview = (available: boolean) => React.createElement(CommandControlsProvider, { value: { available: (command) => available || command.type !== "coordination.set-thread-model", dispatch() {} } },
    React.createElement(CoordinatorOverview, {
      header: { ...header, threadModel: { model: "gpt-6-luna", effort: "max" }, onSetThreadModel: (model: string, effort?: string) => { picked.push([model, effort]); } },
      memory, members: [], usage: null, worktreeGroups: [], folds: {}, onSetFold() {}, onSelect() {}, stoppable: true,
    }));
  const view = await mount(overview(true));
  const head = query(view.container, ".coordination-overview-header");
  assert.match(head.textContent, /Threads run onModelLunaEffortMax/);
  const [model, effort] = head.querySelectorAll<HTMLDetailsElement>(".setting-menu");
  await act(async () => { query<HTMLElement>(item(model), "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => {
    [...item(model).querySelectorAll<HTMLButtonElement>(".model-provider-rail button")].find((button) => button.textContent?.includes("All models"))!.click();
  });
  const offered = [...item(model).querySelectorAll(".model-choice strong")].map((node) => node.textContent);
  assert.ok(offered.includes("Opus") && !offered.includes("Haiku"), "a coordinator's threads are never offered Haiku");
  await act(async () => { [...item(model).querySelectorAll<HTMLButtonElement>(".model-choice")].find((button) => button.textContent?.includes("Opus"))!.click(); });
  await act(async () => { query<HTMLElement>(item(effort), "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { [...item(effort).querySelectorAll<HTMLButtonElement>(".setting-option")].find((button) => button.textContent?.includes("Low"))!.click(); });
  assert.deepEqual(picked, [["opus", undefined], ["gpt-6-luna", "low"]], "a new model keeps the effort for the reducer to fit, and a new effort keeps the model");

  await view.render(overview(false));
  assert.equal(view.container.querySelectorAll(".coordination-overview-header .setting-menu").length, 0, "a computer whose build cannot take the choice offers none");
  await view.unmount();
});

test("the Overview tab sets what the coordinator in front runs its threads on", async () => {
  window.desktop = fakeDesktop();
  const dispatched: WorkspaceInput[] = [];
  const dispatch = async (input: WorkspaceInput) => { dispatched.push(input); };
  const lead: Thread = { ...member("lead", "Plan"), parentId: undefined, role: "coordinator", model: "sonnet", effort: "low" };
  const view = deriveView({ ...emptyWorkspaceState(), threads: [lead], currentId: lead.id });
  const commandControls = { available: () => true, dispatch() {} };
  const workspace = { ...view, threadHandles: [], threadHandlesFor: () => [], commandControls, dispatch, actions: workspaceActions(dispatch) } as never;
  const dock = buildDock({ workspace, inspectedSubagent: undefined, workingSubagents: 0, unreviewedFiles: 0, onInspectSubagent() {}, onCloseInspector() {}, onOpenPanel() {}, onAddSideChat() {} });
  const panel = required(dock.panels.find((item) => item.id === OVERVIEW_PANEL));
  const mounted = await mount(React.createElement(CommandControlsProvider, { value: commandControls }, panel.render()));
  const [model] = mounted.container.querySelectorAll<HTMLDetailsElement>(".coordination-overview-header .setting-menu");
  await act(async () => { query<HTMLElement>(item(model), "summary").click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => {
    [...item(model).querySelectorAll<HTMLButtonElement>(".model-provider-rail button")].find((button) => button.textContent?.includes("All models"))!.click();
  });
  await act(async () => { [...item(model).querySelectorAll<HTMLButtonElement>(".model-choice")].find((button) => button.textContent?.includes("Opus"))!.click(); });
  assert.deepEqual(dispatched.filter((input) => input.type === "coordination.set-thread-model"), [{ type: "coordination.set-thread-model", taskId: "lead", model: "opus" }], "a model alone leaves the effort for the reducer to fit");
  await mounted.unmount();
});

test("the Overview's Working group stops the coordinator and every thread under it", async () => {
  window.desktop = fakeDesktop();
  const dispatched: WorkspaceInput[] = [];
  const dispatch = async (input: WorkspaceInput) => { dispatched.push(input); };
  const lead: Thread = { ...member("lead", "Plan"), parentId: undefined, role: "coordinator" };
  const view = deriveView({ ...emptyWorkspaceState(), threads: [lead, member("busy", "Login flake"), member("idle", "Docs")], currentId: lead.id, activeRuns: { busy: activeRun("busy", "run-busy") } });
  const shown = (available: boolean) => {
    const commandControls = { available: (command: { type: string }) => available || command.type !== "coordination.stop-all", dispatch: (command: WorkspaceInput) => void dispatch(command) };
    const workspace = { ...view, threadHandles: [], threadHandlesFor: () => [], commandControls, dispatch, actions: workspaceActions(dispatch) } as never;
    const dock = buildDock({ workspace, inspectedSubagent: undefined, workingSubagents: 0, unreviewedFiles: 0, onInspectSubagent() {}, onCloseInspector() {}, onOpenPanel() {}, onAddSideChat() {} });
    return React.createElement(CommandControlsProvider, { value: commandControls }, required(dock.panels.find((item) => item.id === OVERVIEW_PANEL)).render());
  };
  const mounted = await mount(shown(true));
  const working = query(mounted.container, '[aria-label="Working"]');
  const stop = query<HTMLButtonElement>(working, ".coordination-stop-all");
  assert.equal(stop.textContent, "Stop all");
  assert.equal(stop.closest(".coordination-group-head"), null, "it sits beside the fold button, never inside it");
  assert.ok(stop.parentElement?.querySelector(".coordination-group-head"));
  assert.equal(query(mounted.container, '[aria-label="Done"]').querySelector(".coordination-stop-all"), null, "only the Working group stops anything");
  await act(async () => { stop.click(); });
  assert.deepEqual(dispatched.filter((input) => input.type === "coordination.stop-all"), [{ type: "coordination.stop-all", taskId: "lead" }]);

  await mounted.render(shown(false));
  assert.equal(query<HTMLButtonElement>(mounted.container, ".coordination-stop-all").disabled, true, "a computer whose build cannot stop them all says so");
  await mounted.unmount();
});

test("the Overview's Usage section shows what the coordinator and its threads spent, folded until opened", async () => {
  window.desktop = fakeDesktop();
  const dispatched: WorkspaceInput[] = [];
  const dispatch = async (input: WorkspaceInput) => { dispatched.push(input); };
  const lead: Thread = { ...member("lead", "Plan"), parentId: undefined, role: "coordinator", usage: { opus: 240_000 } };
  const spenders = Array.from({ length: 6 }, (_, index) => ({ ...member(`t${index}`, `Thread ${index}`), usage: { sonnet: 100_000 * (index + 1) } }));
  const threads = [lead, ...spenders, { ...member("codex", "Docs"), engine: "codex" as const, usage: { "gpt-6.1-sol": 764_220 } }];
  const shown = (folds: object) => {
    const view = deriveView({ ...emptyWorkspaceState(), threads, currentId: lead.id, overviewFolds: { lead: folds } });
    const commandControls = { available: () => true, dispatch() {} };
    const workspace = { ...view, threadHandles: [], threadHandlesFor: () => [], commandControls, dispatch, actions: workspaceActions(dispatch) } as never;
    const dock = buildDock({ workspace, inspectedSubagent: undefined, workingSubagents: 0, unreviewedFiles: 0, onInspectSubagent() {}, onCloseInspector() {}, onOpenPanel() {}, onAddSideChat() {} });
    return React.createElement(CommandControlsProvider, { value: commandControls }, required(dock.panels.find((item) => item.id === OVERVIEW_PANEL)).render());
  };
  const mounted = await mount(shown({}));
  const usage = query(mounted.container, '[aria-label="Usage"]');
  const head = query<HTMLButtonElement>(usage, ".coordination-group-head");
  assert.equal(head.textContent, "Usage3.1M");
  assert.equal(head.title, "3,104,220 tokens");
  assert.equal(head.getAttribute("aria-expanded"), "false", "it starts folded");
  assert.equal(usage.querySelector(".coordination-usage-body"), null);
  await act(async () => { head.click(); });
  assert.deepEqual(dispatched.at(-1), { type: "view.set-overview-group", taskId: "lead", group: "usage", open: true });

  await mounted.render(shown({ usage: { open: true } }));
  const opened = query(mounted.container, '[aria-label="Usage"]');
  assert.equal(query(opened, ".coordination-usage-own").textContent, "This coordinator 240K · 8%");
  assert.deepEqual([...opened.querySelectorAll(".coordination-usage-model")].map((row) => row.textContent), ["Sonnet2.1M", "Sol764K", "Opus240K"]);
  const rows = [...opened.querySelectorAll<HTMLButtonElement>(".coordination-usage-thread")];
  assert.deepEqual(rows.map((row) => row.textContent), ["Docs764K", "Thread 5600K", "Thread 4500K", "Thread 3400K", "Thread 2300K"], "the five that spent most");
  await act(async () => { rows[0]!.click(); });
  assert.equal(dispatched.at(-1)?.type, "task.select");
  await act(async () => { query<HTMLButtonElement>(opened, ".coordination-more").click(); });
  assert.deepEqual(dispatched.at(-1), { type: "view.set-overview-group", taskId: "lead", group: "usage", all: true });

  await mounted.render(shown({ usage: { open: true, all: true } }));
  assert.equal(mounted.container.querySelectorAll(".coordination-usage-thread").length, 7);
  await mounted.unmount();

  const quiet = await mount(React.createElement(CoordinatorOverview, { header, memory, members: [], usage: null, worktreeGroups: [], folds: {}, onSetFold() {}, onSelect() {}, stoppable: false }));
  assert.equal(quiet.container.querySelector('[aria-label="Usage"]'), null, "nothing counted yet draws no section");
  await quiet.unmount();
});

test("the Overview's purpose line and memory rows edit what the coordinator keeps", async () => {
  window.desktop = fakeDesktop();
  const dispatched: WorkspaceInput[] = [];
  const dispatch = async (input: WorkspaceInput) => { dispatched.push(input); };
  const lead: Thread = {
    ...member("lead", "Plan"), parentId: undefined, role: "coordinator",
    memory: { purpose: "Ship the v2 reader", notes: [{ id: "n1", text: "Propose threads first", at: 1 }, { id: "n2", text: "Use Sonnet for docs", at: 1 }], revision: 2 },
  };
  const commandControls = { available: () => true, dispatch: (command: WorkspaceInput) => void dispatch(command) };
  const overview = (thread: Thread) => {
    const view = deriveView({ ...emptyWorkspaceState(), threads: [thread], currentId: thread.id });
    const workspace = { ...view, threadHandles: [], threadHandlesFor: () => [], commandControls, dispatch, actions: workspaceActions(dispatch) } as never;
    const dock = buildDock({ workspace, inspectedSubagent: undefined, workingSubagents: 0, unreviewedFiles: 0, onInspectSubagent() {}, onCloseInspector() {}, onOpenPanel() {}, onAddSideChat() {} });
    const panel = required(dock.panels.find((item) => item.id === OVERVIEW_PANEL));
    return React.createElement(CommandControlsProvider, { value: commandControls }, panel.render());
  };
  const mounted = await mount(overview(lead));
  const container = mounted.container;
  const type = async (input: HTMLInputElement | HTMLTextAreaElement, text: string, key: string) => {
    await act(async () => {
      input.focus();
      item(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")).set?.call(input, text);
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
  };

  const purpose = query<HTMLButtonElement>(container, 'button[aria-label="Edit Purpose"]');
  assert.equal(purpose.textContent, "Ship the v2 reader");
  await act(async () => { purpose.click(); });
  await type(query<HTMLInputElement>(container, 'input[aria-label="Purpose"]'), "Never mind", "Escape");
  assert.equal(dispatched.length, 0, "Esc leaves the purpose as it was");
  assert.equal(dom.window.document.activeElement, query(container, 'button[aria-label="Edit Purpose"]'), "and hands focus back to it");
  await act(async () => { query<HTMLButtonElement>(container, 'button[aria-label="Edit Purpose"]').click(); });
  await type(query<HTMLInputElement>(container, 'input[aria-label="Purpose"]'), "  ", "Enter");
  assert.equal(dom.window.document.activeElement, query(container, 'button[aria-label="Edit Purpose"]'), "so does saving it with Enter");

  const section = query(container, '[aria-label="Memory"]');
  assert.match(query(section, ".coordination-group-head").textContent, /Memory2/);
  const [first] = section.querySelectorAll<HTMLButtonElement>('button[aria-label="Edit Note"]');
  assert.equal(first.textContent, "Propose threads first");
  await act(async () => { first.click(); });
  await type(query<HTMLTextAreaElement>(section, 'textarea[aria-label="Note"]'), "Propose threads before starting any", "Enter");
  const forget = section.querySelectorAll<HTMLButtonElement>('button[aria-label="Forget"]')[1];
  assert.ok(forget.parentElement?.querySelector('button[aria-label="Edit Note"]'), "Forget sits beside the note it drops, not inside it");
  await act(async () => { forget.click(); });
  const kept = { ...item(lead.memory), notes: [item(lead.memory).notes[0]!], revision: 3 };
  await mounted.render(overview({ ...lead, memory: kept }));
  const add = query<HTMLTextAreaElement>(section, 'textarea[aria-label="Add a note"]');
  assert.equal(dom.window.document.activeElement, add, "forgetting the last note hands focus to the row that adds one");
  assert.equal(add.maxLength, 500, "a note longer than memory keeps cannot be typed");
  await type(add, "Keep updates short", "Enter");

  assert.deepEqual(dispatched, [
    { type: "memory.set-purpose", taskId: "lead", purpose: null },
    { type: "memory.edit", taskId: "lead", noteId: "n1", text: "Propose threads before starting any" },
    { type: "memory.forget", taskId: "lead", noteId: "n2" },
    { type: "memory.add", taskId: "lead", text: "Keep updates short" },
  ], "saving the purpose empty clears it");
  assert.equal(add.value, "Keep updates short", "a note not yet saved, or refused, stays to be changed");
  await mounted.render(overview({ ...lead, memory: { ...kept, notes: [...kept.notes, { id: "n3", text: "Keep updates short", at: 2 }], revision: 4 } }));
  assert.equal(add.value, "", "once saved, the row is empty for the next");
  await mounted.unmount();
});

test("the Overview's badge counts the threads that need the user and the threads the coordinator suggested", () => {
  const brief = { intent: "fix it", doneWhen: "it works", delivers: "commit" as const };
  const lead: Thread = {
    ...member("lead", "Plan"), parentId: undefined, role: "coordinator",
    proposals: [{ id: "p1", title: "Docs", prompt: "Write them", brief, place: { worktree: false }, proposedAt: 1 }, { id: "p2", title: "Tests", prompt: "Add them", brief, place: { worktree: false }, proposedAt: 2 }],
  };
  const asking = { ...member("b", "Login flake"), decisions: [{ id: "d1", question: "Retry or skip?", options: [], raisedAt: 1 }] };
  const view = deriveView({ ...emptyWorkspaceState(), threads: [lead, asking], currentId: lead.id });
  const dispatch = async () => {};
  const workspace = { ...view, threadHandles: [], threadHandlesFor: () => [], commandControls: { available: () => true, dispatch() {} }, dispatch, actions: workspaceActions(dispatch) } as never;
  const dock = buildDock({ workspace, inspectedSubagent: undefined, workingSubagents: 0, unreviewedFiles: 0, onInspectSubagent() {}, onCloseInspector() {}, onOpenPanel() {}, onAddSideChat() {} });
  assert.equal(required(dock.panels.find((item) => item.id === OVERVIEW_PANEL)).badge, 3);
});
