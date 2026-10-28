import assert from "node:assert/strict";
import { createElement, act } from "react";
import { test } from "vitest";
import { computerCommandAvailable } from "../../src/application/computers.ts";
import { COMPUTER_CAPABILITIES, REMOTE_UNSUPPORTED } from "../../src/contracts/computer-capabilities.ts";
import type { AppCommand } from "../../src/contracts/commands.ts";
import { CommandButton, CommandControlsProvider } from "../../src/renderer/components/CommandControl.tsx";
import { MenuList } from "../../src/renderer/components/PopoverMenu.tsx";
import { threadMenuEntries } from "../../src/renderer/components/thread-menu.ts";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";
import { mount, query } from "../support/renderer-dom.mts";

test("thread menus and shared buttons disable unsupported operations on the correct computer and recover after discovery", async () => {
  const thread = task("there");
  const local = task("here");
  const commands: AppCommand[] = [];
  const state = workspace({ threads: [local] });
  state.computers = { ...state.computers, active: "linux", paired: [{
    id: "linux", name: "Linux", host: "linux", status: "connected", error: null, pairedAt: 1,
    capabilities: COMPUTER_CAPABILITIES.filter((name) => !name.startsWith("command:task.rename") && !name.startsWith("command:task.archive")),
    state: workspace({ threads: [thread], currentId: thread.id }),
  }] };
  const entries = threadMenuEntries(thread, { onRename: () => {}, onFork: () => {}, onArchive: () => {}, onSetRole: () => {}, coordinators: [], onSetCoordinator: () => {}, notifications: true, onSetMuted: () => {}, stoppable: false, onStopAll: () => {} });
  const render = () => createElement(CommandControlsProvider, { value: {
    available: (command) => computerCommandAvailable(state, command),
    dispatch: (command) => { commands.push(command); },
  } }, [
    createElement(MenuList, { key: "menu", entries, onClose: () => {} }),
    createElement(CommandButton, { key: "remote", command: { type: "task.archive", taskId: thread.id }, "aria-label": "Archive remote" }),
    createElement(CommandButton, { key: "local", command: { type: "task.archive", taskId: local.id }, "aria-label": "Archive local" }),
  ]);
  const view = await mount(render());
  try {
    const remote = () => query<HTMLButtonElement>(view.container, '[aria-label="Archive remote"]');
    assert.equal(remote().getAttribute("aria-disabled"), "true");
    assert.equal(remote().disabled, false, "it stays focusable so the keyboard reaches its reason");
    assert.equal(remote().hasAttribute("data-unsupported"), true);
    assert.equal(query<HTMLButtonElement>(view.container, '[aria-label="Archive local"]').getAttribute("aria-disabled"), null);
    const rename = [...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.querySelector(".menu-label")?.textContent === "Rename")!;
    assert.equal(rename.getAttribute("aria-disabled"), "true");
    assert.equal(query(rename, ".menu-shortcut").textContent, "Not on remote", "the row says why without a pointer");
    assert.equal(rename.dataset.tip, REMOTE_UNSUPPORTED, "the reason shows in the shared tooltip");
    assert.equal(remote().dataset.tip, REMOTE_UNSUPPORTED);
    assert.equal(remote().title, "");
    await act(async () => { remote().click(); rename.click(); });
    assert.deepEqual(commands, []);
    state.computers.paired[0]!.capabilities = COMPUTER_CAPABILITIES;
    await view.render(render());
    assert.equal(remote().getAttribute("aria-disabled"), null);
    assert.equal(remote().dataset.tip, undefined);
    assert.equal(remote().hasAttribute("data-unsupported"), false);
    await act(async () => remote().click());
    assert.deepEqual(commands, [{ type: "task.archive", taskId: thread.id }]);
  } finally { await view.unmount(); }
});
