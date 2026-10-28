import assert from "node:assert/strict";
import { test } from "vitest";
import React from "react";
import type { WorktreeSettingsView } from "../../src/application/worktree-settings.ts";
import { mount, query } from "../support/renderer-dom.mts";

const { WorktreeDeleteDialog } = await import("../../src/renderer/components/WorktreeDeleteDialog.tsx");

test("a worktree being deleted says so on a button that stays readable", async () => {
  const worktree = { root: "/w/one", title: "one", project: "app", available: true, repository: "/app", threads: [], busy: false, deleting: true } as unknown as WorktreeSettingsView;
  const view = await mount(React.createElement(WorktreeDeleteDialog, { worktree, dispatch: () => {} }));
  try {
    const button = query<HTMLButtonElement>(document, ".worktree-delete-actions button.danger");
    assert.equal(button.textContent, "Deleting…");
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute("aria-busy"), "true");
  } finally { await view.unmount(); }
});
