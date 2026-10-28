import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act, useState } from "react";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar } from "../support/sidebar.mts";
import { automationView } from "../support/desktop-api.mts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import type { ProjectSidebarProps } from "../../src/renderer/components/ProjectSidebar.tsx";

function menuItems() {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

function menuItem(label: string) {
  return menuItems().find((button) => (button.querySelector(".menu-label") ?? button).textContent === label);
}

function Harness(props: Partial<ProjectSidebarProps>) {
  const [openMenu, onSetOpenMenu] = useState<string | null>(null);
  return renderProjectSidebar({ ...props, openMenu, onSetOpenMenu });
}

test("a thread row's ellipsis opens the same menu a right-click does, and an unreachable row offers none", async () => {
  const here = task("here", { projectId: "p" });
  const away = task("away", { projectId: "p" });
  const archived: string[] = [];
  const view = await mount(React.createElement(Harness, {
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [here, away],
    threadHosts: new Map([["away", { id: "laptop", name: "laptop", offline: true, reconnecting: false }]]),
    onArchiveThread: (id) => { archived.push(id); },
  }));
  try {
    const more = query<HTMLButtonElement>(view.container, '[aria-label="More options for here"]');
    assert.equal(more.dataset.tip, "More");
    assert.equal(more.getAttribute("aria-expanded"), "false");
    assert.equal(view.container.querySelector('[aria-label="More options for away"]'), null, "an offline row takes nothing");

    await act(async () => { more.click(); });
    assert.equal(more.getAttribute("aria-expanded"), "true");
    assert.ok(menuItem("Rename") && menuItem("Fork"));
    assert.equal(view.container.querySelector(".project-task-row.active"), null, "opening the menu does not open the thread");

    assert.equal(menuItem("Snooze"), undefined, "outside Priority the menu leaves snoozing out");
    await act(async () => { menuItem("Archive…")!.click(); });
    assert.deepEqual(archived, ["here"]);
    assert.equal(menuItems().length, 0);

    assert.equal(view.container.querySelector('[aria-label="Archive here"]'), null, "archiving is in the menu, a step from a stray click");
  } finally { await view.unmount(); }
});

test("every row's rail holds its marks and its actions, the open thread's included", async () => {
  const view = await mount(React.createElement(Harness, {
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [task("open", { projectId: "p" }), task("other", { projectId: "p" })],
    currentId: "open",
  }));
  try {
    const rails = [...view.container.querySelectorAll<HTMLElement>(".project-task-row .row-rail")];
    assert.ok(rails[0]!.closest(".active") && rails[0]!.querySelector(".task-more"));
    assert.equal(rails[1]!.closest(".active"), null);
    assert.ok(rails.every((rail) => rail.querySelector(".row-marks") && rail.querySelector(".row-actions")), "marks and actions share one rail");
  } finally { await view.unmount(); }
});

test("a thread that cannot leave its folder says so while dragged", async () => {
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [task("free", { projectId: "p" }), task("checkout", { projectId: "p", worktreeId: "w" })],
  }));
  try {
    const entry = (id: string) => query<HTMLElement>(view.container, `[data-rfd-drag-handle-draggable-id="${id}"]`);
    assert.equal(entry("free").dataset.pinned, undefined);
    assert.equal(entry("checkout").dataset.pinned, "Stays in its worktree's folder");
  } finally { await view.unmount(); }
});

test("a row's title shows whole only when cut short, and each mark names itself", async () => {
  const asked = task("asked", { projectId: "p" });
  const scheduled = task("scheduled", { projectId: "p" });
  const plain = task("plain", { projectId: "p" });
  const away = task("away", { projectId: "p" });
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [asked, scheduled, plain, away],
    runningThreadIds: new Set(["asked"]),
    blockedThreadIds: new Set(["asked"]),
    schedules: new Map([["scheduled", automationView({ taskId: "scheduled", lastStatus: "failed" })]]),
    threadHosts: new Map([["away", { id: "laptop", name: "laptop", offline: true, reconnecting: false }]]),
  }));
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".project-task-row")];
    assert.ok(rows.every((row) => !row.querySelector("[title]")), "one tooltip system on a row");
    const titles = rows.map((row) => query<HTMLElement>(row, ":scope > span:first-child"));
    assert.deepEqual(titles.map((title) => title.dataset.tip), ["asked", "scheduled", "plain", "away"]);
    assert.ok(titles.every((title) => title.hasAttribute("data-tip-overflow")));
    assert.deepEqual([...rows[0]!.querySelectorAll<HTMLElement>(".row-mark")].map((mark) => mark.dataset.tip).slice(0, 1), ["Needs approval"]);
    const schedule = query<HTMLElement>(view.container, ".task-automation");
    assert.ok(schedule.classList.contains("trouble"));
    assert.equal(schedule.closest<HTMLElement>(".row-mark")!.dataset.tip, "Runs on a schedule, and its last run failed");
  } finally { await view.unmount(); }
});

