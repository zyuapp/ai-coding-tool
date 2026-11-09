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

function listed(...threads: ReturnType<typeof task>[]) {
  return { priority: [], running: [], threads, snoozed: [] };
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
    activityThreads: listed(here, away),
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
    assert.equal(view.container.querySelector(".task-row.active"), null, "opening the menu does not open the thread");

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
    activityThreads: listed(task("open", { projectId: "p" }), task("other", { projectId: "p" })),
    currentId: "open",
  }));
  try {
    const rails = [...view.container.querySelectorAll<HTMLElement>(".task-row .row-rail")];
    assert.ok(rails[0]!.closest(".active") && rails[0]!.querySelector(".task-more"));
    assert.equal(rails[1]!.closest(".active"), null);
    assert.ok(rails.every((rail) => rail.querySelector(".row-marks") && rail.querySelector(".row-actions")), "marks and actions share one rail");
  } finally { await view.unmount(); }
});

test("a row's title shows whole only when cut short, and each mark names itself", async () => {
  const asked = task("asked", { projectId: "p" });
  const scheduled = task("scheduled", { projectId: "p" });
  const plain = task("plain", { projectId: "p" });
  const away = task("away", { projectId: "p" });
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    activityThreads: listed(asked, scheduled, plain, away),
    runningThreadIds: new Set(["asked"]),
    blockedThreadIds: new Set(["asked"]),
    schedules: new Map([["scheduled", automationView({ taskId: "scheduled", lastStatus: "failed" })]]),
    threadHosts: new Map([["away", { id: "laptop", name: "laptop", offline: true, reconnecting: false }]]),
  }));
  try {
    const rows = [...view.container.querySelectorAll<HTMLElement>(".task-row")];
    assert.ok(rows.every((row) => !row.querySelector("[title]")), "one tooltip system on a row");
    const titles = rows.map((row) => query<HTMLElement>(row, ".task-row-text > span"));
    assert.deepEqual(titles.map((title) => title.dataset.tip), ["asked", "scheduled", "plain", "away"]);
    assert.ok(titles.every((title) => title.hasAttribute("data-tip-overflow")));
    assert.deepEqual([...rows[0]!.querySelectorAll<HTMLElement>(".row-mark")].map((mark) => mark.dataset.tip).slice(0, 1), ["Needs approval"]);
    const schedule = query<HTMLElement>(view.container, ".task-automation");
    assert.ok(schedule.classList.contains("trouble"));
    assert.equal(schedule.closest<HTMLElement>(".row-mark")!.dataset.tip, "Runs on a schedule, and its last run failed");
  } finally { await view.unmount(); }
});

test("with no projects at all, the sidebar offers adding one, and says nothing once there is one", async () => {
  let opened = 0;
  const view = await mount(renderProjectSidebar({ projects: [], onOpenFolder: () => { opened += 1; } }));
  try {
    assert.equal(query(view.container, ".sidebar-project-empty p").textContent, "No projects yet");
    await act(async () => { query<HTMLButtonElement>(view.container, ".sidebar-project-empty .sidebar-empty-action").click(); });
    assert.equal(opened, 1);
  } finally { await view.unmount(); }

  const withProject = await mount(renderProjectSidebar({ projects: [{ id: "p", root: "/work/p" }] }));
  try {
    assert.equal(withProject.container.querySelector(".sidebar-project-empty"), null);
  } finally { await withProject.unmount(); }
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

test("the search button beside New thread opens the jump palette and names its keystroke", async () => {
  const { CommandControlsProvider } = await import("../../src/renderer/components/CommandControl.tsx");
  const sent: string[] = [];
  const controls = { available: () => true, dispatch: (command: { type: string }) => { sent.push(command.type); } };
  const view = await mount(React.createElement(CommandControlsProvider, { value: controls }, renderProjectSidebar({})));
  try {
    const search = query<HTMLButtonElement>(view.container, ".new-task-bar .sidebar-search");
    assert.match(search.dataset.tip ?? "", /^Search \(.+K\)$/);
    assert.equal(search.querySelector("kbd"), null);
    assert.equal(query(view.container, ".new-task-button").textContent, "New thread");
    await act(async () => { search.click(); });
    assert.deepEqual(sent, ["view.jump-open"]);
  } finally { await view.unmount(); }
});

test("a thread's menu moves it to another folder or out of its project", async () => {
  const here = task("here", { projectId: "a" });
  const checkout = task("checkout", { projectId: "a", worktreeId: "w" });
  const moved: [string, { projectId: string | null; index: number }][] = [];
  const view = await mount(React.createElement(Harness, {
    projects: [{ id: "a", root: "/work/a" }, { id: "b", root: "/work/b" }, { id: "remote", root: "/work/remote" }],
    projectHosts: new Map([["remote", { id: "laptop", name: "laptop", offline: false, reconnecting: false }]]),
    activityThreads: listed(here, checkout),
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
    await act(async () => { menuItem("No project")!.click(); });
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
    activityThreads: listed(here),
    onSelectThread: (id) => { selected.push(id); },
    onArchiveThread: (id) => { archived.push(id); },
  }));
  try {
    const entry = query<HTMLElement>(view.container, 'nav[aria-label="Threads"] > .task-entry');
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
    activityThreads: listed(task("here", { projectId: "p" })),
  }));
  try {
    const row = query<HTMLElement>(view.container, ".task-row");
    await act(async () => { row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })); });
    const menu = query<HTMLElement>(document, ".context-menu-popover");
    assert.ok(menu);
    assert.equal(query(menuItem("Rename")!, ".menu-shortcut").textContent, "F2");
  } finally { await view.unmount(); }
});

