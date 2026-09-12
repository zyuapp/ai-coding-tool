import { renderProjectSidebar, seedProjectTasks } from "../support/sidebar.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";

import type { Thread } from "../../src/domain/thread.ts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";

const { App } = await import("../../src/renderer/App.tsx");
const { ProjectSidebar } = await import("../../src/renderer/components/ProjectSidebar.tsx");

test("a sidebar row renames itself on a double click, and on the menu's Rename", async () => {
  seedProjectTasks([{ id: "only", title: "First task", sortIndex: 0, updatedAt: 1 }]);
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));
  const setValue = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  const row = () => query<HTMLElement>(view.container, ".project-task-row");
  const type = async (title: string, key: string) => {
    const input = query<HTMLInputElement>(view.container, ".task-rename");
    await act(async () => {
      item(setValue).call(input, title);
      input.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    });
  };

  await act(async () => { row().dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true })); });
  await type("Nightly audit", "Enter");
  assert.equal(view.container.querySelector(".task-rename"), null);
  assert.equal(row().textContent.includes("Nightly audit"), true);

  await act(async () => { row().dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
  assert.deepEqual([...document.querySelectorAll(".context-menu-popover > button")].map((button) => button.textContent), ["Rename", "Role", "Copy link", "Fork", "Fork into a new worktree", "Archive"]);
  await act(async () => { query<HTMLButtonElement>(document, ".context-menu-popover button").click(); });
  await type("Abandoned edit", "Escape");
  assert.equal(view.container.querySelector(".task-rename"), null);
  assert.equal(row().textContent.includes("Nightly audit"), true, "Escape leaves the name the row started with");
  await view.unmount();
});

test("a folder's menu opens on its trigger and every choice closes it", async () => {
  const opened: Array<string | null> = [];
  const removed: string[] = [];
  const sidebar = (openMenu: string | null) => renderProjectSidebar({
    inactive: false,
    projects: [{ id: "project-1", root: "/project" }],
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["project-1"]),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu,
    settingsOpen: false,
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRenameProject() {}, onEditProject() {},
    onRemoveProject: (id) => { removed.push(id); },
    onSetMode() {}, onSetSectionOpen() {},
    onSetOpenMenu: (menu) => { opened.push(menu); },
    onSelectThread() {}, onArchiveThread() {}, onDismissThread() {}, onDismissAll() {}, onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  });

  const view = await mount(sidebar(null));
  const trigger = () => query<HTMLButtonElement>(view.container, '[aria-label="More options for project"]');
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  assert.equal(view.container.querySelector(".project-menu .menu-popover"), null, "a shut menu renders no list");

  await act(async () => { trigger().click(); });
  assert.deepEqual(opened, ["project:project-1"], "the trigger names the menu it opens");

  await view.render(sidebar("project:project-1"));
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  const items = [...view.container.querySelectorAll<HTMLButtonElement>(".project-menu .menu-popover button")];
  assert.deepEqual(items.map((item) => item.textContent), ["New task", "Edit…", "Remove"]);

  await act(async () => { item(items[2]).click(); });
  assert.deepEqual(removed, ["project-1"]);
  assert.equal(opened.at(-1), null, "choosing an item closes the menu without the item saying so");
  await view.unmount();
});

test("a folder is lifted by its own row, and lifting one leaves every folded folder folded", async () => {
  const moves: Array<[string, number]> = [];
  const projects = [{ id: "first-project", root: "/first", sortIndex: 0 }, { id: "second-project", root: "/second", sortIndex: 1 }];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects,
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onMoveThread() {},
    onMoveProject: (projectId, index) => { moves.push([projectId, index]); },
    onOpenSettings() {},
  }));

  const handle = query<HTMLElement>(view.container, '[data-rfd-drag-handle-draggable-id="second-project"]');
  assert.ok(handle.className.includes("project-row"), "the header row is the handle, so there is nothing extra to aim at");

  await act(async () => {
    handle.focus();
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", keyCode: 32, bubbles: true, cancelable: true }));
  });
  assert.equal(view.container.querySelector('[data-rfd-droppable-id="first-project"]'), null, "a folded folder holds no drop target of its own");

  await act(async () => {
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  });
  assert.deepEqual(moves, [], "an abandoned drag moves nothing");
  await view.unmount();
});

