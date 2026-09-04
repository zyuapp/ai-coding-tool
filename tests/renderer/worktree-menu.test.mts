import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act, useReducer } from "react";
import { reduce, type WorkspaceInput, type WorkspaceEffect } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { heldWorktree, projected, task, PROJECT } from "../application/workspace-reducer-fixtures.mts";
import { mount, query, item, sizeOf, pumpResizeObservers, place } from "../support/renderer-dom.mts";

const { SessionLocationMenu } = await import("../../src/renderer/components/SessionLocationMenu.tsx");
const { WorkspaceDialogs } = await import("../../src/renderer/components/WorkspaceDialogs.tsx");

function fixture(count = 2) {
  const worktree = { ...heldWorktree(), name: "Login redesign" };
  return projected({
    currentId: "thread-0",
    worktrees: [worktree],
    threads: Array.from({ length: count }, (_, index) => task(`thread-${index}`, { title: `Review ${index}`, projectId: PROJECT.id, worktreeId: worktree.id })),
    managedWorktrees: [{ id: worktree.id, root: worktree.root, repository: PROJECT.root, branch: "feat/login", status: { changedFiles: 2, comparison: null } }],
  });
}

async function renderMenu(initial = fixture()) {
  let state = initial;
  let send: React.Dispatch<WorkspaceInput> = () => {};
  const effects: WorkspaceEffect[] = [];
  function Harness() {
    const [current, dispatch] = useReducer((previous: WorkspaceState, input: WorkspaceInput) => {
      const next = reduce(previous, input);
      effects.push(...next.effects);
      return next.state;
    }, initial);
    state = current;
    send = dispatch;
    const view = deriveView(current);
    return React.createElement(React.Fragment, null,
      view.worktreeMenu && React.createElement(SessionLocationMenu, { view: view.worktreeMenu, openMenu: view.openMenu, dispatch }),
      React.createElement(WorkspaceDialogs, { workspace: { ...view, dispatch } as React.ComponentProps<typeof WorkspaceDialogs>["workspace"] }),
    );
  }
  const view = await mount(React.createElement(Harness));
  return { ...view, effects, state: () => state, send: async (input: WorkspaceInput) => { await act(async () => send(input)); } };
}

async function click(selector: string, root: ParentNode = document) {
  await act(async () => query<HTMLButtonElement>(root, selector).click());
}

function menuButton(label: string): HTMLButtonElement {
  return item([...document.querySelectorAll<HTMLButtonElement>('.session-menu-popover > button')].find(button => button.querySelector('.menu-label')?.textContent === label));
}

async function choose(label: string) { await act(async () => menuButton(label).click()); }