test("a folder's menu asks before removing one that holds threads, and moves it among its computer's folders", async () => {
  const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");
  const sent: unknown[] = [];
  const controls = { available: () => true, dispatch: (command: unknown) => { sent.push(command); } };
  const removed: string[] = [];
  const view = await mount(React.createElement(CommandControlsProvider, { value: controls }, React.createElement(Harness, {
    projects: [{ id: "first", root: "/work/first" }, { id: "middle", root: "/work/middle" }, { id: "last", root: "/work/last" }],
    expandedProjects: new Set(["first"]),
    orderedThreads: [task("one", { projectId: "first" })],
    onRemoveProject: (id) => { removed.push(id); },
  })));
  try {
    const open = async (name: string) => {
      const trigger = query<HTMLButtonElement>(view.container, `[aria-label="More options for ${name}"]`);
      await act(async () => { trigger.focus(); trigger.click(); });
    };
    await open("first");
    assert.equal(menuItem("Move up"), undefined, "the first folder has nowhere up to go");
    assert.equal(menuItem("Remove")!.getAttribute("aria-haspopup"), "menu", "a folder holding threads asks first");
    await act(async () => { menuItem("Remove")!.click(); });
    assert.deepEqual(menuItems().slice(-2).map((item) => item.textContent), ["Keep project", "Remove and archive 1 thread"]);
    await act(async () => { menuItem("Keep project")!.click(); });
    assert.deepEqual(removed, []);
    await open("first");
    await act(async () => { menuItem("Remove")!.click(); });
    await act(async () => { menuItem("Remove and archive 1 thread")!.click(); });
    assert.deepEqual(removed, ["first"]);

    await open("last");
    assert.equal(menuItem("Remove")!.getAttribute("aria-haspopup"), null, "an empty folder goes in one choice");
    await act(async () => { menuItem("Remove")!.click(); });
    assert.deepEqual(removed, ["first", "last"]);

    await open("middle");
    await act(async () => { menuItem("Move up")!.click(); });
    await open("middle");
    await act(async () => { menuItem("Move down")!.click(); });
    assert.deepEqual(sent, [
      { type: "project.move", projectId: "middle", index: 0 },
      { type: "project.move", projectId: "middle", index: 2 },
    ]);

    await open("last");
    assert.equal(menuItem("Move down"), undefined, "the last folder has nowhere down to go");
  } finally { await view.unmount(); }
});

test("a right-click on a folder opens its menu, and F2 renames it", async () => {
  const view = await mount(React.createElement(Harness, { projects: [{ id: "p", root: "/work/p" }] }));
  try {
    const row = query<HTMLElement>(view.container, ".project-row");
    await act(async () => { row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
    assert.equal(query(view.container, '[aria-label="More options for p"]').getAttribute("aria-expanded"), "true");
    assert.equal(query(menuItem("Rename")!, ".menu-shortcut").textContent, "F2");
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(row.tabIndex, -1, "the row's buttons are its only stops");
    assert.equal(row.getAttribute("role"), null);

    const main = query<HTMLButtonElement>(view.container, ".project-main");
    await act(async () => { main.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.equal(view.container.querySelector(".project-rename"), null, "Enter is the button's own");
    await act(async () => { main.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true })); });
    const rename = query<HTMLInputElement>(view.container, ".project-rename");
    assert.equal(document.activeElement, rename);
    assert.deepEqual([rename.selectionStart, rename.selectionEnd], [0, rename.value.length], "typing replaces the name");
  } finally { await view.unmount(); }
});

test("double-clicking a folder renames it, folding it once rather than twice", async () => {
  const toggled: string[] = [];
  const view = await mount(React.createElement(Harness, { projects: [{ id: "p", root: "/work/p" }], onToggleProject: (id) => { toggled.push(id); } }));
  try {
    const main = query<HTMLButtonElement>(view.container, ".project-main");
    await act(async () => {
      for (const detail of [1, 2]) main.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail }));
      main.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    });
    assert.deepEqual(toggled, ["p"]);
    assert.ok(view.container.querySelector(".project-rename"));
  } finally { await view.unmount(); }
});

