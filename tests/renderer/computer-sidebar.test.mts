import assert from "node:assert/strict";
import { test } from "vitest";
import { act } from "react";
import type { ComputerFilter } from "../../src/domain/computers.ts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar } from "../support/sidebar.mts";

const linux = { id: "linux", name: "linux-box", offline: false };
const gone = { id: "old", name: "old-laptop", offline: true };

test("project computer badges follow the folder name inside its button", async () => {
  const toggled: string[] = [];
  const projects = [
    { id: "local", root: "/local/app", name: "Local app" },
    { id: "remote", root: "/linux/app", name: "A long remote project name" },
    { id: "offline", root: "/old/app", name: "Offline app" },
  ];
  const hosts = [undefined, linux, gone];
  const view = await mount(renderProjectSidebar({
    projects,
    projectHosts: new Map([["remote", linux], ["offline", gone]]),
    onToggleProject: (id) => toggled.push(id),
  }));
  try {
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>(".project-main")];
    assert.equal(buttons.length, projects.length);
    for (const [index, button] of buttons.entries()) {
      const name = query(button, ":scope > span:nth-child(2)");
      assert.equal(name.textContent, projects[index]!.name);
      const host = hosts[index];
      if (!host) {
        assert.equal(button.querySelector(".project-host"), null);
        continue;
      }
      const badge = query(button, ":scope > .project-host");
      assert.equal(name.nextElementSibling, badge);
      assert.equal(badge.closest("button"), button);
      assert.equal(badge.textContent, host.name);
      assert.equal(badge.classList.contains("offline"), host.offline);
      await act(async () => { badge.click(); });
    }
    assert.deepEqual(toggled, ["remote", "offline"]);
  } finally {
    await view.unmount();
  }
});

test("rows on a paired computer carry its name, and rows on one that cannot be reached are greyed and take nothing", async () => {
  const selected: string[] = [];
  const here = task("here", { title: "Local work" });
  const there = task("there", { title: "Remote work", projectId: "remote-project" });
  const elsewhere = task("elsewhere", { title: "Unreachable work" });
  const view = await mount(renderProjectSidebar({
    mode: "activity",
    projects: [{ id: "remote-project", root: "/linux/app" }],
    activityThreads: { priority: [], running: [], threads: [here, there, elsewhere] },
    threadHosts: new Map([["there", linux], ["elsewhere", gone]]),
    projectHosts: new Map([["remote-project", linux]]),
    computerLinks: [{ id: "linux", name: "linux-box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1 }],
    onSelectThread: (id) => selected.push(id),
  }));
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".task-row")];
    assert.deepEqual(rows.map((row) => row.querySelector("small")?.textContent), [
      rows[0]!.querySelector("small")!.textContent,
      `linux-box · app · ${rows[1]!.querySelector("small")!.textContent!.split(" · ").at(-1)}`,
      `old-laptop · ${rows[2]!.querySelector("small")!.textContent!.split(" · ").at(-1)}`,
    ]);
    assert.equal(rows[2]!.classList.contains("offline"), true);
    assert.equal(rows[2]!.getAttribute("aria-disabled"), "true");
    await act(async () => { rows[2]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    await act(async () => { rows[1]!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
    assert.deepEqual(selected, ["there"], "only the reachable computer's row selects");
  } finally {
    await view.unmount();
  }
});

test("the switch names every computer and narrows the lists to the one chosen", async () => {
  const filters: ComputerFilter[] = [];
  const view = await mount(renderProjectSidebar({
    computerName: "My Mac",
    computerLinks: [
      { id: "linux", name: "linux-box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1 },
      { id: "old", name: "old-laptop", host: "old.tail.ts.net", status: "offline", error: "Timed out", pairedAt: 1 },
    ],
    computerFilter: "all",
    onSetComputerFilter: (filter) => filters.push(filter),
  }));
  try {
    const choices = [...view.container.querySelectorAll<HTMLButtonElement>(".computer-choice")];
    assert.deepEqual(choices.map((choice) => choice.textContent), ["All", "My Mac", "linux-box", "old-laptop"]);
    assert.equal(choices[0]!.getAttribute("aria-checked"), "true");
    assert.equal(choices[3]!.classList.contains("offline"), true);
    await act(async () => { choices[2]!.click(); });
    await act(async () => { choices[1]!.click(); });
    assert.deepEqual(filters, ["linux", "this"]);
  } finally {
    await view.unmount();
  }
});

test("a sidebar with no paired computer draws no switch", async () => {
  const view = await mount(renderProjectSidebar({}));
  try {
    assert.equal(view.container.querySelector(".computer-switch"), null);
    assert.ok(query(view.container, ".new-task-button"));
  } finally {
    await view.unmount();
  }
});

test("an unreachable computer's row offers nothing: no rename, no menu, no archive", async () => {
  const menus: (string | null)[] = [];
  const here = task("here", { title: "Local work" });
  const elsewhere = task("elsewhere", { title: "Unreachable work" });
  const view = await mount(renderProjectSidebar({
    mode: "projects",
    recentThreads: [here, elsewhere],
    threadHosts: new Map([["elsewhere", gone]]),
    computerLinks: [{ id: "old", name: "old-laptop", host: "old.tail.ts.net", status: "offline", error: "Timed out", pairedAt: 1 }],
    onSetOpenMenu: (menu) => menus.push(menu),
  }));
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".task-row")];
    assert.equal(rows[0]!.querySelector(".task-archive") !== null, true, "a row here can be archived");
    assert.equal(rows[1]!.querySelector(".row-action"), null);
    await act(async () => { rows[1]!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
    assert.equal(view.container.querySelector(".task-rename"), null);
    await act(async () => { rows[1]!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
    assert.deepEqual(menus, []);
    await act(async () => { rows[0]!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
    assert.deepEqual(menus, ["task:here"]);
  } finally {
    await view.unmount();
  }
});

test("a row whose computer goes away takes back the menu it had open", async () => {
  const menus: (string | null)[] = [];
  const elsewhere = task("elsewhere", { title: "Unreachable work" });
  const view = await mount(renderProjectSidebar({
    mode: "projects",
    recentThreads: [elsewhere],
    threadHosts: new Map([["elsewhere", gone]]),
    computerLinks: [{ id: "old", name: "old-laptop", host: "old.tail.ts.net", status: "offline", error: "Timed out", pairedAt: 1 }],
    openMenu: "task:elsewhere",
    onSetOpenMenu: (menu) => menus.push(menu),
  }));
  try {
    assert.equal(view.container.querySelector("[role=menu]"), null);
    assert.deepEqual(menus, [null]);
  } finally {
    await view.unmount();
  }
});