async function search(value: string) {
  const input = query<HTMLInputElement>(document, '.worktree-menu-search input');
  await act(async () => {
    input.focus();
    item(Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set).call(input, value);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}

test("the compact worktree menu navigates shared threads and creates a draft in the same checkout", async () => {
  const view = await renderMenu();
  try {
    assert.match(query(view.container, ".session-location-name").textContent, /Worktree2 threads/);
    await click('[aria-label="Thread options"]');
    const labels = [...document.querySelectorAll('.session-menu-popover > button > .menu-label')].map(node => node.textContent);
    assert.deepEqual(labels, ["New thread here", "Threads here", "Move to worktree", "Return to local", "Delete worktree…"]);
    await choose("Threads here");
    await click('[data-choice-index="1"]');
    assert.equal(view.state().currentId, "thread-1");
    assert.equal(view.state().openMenu, null);
    await click('[aria-label="Thread options"]');
    await choose("New thread here");
    assert.equal(view.state().currentId, null);
    assert.equal(view.state().draftProjectId, PROJECT.id);
    assert.equal(view.state().draftWorktreeId, "wt1");
  } finally { await view.unmount(); }
});

test("Local offers creation and moving, and choosing a worktree moves immediately", async () => {
  const initial = fixture();
  delete initial.threads[0].worktreeId;
  const view = await renderMenu(initial);
  try {
    await click('[aria-label="Thread options"]');
    assert.deepEqual([...document.querySelectorAll('.session-menu-popover > button > .menu-label')].map(node => node.textContent), ["New thread here", "Move to worktree"]);
    await choose("Move to worktree");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Search worktrees or branches");
    assert.ok(view.effects.some(effect => effect.type === "list-worktrees"));
    await view.send({ type: "worktrees.loaded", worktrees: initial.managedWorktrees! });
    await search("feat/login");
    await click('[data-choice-index="0"]');
    assert.equal(view.state().threads[0].worktreeId, "wt1");
    assert.equal(view.state().openMenu, null);
    await click('[aria-label="Thread options"]');
    await choose("Return to local");
    assert.equal(view.state().threads[0].worktreeId, undefined);
    assert.equal(view.state().worktrees.length, 1);
  } finally { await view.unmount(); }
});

test("submenus support keyboard entry, Escape, and normal search cursor keys", async () => {
  const view = await renderMenu();
  try {
    await click('[aria-label="Thread options"]');
    await act(async () => {
      menuButton("Move to worktree").focus();
      menuButton("Move to worktree").dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const input = query<HTMLInputElement>(document, '.worktree-menu-search input');
    assert.equal(document.activeElement, input);
    await act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.equal(document.activeElement, input);
    await act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.activeElement, menuButton("Move to worktree"));
    assert.equal(view.state().openMenu, "session:location");
    await act(async () => menuButton("Move to worktree").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(view.state().openMenu, null);
  } finally { await view.unmount(); }
});

test("large shared lists mount a bounded window and search reaches the last thread", async () => {
  const view = await renderMenu(fixture(500));
  try {
    await click('[aria-label="Thread options"]');
    await choose("Threads here");
    sizeOf(query(document, ".worktree-menu-list"), 280, 220);
    await pumpResizeObservers();
    const rows = document.querySelectorAll('.worktree-menu-choice');
    assert.ok(rows.length > 0 && rows.length < 20, `${rows.length} mounted rows`);
    await search("Review 499");
    assert.equal(document.querySelectorAll('.worktree-menu-choice').length, 1);
    await click('[data-choice-index="0"]');
    assert.equal(view.state().currentId, "thread-499");
  } finally { await view.unmount(); }
});

test("large destination lists search branches and keep the submenu inside the window as its height changes", async () => {
  const initial = fixture();
  for (let index = 0; index < 200; index++) {
    const worktree = { ...heldWorktree(`extra-${index}`), name: `Feature ${index}` };
    initial.worktrees.push(worktree);
    initial.managedWorktrees!.push({ id: worktree.id, root: worktree.root, repository: PROJECT.root, branch: `feature/issue-${index}`, status: { changedFiles: 0, comparison: null } });
  }
  const view = await renderMenu(initial);
  try {
    await click('[aria-label="Thread options"]'); await choose("Move to worktree");
    await view.send({ type: "worktrees.loaded", worktrees: initial.managedWorktrees! });
    sizeOf(query(document, '.worktree-menu-list'), 280, 220);
    await pumpResizeObservers();
    const rows = document.querySelectorAll('.worktree-menu-choice');
    assert.ok(rows.length > 0 && rows.length < 20, `${rows.length} mounted destinations`);
    place('.session-menu-popover', { x: innerWidth - 208, y: innerHeight - 230, width: 200, height: 200 });
    place('.menu-submenu', { x: 0, y: 0, width: 280, height: 350 });
    await pumpResizeObservers();
    const panel = query<HTMLElement>(document, '.menu-submenu');
    assert.equal(panel.style.left, '-275px');
    assert.equal(panel.style.top, '-128px');
    await search("issue-199");
    assert.equal(document.querySelectorAll('.worktree-menu-choice').length, 1);
    await click('[data-choice-index="0"]');
    assert.equal(view.state().threads[0].worktreeId, "extra-199");
  } finally { await view.unmount(); }
});

test("deletion uses the standard warning and a linked run blocks an open confirmation", async () => {
  const view = await renderMenu();
  try {
    await click('[aria-label="Thread options"]');
    await choose("Delete worktree…");
    const dialog = query(document, '[role="dialog"]');
    assert.equal(view.state().settingsOpen, false);
    assert.match(dialog.textContent, /2 linked threads return/);
    assert.match(dialog.textContent, /Uncommitted changes are saved/);
    assert.match(dialog.textContent, /Git-ignored files are deleted/);
    assert.equal(document.activeElement?.textContent, "Cancel");
    await view.send({ type: "task.send", taskId: "thread-1", text: "Continue", attachments: [] });
    assert.equal(query<HTMLButtonElement>(document, '.worktree-delete-actions .danger').disabled, true);
    assert.equal(view.effects.some(effect => effect.type === "delete-worktree"), false);
  } finally { await view.unmount(); }
});

test("deletion confirmation and new-worktree selection dispatch their effects", async () => {
  const view = await renderMenu();
  try {
    await click('[aria-label="Thread options"]'); await choose("Delete worktree…");
    await click('.worktree-delete-actions .danger');
    assert.equal(view.effects.filter(effect => effect.type === "delete-worktree").length, 1);
  } finally { await view.unmount(); }
  const creating = await renderMenu();
  try {
    await click('[aria-label="Thread options"]'); await choose("Move to worktree");
    await click('.worktree-menu-new');
    const effect = item(creating.effects.find(effect => effect.type === "create-worktree"));
    assert.equal(effect.move, true);
    assert.match(query(creating.container, '.session-location-name').textContent, /Creating worktree/);
    assert.equal(creating.state().threads[0].worktreeId, "wt1");
  } finally { await creating.unmount(); }
});