test("with no projects at all, the sidebar offers adding one, and the heading's add button is always there", async () => {
  let opened = 0;
  const view = await mount(renderProjectSidebar({ projects: [], onOpenFolder: () => { opened += 1; } }));
  try {
    assert.equal(query(view.container, ".sidebar-project-empty p").textContent, "No projects yet");
    await act(async () => { query<HTMLButtonElement>(view.container, ".sidebar-project-empty .sidebar-empty-action").click(); });
    const add = query<HTMLButtonElement>(view.container, '.projects-heading [aria-label="Add project"]');
    assert.equal(add.dataset.tip, "Add project");
    await act(async () => { add.click(); });
    assert.equal(opened, 2);
  } finally { await view.unmount(); }

  const listed = await mount(renderProjectSidebar({ projects: [{ id: "p", root: "/work/p" }] }));
  try {
    assert.equal(listed.container.querySelector(".sidebar-project-empty"), null);
    assert.ok(listed.container.querySelector('.projects-heading [aria-label="Add project"]'));
  } finally { await listed.unmount(); }
});

test("Recents leaves starting a thread to the New thread button, and offers it when empty", async () => {
  const started: (string | undefined)[] = [];
  const view = await mount(renderProjectSidebar({ onNewThread: (projectId) => { started.push(projectId); } }));
  try {
    const heading = query(view.container, ".recents-heading");
    assert.equal(heading.querySelector(".menu-trigger, .section-action"), null);
    const start = query<HTMLButtonElement>(view.container, '[aria-label="Project-less tasks"] .empty-tasks');
    assert.equal(start.textContent, "Start a thread");
    assert.ok(start.querySelector("svg"), "it reads as an action");
    await act(async () => { start.click(); });
    assert.deepEqual(started, [undefined]);
  } finally { await view.unmount(); }

  const listed = await mount(renderProjectSidebar({ recentThreads: [task("loose")] }));
  try {
    assert.equal(listed.container.querySelector('[aria-label="Project-less tasks"] .empty-tasks'), null);
  } finally { await listed.unmount(); }
});

test("an open folder with no threads offers to start one there", async () => {
  const started: (string | undefined)[] = [];
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    onNewThread: (projectId) => { started.push(projectId); },
  }));
  try {
    const start = query<HTMLButtonElement>(view.container, ".project-group .empty-tasks");
    assert.equal(start.textContent, "Start a thread");
    await act(async () => { start.click(); });
    assert.deepEqual(started, ["p"]);
  } finally { await view.unmount(); }
});

test("a folded Projects or Recents heading says how many it holds, and an open one does not", async () => {
  const props: Partial<ProjectSidebarProps> = {
    projects: [{ id: "a", root: "/work/a" }, { id: "b", root: "/work/b" }],
    recentThreads: [task("loose")],
  };
  const open = await mount(renderProjectSidebar(props));
  try {
    assert.equal(open.container.querySelector(".section-count"), null);
  } finally { await open.unmount(); }
  const folded = await mount(renderProjectSidebar({ ...props, sections: { projects: false, recents: false, priority: true, running: true, threads: true, snoozed: true } }));
  try {
    assert.equal(query(folded.container, ".projects-heading .section-count").textContent, "2");
    assert.equal(query(folded.container, ".recents-heading .section-count").textContent, "1");
  } finally { await folded.unmount(); }
});

test("a folder's menu renames it in place, as a double-click does", async () => {
  const renamed: [string, string][] = [];
  const view = await mount(React.createElement(Harness, {
    projects: [{ id: "p", root: "/work/p" }],
    onRenameProject: (id, name) => { renamed.push([id, name]); },
  }));
  try {
    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="More options for p"]').click(); });
    await act(async () => { menuItem("Rename")!.click(); });
    const input = query<HTMLInputElement>(view.container, ".project-rename");
    assert.equal(document.activeElement, input);
    input.value = "Work";
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.deepEqual(renamed, [["p", "Work"]]);
  } finally { await view.unmount(); }
});

