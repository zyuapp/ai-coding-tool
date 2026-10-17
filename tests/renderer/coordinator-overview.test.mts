import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { Thread } from "../../src/domain/thread.ts";
import type { CoordinatedThreadStatus, CoordinatedThreadView } from "../../src/application/coordination.ts";
import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { required } from "../application/workspace-reducer-fixtures.mts";
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
const memory = { taskId: "lead", purpose: null, notes: [], onSetPurpose() {}, onAdd() {}, onEdit() {}, onForget() {} };

const member = (id: string, title: string): Thread => ({ id, title, engine: "claude", executionPolicy: "allow-edits", messages: [], continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1, parentId: "lead" });

/** A thread's row as the Overview is handed it, with no pull request and nothing to do next. */
const row = (thread: Thread, status: CoordinatedThreadStatus, summary: string | null = null): CoordinatedThreadView => ({ thread, status, summary, pullRequest: null, steps: [], startedAt: null });

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
    worktreeGroups: [{ worktree, threads: [] }],
    folds,
    onSetFold: (group: string, change: object) => { folded.push([group, change]); },
    onSelect: (id: string) => { opened = id; },
    onResolve() {},
    onReopen() {},
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

  await view.render(React.createElement(CoordinatorOverview, { header, memory, members: [], worktreeGroups: [], folds: {}, onSetFold() {}, onSelect() {}, onResolve() {}, onReopen() {} }));
  assert.match(view.container.textContent, /Threads run onModelOpusEffortHigh/, "a coordinator with no threads yet still says what they will run on");
  assert.match(view.container.textContent, /No threads yet/);
  await view.unmount();
});

test("the Overview files threads ready for review and resolved apart, and resolves or reopens one from its row", async () => {
  window.desktop = fakeDesktop();
  const resolving: string[] = [];
  const reopening: string[] = [];
  const folded: unknown[] = [];
  const overview = (folds: object) => React.createElement(CoordinatorOverview, {
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
    worktreeGroups: [],
    folds,
    onSetFold: (group: string, change: object) => { folded.push([group, change]); },
    onSelect() {},
    onResolve: (id: string) => { resolving.push(id); },
    onReopen: (id: string) => { reopening.push(id); },
  });
  const view = await mount(overview({}));
  const labels = [...view.container.querySelectorAll(".coordination-group:not(.coordination-memory) > .coordination-group-head > span:not(.coordination-group-count)")].map((node) => node.textContent);
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

  assert.deepEqual(resolving, ["review"]);
  assert.deepEqual(reopening, ["old"]);
  assert.deepEqual(folded, [["resolved", { open: true }]]);
  await view.unmount();
});

test("the Overview says what a coordinator's threads run on, and picks another with the composer's chips", async () => {
  const picked: unknown[] = [];
  const overview = (available: boolean) => React.createElement(CommandControlsProvider, { value: { available: (command) => available || command.type !== "coordination.set-thread-model", dispatch() {} } },
    React.createElement(CoordinatorOverview, {
      header: { ...header, threadModel: { model: "gpt-6-luna", effort: "max" }, onSetThreadModel: (model: string, effort?: string) => { picked.push([model, effort]); } },
      memory, members: [], worktreeGroups: [], folds: {}, onSetFold() {}, onSelect() {}, onResolve() {}, onReopen() {},
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

test("the Overview's purpose line and memory rows edit what the coordinator keeps", async () => {
  window.desktop = fakeDesktop();
  const dispatched: WorkspaceInput[] = [];
  const dispatch = async (input: WorkspaceInput) => { dispatched.push(input); };
  const lead: Thread = {
    ...member("lead", "Plan"), parentId: undefined, role: "coordinator",
    memory: { purpose: "Ship the v2 reader", notes: [{ id: "n1", text: "Propose threads first", at: 1 }, { id: "n2", text: "Use Sonnet for docs", at: 1 }], revision: 2 },
  };
  const commandControls = { available: () => true, dispatch() {} };
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
  await act(async () => { query<HTMLButtonElement>(container, 'button[aria-label="Edit Purpose"]').click(); });
  await type(query<HTMLInputElement>(container, 'input[aria-label="Purpose"]'), "  ", "Enter");

  const section = query(container, '[aria-label="Memory"]');
  assert.match(query(section, ".coordination-group-head").textContent, /Memory2/);
  const [first] = section.querySelectorAll<HTMLButtonElement>('button[aria-label="Edit Note"]');
  assert.equal(first.textContent, "Propose threads first");
  await act(async () => { first.click(); });
  await type(query<HTMLTextAreaElement>(section, 'textarea[aria-label="Note"]'), "Propose threads before starting any", "Enter");
  const forget = section.querySelectorAll<HTMLButtonElement>('button[aria-label="Forget"]')[1];
  assert.ok(forget.parentElement?.querySelector('button[aria-label="Edit Note"]'), "Forget sits beside the note it drops, not inside it");
  await act(async () => { forget.click(); });
  const add = query<HTMLTextAreaElement>(section, 'textarea[aria-label="Add a note"]');
  assert.equal(add.maxLength, 500, "a note longer than memory keeps cannot be typed");
  await type(add, "Keep updates short", "Enter");

  assert.deepEqual(dispatched, [
    { type: "memory.set-purpose", taskId: "lead", purpose: null },
    { type: "memory.edit", taskId: "lead", noteId: "n1", text: "Propose threads before starting any" },
    { type: "memory.forget", taskId: "lead", noteId: "n2" },
    { type: "memory.add", taskId: "lead", text: "Keep updates short" },
  ], "saving the purpose empty clears it");
  assert.equal(add.value, "Keep updates short", "a note not yet saved, or refused, stays to be changed");
  await mounted.render(overview({ ...lead, memory: { ...item(lead.memory), notes: [...item(lead.memory).notes, { id: "n3", text: "Keep updates short", at: 2 }], revision: 3 } }));
  assert.equal(add.value, "", "once saved, the row is empty for the next");
  await mounted.unmount();
});
