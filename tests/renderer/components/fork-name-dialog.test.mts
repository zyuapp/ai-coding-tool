import { mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

const { ForkNameDialog } = await import("../../../src/renderer/components/ForkNameDialog.tsx");

test("the fork dialog says what a fork copies and where it goes, and Enter takes the suggested name", async () => {
  const confirmed: string[] = [];
  const dialog = (worktree: boolean) => React.createElement(ForkNameDialog, {
    fork: { taskId: "thread-1", title: "Audit (fork)", worktree } ,
    onConfirm: (title: string) => { confirmed.push(title); },
    onClose: () => {},
  });
  const view = await mount(dialog(false));
  try {
    const scrim = query(document, '[role="dialog"]');
    const summary = document.getElementById(scrim.getAttribute("aria-describedby") ?? "");
    assert.equal(summary?.textContent, "Copies this conversation into a new thread.");
    await act(async () => { query<HTMLButtonElement>(document, 'button[type="submit"]').click(); });
    assert.deepEqual(confirmed, ["Audit (fork)"]);
  } finally { await view.unmount(); }
  const worktree = await mount(dialog(true));
  try {
    assert.match(query(document, ".project-edit-note").textContent ?? "", /its own checkout/);
  } finally { await worktree.unmount(); }
});
