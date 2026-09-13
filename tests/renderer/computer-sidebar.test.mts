import assert from "node:assert/strict";
import { test } from "vitest";
import { act, createElement, useState } from "react";
import type { ComputerFilter } from "../../src/domain/computers.ts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar } from "../support/sidebar.mts";

const linux = { id: "linux", name: "linux-box", offline: false };
const gone = { id: "old", name: "old-laptop", offline: true };

test("folders sit under the computer that holds them, this computer's first, and each row stays its own button", async () => {
  const toggled: string[] = [];
  const projects = [
    { id: "local", root: "/local/app", name: "Local app" },
    { id: "remote", root: "/linux/app", name: "A long remote project name" },
    { id: "remote-two", root: "/linux/other", name: "Other" },
    { id: "offline", root: "/old/app", name: "Offline app" },
  ];
  const view = await mount(renderProjectSidebar({
    projects,
    computerName: "My Mac",
    projectHosts: new Map([["remote", linux], ["remote-two", linux], ["offline", gone]]),
    onToggleProject: (id) => toggled.push(id),
  }));
  try {
    const groups = [...view.container.querySelectorAll<HTMLElement>(".project-list .computer-group")];
    assert.deepEqual(groups.map((group) => group.getAttribute("aria-label")), ["My Mac", "linux-box", "old-laptop"]);
    assert.deepEqual(groups.map((group) => query(group, ".computer-heading .host-mark").textContent), ["My Mac", "linux-box", "old-laptop"]);
    assert.deepEqual(groups.map((group) => query(group, ".computer-heading .host-mark").classList.contains("offline")), [false, false, true]);
    assert.equal(query(groups[2]!, ".host-mark").title, "old-laptop is offline");
    assert.deepEqual(groups.map((group) => [...group.querySelectorAll(".project-main")].map((button) => button.textContent)), [
      ["Local app"], ["A long remote project name", "Other"], ["Offline app"],
    ], "a row carries the folder name alone");
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>(".project-main")];
    assert.deepEqual(buttons.map((button) => button.title), ["/local/app", "/linux/app on linux-box", "/linux/other on linux-box", "/old/app on old-laptop (offline)"]);
    for (const button of buttons.slice(1)) await act(async () => { button.click(); });
    assert.deepEqual(toggled, ["remote", "remote-two", "offline"]);
  } finally {
    await view.unmount();
  }
});

test("folders all on this computer carry no computer heading", async () => {
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "local", root: "/local/app", name: "Local app" }],
    computerName: "My Mac",
  }));
  try {
    assert.equal(view.container.querySelector(".computer-heading"), null);
    assert.equal(query(view.container, ".computer-group").getAttribute("role"), null);
    assert.equal(query(view.container, ".project-main").textContent, "Local app");
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
    assert.equal(rows[0]!.querySelector(".host-mark"), null);
    assert.equal(query(rows[1]!, "small > .host-mark").textContent, "linux-box");
    assert.equal(query(rows[2]!, "small > .host-mark").classList.contains("offline"), true);
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
  function Sidebar() {
    const [openMenu, onSetOpenMenu] = useState<string | null>(null);
    const [computerFilter, setFilter] = useState<ComputerFilter>("all");
    return renderProjectSidebar({
      computerName: "My Mac",
      computerLinks: [
        { id: "linux", name: "linux-box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1 },
        { id: "old", name: "old-laptop", host: "old.tail.ts.net", status: "offline", error: "Timed out", pairedAt: 1 },
      ],
      computerFilter,
      onSetComputerFilter: (filter) => { filters.push(filter); setFilter(filter); },
      openMenu,
      onSetOpenMenu,
    });
  }
  const view = await mount(createElement(Sidebar));
  try {
    const trigger = query<HTMLButtonElement>(view.container, ".computer-switch-trigger");
    const choicesInMenu = () => [...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')];
    const press = async (target: HTMLElement, key: string) => {
      await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })); });
    };
    assert.equal(trigger.textContent, "All");
    assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(async () => { trigger.click(); });
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    const choices = choicesInMenu();
    assert.deepEqual(choices.map((choice) => choice.textContent), ["All", "My Mac", "linux-box", "old-laptop"]);
    assert.deepEqual(choices.map((choice) => choice.getAttribute("aria-checked")), ["true", "false", "false", "false"]);
    assert.equal(choices[3]!.classList.contains("offline"), true);
    assert.equal(choices[3]!.title, "old-laptop is offline");
    assert.equal(choices[3]!.disabled, false);
    await act(async () => { choices[2]!.click(); });
    assert.equal(trigger.textContent, "linux-box");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await press(trigger, "ArrowDown");
    assert.equal(choicesInMenu()[2]!.getAttribute("aria-checked"), "true");
    const menu = query<HTMLElement>(view.container, '[role="menu"]');
    assert.equal(document.activeElement, menu);
    await press(menu, "ArrowDown");
    await press(menu, "ArrowDown");
    assert.equal(document.activeElement, choicesInMenu()[1]);
    await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
    assert.equal(trigger.textContent, "My Mac");
    await act(async () => { trigger.click(); });
    await act(async () => { choicesInMenu()[3]!.click(); });
    assert.equal(trigger.textContent, "old-laptop");
    assert.equal(trigger.title, "old-laptop is offline");
    await act(async () => { trigger.click(); });
    await act(async () => { choicesInMenu()[0]!.click(); });
    assert.deepEqual(filters, ["linux", "this", "old", "all"]);
    assert.equal(trigger.textContent, "All");
    await act(async () => { trigger.click(); });
    await press(query(view.container, '[role="menu"]'), "Escape");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement, trigger, "Escape returns focus to the switch");
    await act(async () => { trigger.click(); });
    await act(async () => { document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })); });
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(async () => { trigger.click(); });
    await act(async () => { query<HTMLElement>(view.container, ".new-task-button").focus(); });
    assert.equal(trigger.getAttribute("aria-expanded"), "false", "leaving the menu with focus dismisses it");
  } finally {
    await view.unmount();
  }
});

test("the switch falls back to This computer when this computer has no name", async () => {
  const view = await mount(renderProjectSidebar({
    computerName: "",
    computerFilter: "this",
    computerLinks: [{ id: "linux", name: "linux-box", host: "linux.tail.ts.net", status: "connected", error: null, pairedAt: 1 }],
  }));
  try {
    assert.equal(query(view.container, ".computer-switch-trigger").textContent, "This computer");
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

test("an empty device offers adding a project, while an offline device shows its link error and trigger dot", async () => {
  let added = 0;
  const link = { id: "linux", name: "zyuapp", host: "linux", pairedAt: 1, status: "connected" as const, error: null };
  const props = { computerLinks: [link], computerFilter: "linux", onOpenFolder: () => { added += 1; } };
  const view = await mount(renderProjectSidebar(props));
  try {
    assert.equal(query(view.container, ".sidebar-project-empty p").textContent, "zyuapp has no projects yet");
    await act(async () => query(view.container, ".sidebar-project-empty button").click());
    assert.equal(added, 1);
    await view.render(renderProjectSidebar({ ...props, computerLinks: [{ ...link, status: "offline", error: "Connection refused" }] }));
    assert.equal(query(view.container, ".sidebar-project-empty [role='alert']").textContent, "Connection refused");
    assert.ok(query(view.container, ".computer-switch-trigger").classList.contains("offline"));
    assert.equal(view.container.querySelector(".sidebar-project-empty button"), null);
  } finally { await view.unmount(); }
});
