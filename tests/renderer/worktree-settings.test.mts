import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act, useReducer } from "react";
import { reduce, type WorkspaceInput, type WorkspaceEffect } from "../../src/application/workspace-reducer.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { activeRun, heldWorktree, projected, task, PROJECT } from "../application/workspace-reducer-fixtures.mts";
import { mount, query } from "../support/renderer-dom.mts";

const { WorktreeSettings } = await import("../../src/renderer/components/WorktreeSettings.tsx");

function fixture() {
  const available = heldWorktree();
  const missing = { ...heldWorktree("missing"), projectId: "other" };
  return projected({
    settingsOpen: true,
    projects: [PROJECT, { id: "other", root: "/other" }],
    worktrees: [available, missing],
    threads: [task("Pick a model", { worktreeId: available.id, projectId: PROJECT.id }), task("Review picker", { worktreeId: available.id, projectId: PROJECT.id, archivedAt: 1 }), task("Missing thread", { worktreeId: missing.id, projectId: "other" })],
    managedWorktrees: [{ id: available.id, root: available.root, repository: PROJECT.root, branch: "feat/model-selection", status: { changedFiles: 2, comparison: { branch: "main", ahead: 3 } } }],
  });
}

async function renderSettings(initial = fixture(), platform = "macos") {
  Object.defineProperty(window, "desktop", { configurable: true, value: { platform } });
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
    return React.createElement(WorktreeSettings, { page: deriveView(current).worktreeSettings, error: current.worktreeManagementError, notice: current.worktreeManagementNotice, dispatch });
  }
  const view = await mount(React.createElement(Harness));
  return { ...view, effects, state: () => state, send: async (input: WorkspaceInput) => { await act(async () => send(input)); } };
}

async function click(label: string, root: ParentNode = document) {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label);
  assert.ok(button, `Button not found: ${label}`);
  await act(async () => button.click());
}

test("filters both groups, opens missing folders for an empty project, and can collapse them", async () => {
  const view = await renderSettings();
  try {
    assert.match(view.container.textContent!, /feat\/model-selection/);
    assert.match(view.container.textContent!, /2 changed files/);
    assert.match(view.container.textContent!, /3 commits not in main/);
    const filter = query<HTMLSelectElement>(view.container, "select");
    await act(async () => { filter.value = "other"; filter.dispatchEvent(new window.Event("change", { bubbles: true })); });
    assert.equal(view.container.querySelector(".worktree-settings-list .worktree-setting-row"), null);
    assert.equal(query(view.container, ".worktree-missing-toggle").getAttribute("aria-expanded"), "true");
    await act(async () => query<HTMLButtonElement>(view.container, ".worktree-missing-toggle").click());
    assert.equal(query(view.container, ".worktree-missing-toggle").getAttribute("aria-expanded"), "false");
    await view.send({ type: "worktree.refresh" });
    assert.equal(filter.disabled, true);
    assert.equal(filter.value, "other");
    await view.send({ type: "worktrees.failed", message: "Scan failed" });
    assert.match(query(view.container, '[role="alert"]').textContent, /Scan failed/);
    assert.equal(view.state().managedWorktrees?.length, 1);
  } finally { await view.unmount(); }
});

test("thread links expand and open archived threads without restoring them", async () => {
  const view = await renderSettings();
  try {
    await click("2 linked threads");
    assert.equal(query(view.container, ".worktree-thread-list").hasAttribute("hidden"), false);
    await click("Review pickerArchived");
    assert.equal(view.state().currentId, "Review picker");
    assert.equal(view.state().settingsOpen, false);
    assert.equal(view.state().threads[1].archivedAt, 1);
  } finally { await view.unmount(); }
});

test("delete confirmation focuses Cancel, closes with Escape, and restores focus without deleting", async () => {
  const view = await renderSettings();
  try {
    const button = query<HTMLButtonElement>(view.container, ".worktree-row-actions button:last-child");
    button.focus();
    await act(async () => button.click());
    assert.match(query(document, '[role="dialog"]').textContent, /Uncommitted changes are saved/);
    assert.equal(document.activeElement?.textContent, "Cancel");
    const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => { document.activeElement?.dispatchEvent(escape); await new Promise((resolve) => setTimeout(resolve, 10)); });
    assert.equal(escape.defaultPrevented, true);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, button);
    assert.equal(view.effects.some((effect) => effect.type === "delete-worktree"), false);
    await click("Delete…");
    await click("Delete worktree", query(document, '[role="dialog"]'));
    assert.equal(view.effects.filter((effect) => effect.type === "delete-worktree").length, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(query(view.container, '.worktree-row-actions [role="status"]').textContent, /Deleting/);
  } finally { await view.unmount(); }
});

test("Forget explains thread retention and dispatches a missing-only removal", async () => {
  const view = await renderSettings();
  try {
    await view.send({ type: "worktree.filter-project", project: "other" });
    await click("Forget…");
    assert.match(query(document, '[role="dialog"]').textContent, /Your thread history stays/);
    await click("Forget folder");
    const deletion = view.effects.find((effect) => effect.type === "delete-worktree");
    assert.equal(deletion?.missingOnly, true);
  } finally { await view.unmount(); }
});

test("active runs disable deletion, and an unavailable repository warns before deletion", async () => {
  const initial = fixture();
  initial.activeRuns = { "Pick a model": activeRun("Pick a model", "run") };
  const active = await renderSettings(initial);
  try {
    assert.equal(query<HTMLButtonElement>(active.container, ".worktree-row-actions button:last-child").disabled, true);
    assert.match(active.container.textContent!, /Run active/);
  } finally { await active.unmount(); }
  const unavailable = fixture();
  unavailable.managedWorktrees![0].repository = null;
  unavailable.managedWorktrees![0].status = { changedFiles: null, comparison: null };
  const view = await renderSettings(unavailable, "linux");
  try {
    await click("Show in file manager");
    assert.ok(view.effects.some((effect) => effect.type === "reveal-worktree"));
    await click("Delete…");
    assert.match(query(document, ".worktree-delete-warning").textContent, /permanently deleted/);
    assert.equal(query(document, '[role="dialog"]').textContent.includes("Uncommitted changes are saved"), false);
  } finally { await view.unmount(); }
});
