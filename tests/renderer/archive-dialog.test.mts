import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act } from "react";
import { App } from "../../src/renderer/App.tsx";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { seedProjectTasks } from "../support/sidebar.mts";

vi.mock("../../src/renderer/task-workspace/workspace-connection.ts", () => import("../support/in-process-workspace.mts"));

async function chooseArchive(container: HTMLElement, title: string) {
  const row = query<HTMLElement>(container, `.task-row [data-tip="${title}"]`).closest<HTMLElement>(".task-row")!;
  await act(async () => { row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 120 })); });
  const archive = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => (button.querySelector(".menu-label") ?? button).textContent === "Archive…");
  assert.ok(archive, "the row's menu offers Archive…");
  await act(async () => { archive.click(); });
}

function dialog() {
  return document.querySelector<HTMLElement>(".modal-scrim[role=dialog]");
}

function button(label: string) {
  return [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
}

test("a row's Archive asks first: Cancel, Escape and the backdrop keep the thread, and Archive archives it", async () => {
  seedProjectTasks([{ id: "quiet", title: "Quiet", updatedAt: 1 }]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  try {
    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Rank threads by activity"]').click(); });
    await chooseArchive(view.container, "Quiet");
    assert.equal(dialog()?.getAttribute("aria-label"), "Archive “Quiet”?");
    assert.match(dialog()?.textContent ?? "", /It leaves the sidebar\. Restore it from Settings › Archived threads within 5 days\./);
    assert.equal(document.activeElement, button("Cancel"), "Cancel holds the focus");
    assert.ok(query(view.container, '.task-row [data-tip="Quiet"]'), "nothing is archived while it asks");

    await act(async () => { button("Cancel").click(); });
    assert.equal(dialog(), null);
    assert.ok(query(view.container, '.task-row [data-tip="Quiet"]'), "Cancel keeps the thread");

    await chooseArchive(view.container, "Quiet");
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(dialog(), null, "Escape closes it");
    await chooseArchive(view.container, "Quiet");
    await act(async () => { dialog()!.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true })); });
    assert.equal(dialog(), null, "the backdrop closes it");
    assert.ok(query(view.container, '.task-row [data-tip="Quiet"]'));

    await chooseArchive(view.container, "Quiet");
    await act(async () => { button("Archive").click(); });
    assert.equal(dialog(), null);
    assert.equal(view.container.querySelector('.task-row [data-tip="Quiet"]'), null, "Archive archives it");
    assert.equal(view.container.querySelector(".toasts"), null, "with no Undo");
  } finally { await view.unmount(); }
});
