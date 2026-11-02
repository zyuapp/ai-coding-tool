import assert from "node:assert/strict";
import { test } from "vitest";
import { act, createElement } from "react";
import type { AppCommand } from "../../src/contracts/commands.ts";
import { deriveView, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { CommandControlsProvider } from "../../src/renderer/components/CommandControl.tsx";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar } from "../support/sidebar.mts";

const unread = (id: string, updatedAt: number) => task(id, { title: `Thread ${id}`, updatedAt, outcome: "finished", outcomeUnread: true });

function paired(state: WorkspaceState, filter: WorkspaceState["computers"]["filter"]): WorkspaceState {
  const remote = workspace({ threads: [unread("remote", 5)] });
  return { ...state, computers: { ...state.computers, filter, paired: [{ id: "linux", name: "linux-box", host: "linux.ts.net", status: "connected", error: null, pairedAt: 1, state: remote }] } };
}

test("the header names the unread rows newest first, follows the computer filter, and clears them", async () => {
  const local = workspace({ threads: [unread("old", 1), task("read", { updatedAt: 9 }), unread("new", 7)] });
  const dispatched: AppCommand[] = [];
  const selected: string[] = [];
  const render = (state: WorkspaceState, openMenu: string | null = null) => {
    const view = deriveView(state);
    return createElement(CommandControlsProvider, { value: { available: () => true, dispatch: (command) => { dispatched.push(command); } } },
      renderProjectSidebar({ ...view, mode: "projects", openMenu, onSelectThread: (id) => { selected.push(id); } }));
  };
  const sidebar = await mount(render(workspace({ threads: [task("read")] })));
  try {
    assert.equal(sidebar.container.querySelector(".unread-switch"), null, "nothing unread offers nothing");

    await sidebar.render(render(paired(local, "all"), "sidebar:unread"));
    assert.equal(query(sidebar.container, ".unread-switch-trigger").getAttribute("aria-label"), "3 unread");
    const rows = [...sidebar.container.querySelectorAll(".unread-menu-thread")];
    assert.deepEqual(rows.map((row) => query(row, ".menu-label").textContent), ["Thread new", "Thread remote", "Thread old"]);
    assert.equal(query(rows[1]!, ".menu-shortcut").textContent, "linux-box");
    await act(async () => { (rows[2] as HTMLElement).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(selected, ["old"]);

    await sidebar.render(render(paired(local, "all"), "sidebar:unread"));
    const clear = [...sidebar.container.querySelectorAll<HTMLElement>(".unread-menu button")].find((button) => button.textContent?.includes("Mark All as Read"))!;
    await act(async () => { clear.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(dispatched, [{ type: "task.read-all" }]);

    await sidebar.render(render(paired(local, "this")));
    assert.equal(query(sidebar.container, ".unread-switch-count").textContent, "2");
    await sidebar.render(render(paired(local, "linux")));
    assert.equal(query(sidebar.container, ".unread-switch-count").textContent, "1");
  } finally { await sidebar.unmount(); }
});

test("past ten rows the menu counts the rest", async () => {
  const threads = Array.from({ length: 12 }, (_, index) => unread(`t${index}`, index));
  const sidebar = await mount(renderProjectSidebar({ ...deriveView(workspace({ threads })), mode: "projects", openMenu: "sidebar:unread" }));
  try {
    assert.equal(sidebar.container.querySelectorAll(".unread-menu-thread").length, 10);
    assert.equal(query(sidebar.container, ".unread-menu-more").textContent?.trim(), "2 more");
  } finally { await sidebar.unmount(); }
});