test("the sidebar's edge says how to reset it, and Enter resets it as a double-click does", async () => {
  const view = await mount(renderProjectSidebar({}));
  try {
    const edge = query<HTMLElement>(view.container, ".sidebar-resizer");
    const sidebar = edge.parentElement!;
    assert.equal(edge.dataset.tip, "Drag to resize · Double-click to reset");
    assert.equal(edge.getAttribute("aria-valuemin"), "270");
    assert.equal(edge.getAttribute("aria-valuemax"), String(Math.round(dom.window.innerWidth / 2)));
    sidebar.style.setProperty("--sidebar-width", "400px");
    await act(async () => { edge.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), "");
  } finally { await view.unmount(); }
});

test("the sidebar's edge steps with the arrow keys, Home takes it to its narrowest, and it says the width it took", async () => {
  const view = await mount(renderProjectSidebar({}));
  try {
    const edge = query<HTMLElement>(view.container, ".sidebar-resizer");
    const sidebar = edge.parentElement!;
    const press = async (key: string) => {
      const event = new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      await act(async () => { edge.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    assert.equal(await press("Home"), true);
    assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), "270px");
    assert.equal(edge.getAttribute("aria-valuenow"), "270");
    assert.equal(await press("Tab"), false, "other keys pass through");
    assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), "270px");
  } finally { await view.unmount(); }
});

test("the Settings button names its keystroke", async () => {
  const view = await mount(renderProjectSidebar({}));
  try {
    assert.match(query(view.container, ".sidebar-settings").dataset.tip ?? "", /^Settings \(.+,\)$/);
  } finally { await view.unmount(); }
});

test("the header's buttons name themselves and their keystrokes", async () => {
  const view = await mount(renderProjectSidebar({ canGoBack: true, canGoForward: true }));
  try {
    assert.match(query(view.container, '[aria-label="Go back"]').dataset.tip ?? "", /^Back \(.+\[\)$/);
    assert.match(query(view.container, '[aria-label="Go forward"]').dataset.tip ?? "", /^Forward \(.+\]\)$/);
    assert.match(query(view.container, '.new-task-button').dataset.tip ?? "", /^New thread \(.+N\)$/);
    const modes = () => [...view.container.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Sidebar view"] > button')];
    assert.deepEqual(modes().map((mode) => [mode.getAttribute("aria-label"), mode.dataset.tip, mode.getAttribute("aria-pressed")]), [
      ["Group by project", "Group by project", "true"],
      ["Rank threads by activity", "Rank by activity", "false"],
    ], "both views are on show, the one in effect pressed");
  } finally { await view.unmount(); }

  const modes: string[] = [];
  const activity = await mount(renderProjectSidebar({ mode: "activity", onSetMode: (mode) => { modes.push(mode); } }));
  try {
    const button = (label: string) => query<HTMLButtonElement>(activity.container, `[aria-label="${label}"]`);
    assert.equal(button("Rank threads by activity").getAttribute("aria-pressed"), "true");
    await act(async () => { button("Rank threads by activity").click(); });
    assert.deepEqual(modes, [], "choosing the view in effect changes nothing");
    await act(async () => { button("Group by project").click(); });
    assert.deepEqual(modes, ["projects"]);
  } finally { await activity.unmount(); }
});

test("the search button beside New thread opens the jump palette and names its keystroke", async () => {
  const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");
  const sent: string[] = [];
  const controls = { available: () => true, dispatch: (command: { type: string }) => { sent.push(command.type); } };
  const view = await mount(React.createElement(CommandControlsProvider, { value: controls }, renderProjectSidebar({})));
  try {
    const search = query<HTMLButtonElement>(view.container, ".new-task-bar .sidebar-search");
    assert.match(search.dataset.tip ?? "", /^Search \(.+K\)$/);
    assert.match(query(search, "kbd").textContent ?? "", /K$/, "the keystroke reads without hovering");
    assert.equal(query(view.container, ".new-task-button").textContent, "New thread");
    await act(async () => { search.click(); });
    assert.deepEqual(sent, ["view.jump-open"]);
  } finally { await view.unmount(); }
});

test("the folder a new thread would start in is marked, and an open folder draws open", async () => {
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "a", root: "/work/a" }, { id: "b", root: "/work/b" }],
    expandedProjects: new Set(["a"]),
    draftProjectId: "b",
  }));
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".project-row")];
    assert.deepEqual(rows.map((row) => row.classList.contains("current")), [false, true]);
    const [open, shut] = rows.map((row) => query(row, ".folder-icon path").getAttribute("d"));
    assert.notEqual(open, shut);
  } finally { await view.unmount(); }
});

