import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { WorktreeMoveView } from "../../src/application/workspace-state.ts";
import { mount, query } from "../support/renderer-dom.mts";

const { WorktreeMoveDialog } = await import("../../src/renderer/components/WorktreeMoveDialog.tsx");

function dialog(move: WorktreeMoveView, calls: { confirmed: number; closed: number }) {
  return React.createElement(WorktreeMoveDialog, {
    move,
    onConfirm: () => { calls.confirmed++; },
    onClose: () => { calls.closed++; },
  });
}

test("the move confirmation says where the thread goes and what the move costs", async () => {
  const calls = { confirmed: 0, closed: 0 };

  const view = await mount(dialog({ worktree: true, changes: 0, others: 0 }, calls));
  const places = () => [...document.querySelectorAll<HTMLElement>(".worktree-move-place em")].map((element) => element.textContent);
  assert.deepEqual(places(), ["Local", "Worktree"]);
  assert.equal(query(document, ".worktree-move-copy h2").textContent, "Give this thread a worktree?");
  assert.match(query(document, ".worktree-move-copy p").textContent, /checkout of its own/);
  assert.equal(document.activeElement, query(document, ".worktree-move-actions button.primary"), "Confirm holds the focus, so Enter answers");

  await view.render(dialog({ worktree: false, changes: 1, others: 0 }, calls));
  assert.deepEqual(places(), ["Worktree", "Local"], "the move turns around with it");
  assert.equal(query(document, ".worktree-move-copy h2").textContent, "Return this thread to your project checkout?");
  assert.match(query(document, ".worktree-move-copy p").textContent, /Its 1 uncommitted change is committed first .* the worktree is removed\./);

  await view.render(dialog({ worktree: false, changes: 3, others: 2 }, calls));
  assert.match(query(document, ".worktree-move-copy p").textContent, /Its 3 uncommitted changes are committed first .* the worktree stays for the threads still in it\./);

  await act(async () => { query<HTMLButtonElement>(document, ".worktree-move-actions button.primary").click(); });
  assert.deepEqual(calls, { confirmed: 1, closed: 0 });

  await act(async () => { query<HTMLButtonElement>(document, ".worktree-move-actions button").click(); });
  assert.deepEqual(calls, { confirmed: 1, closed: 1 }, "Cancel answers without moving anything");

  await act(async () => { document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(calls.closed, 2, "Escape closes the question rather than reaching the window");

  await act(async () => { query<HTMLElement>(document, ".modal-scrim").dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); });
  assert.equal(calls.closed, 3, "a click on the scrim closes it too");

  await view.unmount();
});
