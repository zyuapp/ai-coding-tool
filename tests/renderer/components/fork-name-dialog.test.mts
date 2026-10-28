import { mount, query } from "../../support/renderer-dom.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

const { ForkNameDialog } = await import("../../../src/renderer/components/ForkNameDialog.tsx");

test("the fork dialog asks only for a name, and Enter takes the suggested one", async () => {
  const confirmed: string[] = [];
  const dialog = (worktree: boolean) => React.createElement(ForkNameDialog, {
    fork: { taskId: "thread-1", title: "Audit (fork)", worktree } ,
    onConfirm: (title: string) => { confirmed.push(title); },
    onClose: () => {},
  });
  const view = await mount(dialog(false));
  try {
    assert.equal(query(document, '[role="dialog"]').hasAttribute("aria-describedby"), false);
    await act(async () => { query<HTMLButtonElement>(document, 'button[type="submit"]').click(); });
    assert.deepEqual(confirmed, ["Audit (fork)"]);
  } finally { await view.unmount(); }
  const worktree = await mount(dialog(true));
  try {
    assert.equal(document.querySelector(".project-edit-note"), null);
  } finally { await worktree.unmount(); }
});