test("a thread's menu moves it to another folder or to Recents, as a drag does", async () => {
  const here = task("here", { projectId: "a" });
  const checkout = task("checkout", { projectId: "a", worktreeId: "w" });
  const moved: [string, { projectId: string | null; index: number }][] = [];
  const view = await mount(React.createElement(Harness, {
    projects: [{ id: "a", root: "/work/a" }, { id: "b", root: "/work/b" }, { id: "remote", root: "/work/remote" }],
    projectHosts: new Map([["remote", { id: "laptop", name: "laptop", offline: false, reconnecting: false }]]),
    expandedProjects: new Set(["a"]),
    orderedThreads: [here, checkout],
    onMoveThread: (id, target) => { moved.push([id, target]); },
  }));
  try {
    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="More options for here"]').click(); });
    await act(async () => { menuItem("Move to")!.click(); });
    assert.equal(menuItem("a"), undefined, "the folder it is in is not offered");
    assert.equal(menuItem("remote"), undefined, "another computer's folder is not offered");
    await act(async () => { menuItem("b")!.click(); });
    assert.deepEqual(moved, [["here", { projectId: "b", index: 0 }]]);

    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="More options for here"]').click(); });
    await act(async () => { menuItem("Move to")!.click(); });
    await act(async () => { menuItem("Recents")!.click(); });
    assert.deepEqual(moved.at(-1), ["here", { projectId: null, index: 0 }]);

    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="More options for checkout"]').click(); });
    assert.ok(menuItem("Rename"));
    assert.equal(menuItem("Move to"), undefined, "a thread in a worktree stays in its project");
  } finally { await view.unmount(); }
});

test("an update offered or ready says what a click does, and a download in progress shows how far it has come", async () => {
  const label = async (appUpdate: ProjectSidebarProps["appUpdate"]) => {
    const view = await mount(renderProjectSidebar({ appUpdate }));
    try {
      const indicator = query<HTMLElement>(view.container, ".sidebar-update");
      return [indicator.textContent, indicator.getAttribute("aria-label")];
    } finally { await view.unmount(); }
  };
  assert.deepEqual(await label({ status: "available", version: "1.2.0" }), ["Update", "Update to version 1.2.0"]);
  assert.deepEqual(await label({ status: "downloading", version: "1.2.0", percent: 40 }), ["40%", "Downloading version 1.2.0: 40%"]);
  assert.deepEqual(await label({ status: "ready", version: "1.2.0" }), ["Restart", "Restart to install version 1.2.0"]);
});

test("a focused thread row renames on F2 and opens on Enter, and Enter on its own buttons leaves the selection alone", async () => {
  const here = task("here", { projectId: "p" });
  const selected: string[] = [];
  const archived: string[] = [];
  const view = await mount(React.createElement(Harness, {
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [here],
    onSelectThread: (id) => { selected.push(id); },
    onArchiveThread: (id) => { archived.push(id); },
  }));
  try {
    const entry = query<HTMLElement>(view.container, '[data-rfd-drag-handle-draggable-id="here"]');
    const press = async (target: HTMLElement, key: string) => {
      await act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    };
    await press(entry, "Enter");
    assert.deepEqual(selected, ["here"]);

    await press(query<HTMLButtonElement>(view.container, '[aria-label="More options for here"]'), "Enter");
    assert.deepEqual(selected, ["here"], "Enter on a row's button is the button's own");

    await press(entry, "F2");
    const rename = query<HTMLInputElement>(view.container, ".task-rename");
    assert.equal(document.activeElement, rename);
    assert.equal(rename.selectionEnd! - rename.selectionStart!, "here".length);
  } finally { await view.unmount(); }
});

test("the menu key opens a thread row's menu under the row, and Rename there names F2", async () => {
  const view = await mount(React.createElement(Harness, {
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [task("here", { projectId: "p" })],
  }));
  try {
    const row = query<HTMLElement>(view.container, ".project-task-row");
    await act(async () => { row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })); });
    const menu = query<HTMLElement>(document, ".context-menu-popover");
    assert.ok(menu);
    assert.equal(query(menuItem("Rename")!, ".menu-shortcut").textContent, "F2");
  } finally { await view.unmount(); }
});

