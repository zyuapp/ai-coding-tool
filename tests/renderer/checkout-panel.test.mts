import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act, useReducer } from "react";
import { reduce, type WorkspaceInput, type WorkspaceEffect } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { activeRun, heldWorktree, projected, task, PROJECT } from "../application/workspace-reducer-fixtures.mts";
import { mount, query, item, sizeOf, pumpResizeObservers } from "../support/renderer-dom.mts";

const { CheckoutPanel } = await import("../../src/renderer/components/CheckoutPanel.tsx");
const { WorkspaceDialogs } = await import("../../src/renderer/components/WorkspaceDialogs.tsx");

function fixture(count = 2) {
  const worktree = { ...heldWorktree(), name: "Login redesign" };
  return projected({
    currentId: "thread-0",
    worktrees: [worktree],
    checkoutPanel: { open: true, mode: "threads", query: "", destination: null },
    threads: Array.from({ length: count }, (_, index) => task(`thread-${index}`, { title: `Review ${index}`, projectId: PROJECT.id, worktreeId: worktree.id })),
    managedWorktrees: [{ id: worktree.id, root: worktree.root, repository: PROJECT.root, branch: "feat/login", status: { changedFiles: 2, comparison: null } }],
  });
}

async function renderPanel(initial = fixture()) {
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
      view.checkout && React.createElement(CheckoutPanel, { view: view.checkout, dispatch }),
      React.createElement(WorkspaceDialogs, { workspace: { ...view, dispatch } as React.ComponentProps<typeof WorkspaceDialogs>["workspace"] }),
    );
  }
  const view = await mount(React.createElement(Harness));
  return { ...view, effects, state: () => state, send: async (input: WorkspaceInput) => { await act(async () => send(input)); } };
}

async function click(root: ParentNode, selector: string) {
  await act(async () => query<HTMLButtonElement>(root, selector).click());
}

async function search(root: ParentNode, value: string) {
  const input = query<HTMLInputElement>(root, 'input[type="search"]');
  await act(async () => {
    input.focus();
    item(Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set).call(input, value);
    input.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}

test("shared threads switch in place and the plus button starts a draft in the same checkout", async () => {
  const view = await renderPanel();
  try {
    assert.match(query(view.container, ".checkout-location").textContent, /Login redesign2 threads/);
    await click(view.container, 'button[title="Review 1"]');
    assert.equal(view.state().currentId, "thread-1");
    assert.equal(query(view.container, '[aria-current="true"]').getAttribute("title"), "Review 1");
    await click(view.container, '[aria-label="New thread here"]');
    assert.equal(view.state().currentId, null);
    assert.equal(view.state().draftProjectId, PROJECT.id);
    assert.equal(view.state().draftWorktreeId, "wt1");
  } finally { await view.unmount(); }
});

test("the inline move picker moves to Local and Escape returns focus to the location row", async () => {
  const view = await renderPanel();
  try {
    await click(view.container, ".checkout-action");
    assert.equal(document.activeElement?.getAttribute("aria-label"), "Search worktrees, branches, or threads");
    await view.send({ type: "worktrees.loaded", worktrees: fixture().managedWorktrees! });
    await click(view.container, '.checkout-list-row');
    assert.equal(query<HTMLButtonElement>(view.container, ".checkout-confirm").disabled, false);
    await click(view.container, ".checkout-confirm");
    assert.equal(view.state().threads[0].worktreeId, undefined);
    assert.equal(view.state().worktrees.length, 1);
    assert.equal(document.activeElement, query(view.container, ".checkout-location"));
    await click(view.container, ".checkout-action");
    await search(view.container, "login");
    assert.match(query(view.container, '.checkout-list-row').textContent, /Login redesign/);
    await act(async () => document.activeElement?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(view.state().checkoutPanel.mode, "threads");
    assert.equal(document.activeElement, query(view.container, ".checkout-location"));
  } finally { await view.unmount(); }
});

test("large shared lists mount a bounded window and search can reach the last thread", async () => {
  const view = await renderPanel(fixture(500));
  try {
    sizeOf(query(view.container, ".checkout-scroll"), 260, 176);
    await pumpResizeObservers();
    const rows = view.container.querySelectorAll('.checkout-list-row');
    assert.ok(rows.length > 0 && rows.length < 20, `${rows.length} mounted rows`);
    await search(view.container, "Review 499");
    assert.equal(view.state().checkoutPanel.query, "Review 499");
    assert.equal(view.container.querySelectorAll('.checkout-list-row').length, 1);
    assert.match(query(view.container, ".checkout-result-count").textContent, /1 of 500 threads/);
    await click(view.container, 'button[title="Review 499"]');
    assert.equal(view.state().currentId, "thread-499");
    assert.match(query(view.container, ".checkout-location").textContent, /500 threads/);
  } finally { await view.unmount(); }
});

test("deletion opens the global warning and a linked run blocks confirmation", async () => {
  const initial = fixture();
  const view = await renderPanel(initial);
  try {
    await click(view.container, ".checkout-delete");
    assert.equal(view.state().settingsOpen, false);
    const dialog = query(document, '[role="dialog"]');
    assert.match(dialog.textContent, /2 linked threads return/);
    assert.match(dialog.textContent, /Uncommitted changes are saved/);
    assert.match(dialog.textContent, /Git-ignored files are deleted/);
    assert.equal(document.activeElement?.textContent, "Cancel");
    await click(dialog, ".danger");
    assert.equal(view.effects.filter((effect) => effect.type === "delete-worktree").length, 1);
  } finally { await view.unmount(); }
  initial.activeRuns = { "thread-1": activeRun("thread-1", "run") };
  const busy = await renderPanel(initial);
  try {
    assert.equal(query<HTMLButtonElement>(busy.container, ".checkout-delete").disabled, true);
    assert.match(query(busy.container, ".checkout-delete").textContent, /1 active/);
  } finally { await busy.unmount(); }
});