test("a row on a computer that is away carries a mark saying so, and every mark names itself", async () => {
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    activityThreads: listed(task("here", { projectId: "p" }), task("away", { projectId: "p" })),
    threadHosts: new Map([["away", { id: "laptop", name: "laptop", offline: true, reconnecting: false }]]),
  }));
  try {
    const [here, away] = [...view.container.querySelectorAll<HTMLElement>(".task-row")];
    assert.equal(here!.querySelector(".task-away"), null);
    const mark = query<HTMLElement>(away!, ".task-away");
    assert.equal(mark.getAttribute("aria-label"), "laptop is offline");
    assert.equal(mark.closest<HTMLElement>(".row-mark")!.dataset.tip, "laptop is offline");
    assert.ok([...away!.querySelectorAll<HTMLElement>(".row-mark")].every((slot) => slot.dataset.tip));
  } finally { await view.unmount(); }
});

test("a rail shows every mark a row carries, with status and engine at the right edge", async () => {
  const busy = task("busy", { projectId: "p", role: "coordinator", worktreeId: "w" });
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    activityThreads: listed(busy, task("plain", { projectId: "p" })),
    worktreeThreadIds: new Set(["busy"]),
    schedules: new Map([["busy", automationView({ taskId: "busy" })]]),
    runningThreadIds: new Set(["busy"]),
  }));
  try {
    const [first, second] = [...view.container.querySelectorAll<HTMLElement>(".task-row")];
    const tips = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>(".row-mark")].map((mark) => mark.dataset.tip);
    assert.deepEqual(tips(first!), ["Coordinator", "Works in a worktree", "Runs on a schedule", "Working", "Claude thread"]);
    assert.deepEqual(tips(second!), ["Claude thread"]);
    assert.equal(query<HTMLElement>(view.container, ".sidebar").style.getPropertyValue("--row-slots"), "5", "every rail makes room for the busiest row");
  } finally { await view.unmount(); }
});

test("in Priority, Dismiss takes the engine's slot so the status mark stays in view, and the menu never repeats it", async () => {
  const dismissed: string[] = [];
  const view = await mount(React.createElement(Harness, {
    activityThreads: { priority: [task("done", { outcome: "finished", outcomeUnread: true })], running: [task("busy")], threads: [], snoozed: [] },
    onDismissThread: (id) => { dismissed.push(id); },
  }));
  try {
    const actions = [...view.container.querySelectorAll<HTMLElement>('nav[aria-label="Priority"] .row-action')];
    assert.deepEqual(actions.map((action) => action.dataset.tip), ["More", "Dismiss"]);
    const marks = [...view.container.querySelectorAll<HTMLElement>('nav[aria-label="Priority"] .row-mark')];
    assert.deepEqual(marks.map((mark) => mark.dataset.tip), ["Finished", "Claude thread"]);

    await act(async () => { actions[0]!.click(); });
    assert.ok(menuItem("Rename"));
    assert.equal(menuItem("Dismiss"), undefined, "the row's own button is the one way to dismiss it");
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });

    await act(async () => { actions[1]!.click(); });
    assert.deepEqual(dismissed, ["done"]);
  } finally { await view.unmount(); }
});

test("a thread rename refuses a blank name with a mark, and a blank field left behind keeps the old name", async () => {
  const renamed: string[] = [];
  const view = await mount(renderProjectSidebar({
    projects: [{ id: "p", root: "/work/p" }],
    activityThreads: listed(task("t", { projectId: "p", title: "Old title" })),
    onRenameThread: (_id, title) => { renamed.push(title); },
  }));
  try {
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { query(view.container, ".task-row").dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
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

  const all = await mount(renderProjectSidebar({ projects: [{ id: "web", root: "/work/web" }, { id: "api", root: "/work/api" }] }));
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