test("a row on a computer that is away carries a mark saying so, and every mark names itself", async () => {
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [task("here", { projectId: "p" }), task("away", { projectId: "p" })],
    threadHosts: new Map([["away", { id: "laptop", name: "laptop", offline: true, reconnecting: false }]]),
  }));
  try {
    const [here, away] = [...view.container.querySelectorAll<HTMLElement>(".project-task-row")];
    assert.equal(here!.querySelector(".task-away"), null);
    const mark = query<HTMLElement>(away!, ".task-away");
    assert.equal(mark.getAttribute("aria-label"), "laptop is offline");
    assert.equal(mark.closest<HTMLElement>(".row-mark")!.dataset.tip, "laptop is offline");
    assert.ok([...away!.querySelectorAll<HTMLElement>(".row-mark")].every((slot) => slot.dataset.tip));
  } finally { await view.unmount(); }
});

test("a rail holds three marks at most, folding the ones ahead of status and engine into a count that names them", async () => {
  const busy = task("busy", { projectId: "p", role: "coordinator", worktreeId: "w" });
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [busy, task("plain", { projectId: "p" })],
    worktreeThreadIds: new Set(["busy"]),
    schedules: new Map([["busy", automationView({ taskId: "busy" })]]),
    runningThreadIds: new Set(["busy"]),
  }));
  try {
    const [first, second] = [...view.container.querySelectorAll<HTMLElement>(".project-task-row")];
    const marks = [...first!.querySelectorAll<HTMLElement>(".row-mark")];
    assert.equal(marks.length, 3);
    assert.equal(marks[0]!.textContent, "+3");
    assert.equal(marks[0]!.dataset.tip, "Coordinator · Works in a worktree · Runs on a schedule");
    assert.equal(query(marks[0]!, '[role="img"]').getAttribute("aria-label"), "Coordinator, Works in a worktree, Runs on a schedule");
    assert.deepEqual(marks.slice(1).map((mark) => mark.dataset.tip), ["Working", "Claude thread"]);
    assert.equal(second!.querySelector(".task-more-marks"), null, "a row with room shows each mark");
  } finally { await view.unmount(); }
});

test("in Priority, Dismiss takes the engine's slot so the status mark stays in view", async () => {
  const view = await mount(renderProjectSidebar({
    mode: "activity",
    activityThreads: { priority: [task("done", { outcome: "finished", outcomeUnread: true })], running: [], threads: [], snoozed: [] },
  }));
  try {
    const actions = [...view.container.querySelectorAll<HTMLElement>('nav[aria-label="Priority"] .row-action')];
    assert.deepEqual(actions.map((action) => action.dataset.tip), ["More", "Dismiss"]);
  } finally { await view.unmount(); }
});

test("a folded folder carries the most pressing status of the threads it hides", async () => {
  const projects = [{ id: "asks", root: "/work/asks" }, { id: "runs", root: "/work/runs" }, { id: "quiet", root: "/work/quiet" }];
  const orderedThreads = [
    task("working", { projectId: "asks" }), task("asked", { projectId: "asks" }),
    task("busy", { projectId: "runs" }), task("idle", { projectId: "quiet" }),
  ];
  const marks = { runningThreadIds: new Set(["working", "asked", "busy"]), blockedThreadIds: new Set(["asked"]) };
  const view = await mount(renderProjectSidebar({ projects, orderedThreads, ...marks }));
  try {
    const status = (name: string) => [...view.container.querySelectorAll<HTMLElement>(".project-main")]
      .find((row) => row.textContent?.startsWith(name))!.querySelector<HTMLElement>(".folder-status");
    assert.equal(status("asks")!.dataset.tip, "A thread needs your approval");
    assert.ok(status("asks")!.querySelector(".task-attention.approval"));
    assert.equal(status("runs")!.dataset.tip, "A thread is working");
    assert.equal(status("quiet"), null);
  } finally { await view.unmount(); }

  const open = await mount(renderProjectSidebar({ projects, orderedThreads, expandedProjects: new Set(["asks"]), ...marks }));
  try {
    assert.equal(query(open.container, '.project-main[aria-expanded="true"]').querySelector(".folder-status"), null, "an open folder leaves status to its rows");
  } finally { await open.unmount(); }
});

