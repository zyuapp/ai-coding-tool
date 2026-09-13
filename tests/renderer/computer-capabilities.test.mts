import assert from "node:assert/strict";
import { createElement, act } from "react";
import { test } from "vitest";
import { computerCommandAvailable } from "../../src/application/computers.ts";
import { COMPUTER_CAPABILITIES } from "../../src/contracts/computer-capabilities.ts";
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
  const entries = threadMenuEntries(thread, { onRename: () => {}, onFork: () => {}, onArchive: () => {}, onSetRole: () => {} });
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
    assert.ok(remote().disabled);
    assert.equal(query<HTMLButtonElement>(view.container, '[aria-label="Archive local"]').disabled, false);
    const rename = [...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Rename")!;
    assert.ok(rename.disabled);
    await act(async () => remote().click());
    assert.deepEqual(commands, []);
    state.computers.paired[0]!.capabilities = COMPUTER_CAPABILITIES;
    await view.render(render());
    assert.equal(remote().disabled, false);
    await act(async () => remote().click());
    assert.deepEqual(commands, [{ type: "task.archive", taskId: thread.id }]);
  } finally { await view.unmount(); }
});
