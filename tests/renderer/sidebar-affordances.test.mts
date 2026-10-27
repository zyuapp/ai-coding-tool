import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act, useState } from "react";
import { mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar } from "../support/sidebar.mts";
import { automationView } from "../support/desktop-api.mts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import type { ProjectSidebarProps } from "../../src/renderer/components/ProjectSidebar.tsx";

function menuItems() {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

function menuItem(label: string) {
  return menuItems().find((button) => button.textContent === label);
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

    await act(async () => { menuItem("Archive")!.click(); });
    assert.deepEqual(archived, ["here"]);
    assert.equal(menuItems().length, 0);

    assert.equal(query<HTMLButtonElement>(view.container, '[aria-label="Archive here"]').dataset.tip, "Archive");
  } finally { await view.unmount(); }
});

test("a row's hover text says what each of its marks means, and plain rows say only their title", async () => {
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
    const titles = [...view.container.querySelectorAll<HTMLElement>(".project-task-row")].map((row) => row.title);
    assert.deepEqual(titles, [
      "asked\nNeeds approval",
      "scheduled\nRuns on a schedule, and its last run failed",
      "plain",
      "away\nlaptop is offline",
    ]);
    assert.ok(query(view.container, ".task-automation").classList.contains("trouble"), "a failed schedule is drawn apart");
  } finally { await view.unmount(); }
});

test("removing a folder that holds threads asks once more, naming them; an empty folder goes at once", async () => {
  const removed: string[] = [];
  const props: Partial<ProjectSidebarProps> = {
    projects: [{ id: "full", root: "/work/full" }, { id: "empty", root: "/work/empty" }],
    expandedProjects: new Set(["full"]),
    orderedThreads: [task("one", { projectId: "full" }), task("two", { projectId: "full" })],
    onRemoveProject: (id) => { removed.push(id); },
  };
  const view = await mount(React.createElement(Harness, props));
  try {
    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="More options for full"]').click(); });
    await act(async () => { menuItem("Remove")!.click(); });
    assert.deepEqual(removed, [], "the first choice only asks");
    await act(async () => { menuItem("Remove and archive 2 threads")!.click(); });
    assert.deepEqual(removed, ["full"]);
  } finally { await view.unmount(); }

  const again = await mount(React.createElement(Harness, props));
  try {
    await act(async () => { query<HTMLButtonElement>(again.container, '[aria-label="More options for empty"]').click(); });
    await act(async () => { menuItem("Remove")!.click(); });
    assert.deepEqual(removed, ["full", "empty"]);
  } finally { await again.unmount(); }
});

test("with no projects at all, the sidebar offers adding one and keeps the heading's add button shown", async () => {
  let opened = 0;
  const view = await mount(renderProjectSidebar({ projects: [], onOpenFolder: () => { opened += 1; } }));
  try {
    assert.equal(query(view.container, ".sidebar-project-empty p").textContent, "No projects yet");
    await act(async () => { query<HTMLButtonElement>(view.container, ".sidebar-project-empty .sidebar-empty-action").click(); });
    const add = query<HTMLButtonElement>(view.container, '.projects-heading [aria-label="Add project"]');
    assert.ok(add.classList.contains("shown"));
    assert.equal(add.dataset.tip, "Add project");
    await act(async () => { add.click(); });
    assert.equal(opened, 2);
  } finally { await view.unmount(); }

  const listed = await mount(renderProjectSidebar({ projects: [{ id: "p", root: "/work/p" }] }));
  try {
    assert.equal(listed.container.querySelector(".sidebar-project-empty"), null);
    assert.equal(query(listed.container, '.projects-heading [aria-label="Add project"]').classList.contains("shown"), false);
  } finally { await listed.unmount(); }
});

test("Recents offers one new-chat button and no menu that repeats it", async () => {
  let started = 0;
  const view = await mount(renderProjectSidebar({ onNewThread: () => { started += 1; } }));
  try {
    const heading = query(view.container, ".recents-heading");
    assert.equal(heading.querySelector(".menu-trigger"), null);
    const button = query<HTMLButtonElement>(heading, '[aria-label="New chat"]');
    assert.equal(button.dataset.tip, "New chat");
    await act(async () => { button.click(); });
    assert.equal(started, 1);
  } finally { await view.unmount(); }
});

test("the header's buttons name themselves and their keystrokes", async () => {
  const view = await mount(renderProjectSidebar({ canGoBack: true, canGoForward: true }));
  try {
    assert.match(query(view.container, '[aria-label="Go back"]').dataset.tip ?? "", /^Back \(.+\[\)$/);
    assert.match(query(view.container, '[aria-label="Go forward"]').dataset.tip ?? "", /^Forward \(.+\]\)$/);
    assert.match(query(view.container, '.new-task-button').dataset.tip ?? "", /^New thread \(.+N\)$/);
    assert.equal(query(view.container, '[aria-label="Rank threads by activity"]').dataset.tip, "Rank by activity");
  } finally { await view.unmount(); }

  const activity = await mount(renderProjectSidebar({ mode: "activity" }));
  try {
    assert.equal(query(activity.container, '[aria-label="Rank threads by activity"]').dataset.tip, "Group by project");
  } finally { await activity.unmount(); }
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