test("a thread drag leaves a folded folder folded, and opens no gap where it sits", async () => {
  const task = (id: string, projectId: string): Thread => ({
    id, title: id, ...(projectId ? { projectId } : {}), engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, sortIndex: 0, updatedAt: 1,
  });
  const projects = [{ id: "open-project", root: "/open" }, { id: "shut-project", root: "/shut" }];
  const tasks = [task("open-task", "open-project"), task("shut-task", "shut-project")];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects,
    orderedThreads: tasks,
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(["open-project"]),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: false, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewThread() {}, onOpenFolder() {}, onToggleProject() {}, onRemoveProject() {},
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onDismissThread() {}, onDismissAll() {}, onMoveThread() {}, onMoveProject() {}, onOpenSettings() {},
  }));

  const folded = () => [...view.container.querySelectorAll('[data-rfd-droppable-id="shut-project"], .task-list')];
  assert.deepEqual(folded(), [], "a folded folder and a folded Recents render nothing to lay out");

  const handle = query<HTMLElement>(view.container, '[data-rfd-drag-handle-draggable-id="open-task"]');
  await act(async () => {
    handle.focus();
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", keyCode: 32, bubbles: true, cancelable: true }));
  });

  assert.deepEqual(folded(), [], "the drag opens no strip under either of them");
  assert.equal(view.container.querySelectorAll('[data-rfd-draggable-id="shut-task"]').length, 0, "and reveals nothing they hold");
  await act(async () => {
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  });
  await view.unmount();
});

test("an expanded folder shows ten tasks, and reveals the rest on demand", async () => {
  seedProjectTasks(Array.from({ length: 13 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    sortIndex: index,
    updatedAt: index,
  })));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const rows = () => view.container.querySelectorAll(".project-task-row");
  const showMore = () => query<HTMLButtonElement>(view.container, ".show-more");
  assert.equal(rows().length, 10);
  assert.equal(showMore().textContent, "Show 3 more");

  await act(async () => { showMore().click(); });
  assert.equal(rows().length, 13);
  assert.equal(showMore().textContent, "Show less");

  await act(async () => { showMore().click(); });
  assert.equal(rows().length, 10);
  await view.unmount();
});

test("a folder keeps the open task in view past the first ten", async () => {
  seedProjectTasks(Array.from({ length: 13 }, (_, index) => ({
    id: `task-${index}`,
    title: `Task ${index}`,
    sortIndex: index,
    updatedAt: index,
  })));
  window.desktop = fakeDesktop();
  const view = await mount(React.createElement(App));

  const titles = () => [...view.container.querySelectorAll(".project-task-row > span:first-child")].map((row) => row.textContent);
  await act(async () => { query<HTMLButtonElement>(view.container, ".show-more").click(); });
  const eleventh = item([...view.container.querySelectorAll<HTMLElement>(".project-task-row")].find((row) => row.textContent.startsWith("Task 11")));
  await act(async () => { eleventh.click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, ".show-more").click(); });

  assert.equal(titles().length, 12);
  assert.equal(titles().at(-1), "Task 11");
  assert.equal(query(view.container, ".show-more").textContent, "Show 1 more");
  await view.unmount();
});

test("a folder lifts from a press on its name, which is a button", async () => {
  const moves: Array<[string, number]> = [];
  const folded: string[] = [];
  const projects = [{ id: "first-project", root: "/first", sortIndex: 0 }, { id: "second-project", root: "/second", sortIndex: 1 }];
  const view = await mount(renderProjectSidebar({
    inactive: false,
    projects,
    orderedThreads: [],
    recentThreads: [],
    currentId: null,
    draftProjectId: null,
    expandedProjects: new Set(),
    runningThreadIds: new Set(),
    blockedThreadIds: new Set(),
    schedules: new Map(),
    worktreeGroups: [],
    worktreeThreadIds: new Set(),
    activityThreads: { priority: [], running: [], threads: [] },
    mode: "projects",
    sections: { projects: true, recents: true, priority: true, running: true, threads: true },
    openMenu: null,
    settingsOpen: false,
    onNewThread() {}, onOpenFolder() {}, onRemoveProject() {},
    onToggleProject: (projectId) => { folded.push(projectId); },
    onSetMode() {}, onSetSectionOpen() {}, onSetOpenMenu() {},
    onSelectThread() {}, onArchiveThread() {}, onMoveThread() {},
    onMoveProject: (projectId, index) => { moves.push([projectId, index]); },
    onOpenSettings() {},
  }));

  const name = item(view.container.querySelectorAll<HTMLButtonElement>(".project-main")[1]);
  const mouse = (type: string, target: EventTarget, y: number) => target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: y }));
  await act(async () => { mouse("mousedown", name, 40); });
  await act(async () => { mouse("mousemove", dom.window, 4); });
  assert.ok(view.container.querySelector(".project-group.is-dragging"), "a press on the folder's name lifts it");
  await act(async () => { mouse("mouseup", dom.window, 4); });

  await act(async () => {
    mouse("mousedown", name, 40);
    mouse("mouseup", name, 40);
    name.click();
  });
  assert.deepEqual(folded, ["second-project"], "a press that goes nowhere still folds the row");
  await view.unmount();
});