test("a thread rename refuses a blank name with a mark, and a blank field left behind keeps the old name", async () => {
  const renamed: string[] = [];
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    expandedProjects: new Set(["p"]),
    orderedThreads: [task("t", { projectId: "p", title: "Old title" })],
    onRenameThread: (_id, title) => { renamed.push(title); },
  }));
  try {
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { query(view.container, ".project-task-row").dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
    const input = query<HTMLInputElement>(view.container, ".task-rename");
    assert.equal(input.placeholder, "Old title");
    await act(async () => {
      setValue.call(input, "  ");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(query(view.container, ".task-rename"), input, "Enter on a blank name keeps the field open");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    await act(async () => {
      setValue.call(input, "N");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.equal(input.getAttribute("aria-invalid"), null, "typing clears the mark");
    await act(async () => {
      setValue.call(input, "");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      input.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    });
    assert.equal(view.container.querySelector(".task-rename"), null);
    assert.deepEqual(renamed, []);
  } finally { await view.unmount(); }
});

test("an activity row holds its buttons without being one, is marked current when open, and Space and Enter open it", async () => {
  const selected: string[] = [];
  const view = await mount(renderProjectSidebar({
    mode: "activity",
    currentId: "open",
    activityThreads: { priority: [], running: [], threads: [task("open"), task("other")], snoozed: [] },
    onSelectThread: (id) => { selected.push(id); },
  }));
  try {
    const [open, other] = [...view.container.querySelectorAll<HTMLElement>('nav[aria-label="Threads"] > .task-entry')];
    assert.equal(open!.getAttribute("role"), null, "a row holding buttons is not itself a button");
    assert.equal(open!.querySelector('[role="button"]'), null);
    assert.ok(open!.querySelector("button"), "its More button stays reachable");
    assert.equal(open!.tabIndex, 0);
    assert.equal(open!.getAttribute("aria-current"), "true");
    assert.equal(other!.getAttribute("aria-current"), null);
    const space = new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await act(async () => { other!.dispatchEvent(space); });
    assert.deepEqual(selected, ["other"]);
    assert.equal(space.defaultPrevented, true);
    await act(async () => { open!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.deepEqual(selected, ["other", "open"]);
    const fromButton = new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await act(async () => { other!.querySelector("button")!.dispatchEvent(fromButton); });
    assert.deepEqual(selected, ["other", "open"], "a key on the row's own button is that button's");
  } finally { await view.unmount(); }
});

test("a narrowed activity filter clears in one press beside it, and focus lands back on the filter", async () => {
  const picked: (string | null)[] = [];
  const view = await mount(renderProjectSidebar({
    mode: "activity",
    projects: [{ id: "web", root: "/work/web" }, { id: "api", root: "/work/api" }],
    activityProject: "web",
    onSetActivityProject: (id) => { picked.push(id); },
  }));
  try {
    const clear = query<HTMLButtonElement>(view.container, '.activity-filter-clear[aria-label="Show all projects"]');
    await act(async () => { clear.click(); });
    assert.deepEqual(picked, [null]);
    assert.equal(document.activeElement, query(view.container, ".activity-filter-trigger"));
  } finally { await view.unmount(); }

  const all = await mount(renderProjectSidebar({ mode: "activity", projects: [{ id: "web", root: "/work/web" }, { id: "api", root: "/work/api" }] }));
  try {
    assert.equal(all.container.querySelector(".activity-filter-clear"), null, "nothing to clear while every project is listed");
  } finally { await all.unmount(); }
});

test("the sidebar's edge steps fifty pixels with Shift held", async () => {
  const view = await mount(renderProjectSidebar({}));
  try {
    const edge = query<HTMLElement>(view.container, ".sidebar-resizer");
    const sidebar = edge.parentElement!;
    sidebar.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 0, width: 300, height: 0, x: 0, y: 0, toJSON() {} });
    const press = async (key: string, shiftKey = false) => {
      await act(async () => { edge.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })); });
    };
    await press("ArrowRight", true);
    assert.equal(edge.getAttribute("aria-valuenow"), "350");
    await press("ArrowLeft");
    assert.equal(edge.getAttribute("aria-valuenow"), "290");
    assert.equal(edge.getAttribute("aria-valuemax"), String(Math.round(dom.window.innerWidth / 2)));
  } finally { await view.unmount(); }
});
