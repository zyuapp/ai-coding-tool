import assert from "node:assert/strict";
import { test, vi } from "vitest";
import React, { act, useState } from "react";
import { dom, mount, query } from "../support/renderer-dom.mts";
import { renderProjectSidebar, seedProjectTasks } from "../support/sidebar.mts";
import { fakeDesktop } from "../support/desktop-api.mts";
import { task } from "../application/workspace-reducer-fixtures.mts";
import { createSnoozeTimer } from "../../src/renderer/task-workspace/snooze-timer.ts";
import { App } from "../../src/renderer/App.tsx";

function menuItem(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === label);
}

test("Priority's right-click submenu snoozes a thread, and opening it in Threads keeps it there", async () => {
  seedProjectTasks([
    { id: "quiet", title: "Quiet", updatedAt: 1 },
    { id: "waiting", title: "Review me", updatedAt: 2, outcome: "finished" },
  ]);
  const desktop = fakeDesktop();
  window.desktop = desktop;
  const view = await mount(React.createElement(App));
  try {
    await act(async () => { query<HTMLButtonElement>(view.container, '[aria-label="Rank threads by activity"]').click(); });
    const row = query<HTMLElement>(view.container, 'nav[aria-label="Priority"] .task-row');
    await act(async () => { row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 120 })); });
    assert.ok(menuItem("Snooze"));
    await act(async () => { menuItem("Snooze")!.click(); });
    const submenu = query(document.body, ".menu-submenu");
    assert.deepEqual([...submenu.querySelectorAll("button")].map((button) => button.textContent), ["1 hour", "4 hours", "1 day", "3 days", "1 week"]);
    await act(async () => { menuItem("3 days")!.click(); });
    assert.equal(view.container.querySelector('nav[aria-label="Priority"] .task-row'), null);
    assert.equal(document.querySelector('[role="menu"]'), null);
    const snoozed = query<HTMLElement>(view.container, 'nav[aria-label="Threads"] .task-row[title="Review me"]');
    await act(async () => { snoozed.click(); });
    assert.ok(snoozed.classList.contains("active"));
    assert.equal(view.container.querySelector('nav[aria-label="Priority"] .task-row'), null);
    await act(async () => { snoozed.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true })); });
    assert.equal(menuItem("Snooze"), undefined, "the same thread's menu follows the section it is now in");
    assert.ok(menuItem("Rename"));
    const stored = desktop.persisted.flatMap((delta) => delta.tasks).findLast(({ task }) => task.id === "waiting");
    assert.ok(stored?.task.snoozedUntil);
    assert.ok(Math.abs(stored.task.snoozedUntil - Date.now() - 72 * 3_600_000) < 5000);
  } finally { await view.unmount(); }
});

test("snooze is offered on approval rows and gated by the actual section, including project lists", async () => {
  const asked = task("asked", { outcome: "finished" });
  const busy = task("busy");
  let snoozed: unknown;
  function Harness({ projects = false }: { projects?: boolean }) {
    const [openMenu, onSetOpenMenu] = useState<string | null>(null);
    return renderProjectSidebar({
      mode: projects ? "projects" : "activity", openMenu, onSetOpenMenu,
      recentThreads: [asked, busy], orderedThreads: [asked, busy],
      activityThreads: { priority: [asked], running: [busy], threads: [] },
      blockedThreadIds: new Set([asked.id]), runningThreadIds: new Set([asked.id, busy.id]),
      onSnoozeThread: (id, hours) => { snoozed = { id, hours }; },
    });
  }
  const view = await mount(React.createElement(Harness));
  try {
    const open = async (selector: string) => act(async () => {
      query<HTMLElement>(view.container, selector).dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    });
    await open('nav[aria-label="Priority"] .task-row');
    assert.ok(menuItem("Snooze"));
    await act(async () => { menuItem("Snooze")!.click(); });
    await act(async () => { menuItem("1 hour")!.click(); });
    assert.deepEqual(snoozed, { id: "asked", hours: 1 });
    await open('nav[aria-label="Running"] .task-row');
    assert.equal(menuItem("Snooze"), undefined);
    await view.render(React.createElement(Harness, { projects: true }));
    await open('.task-row[title="asked"]');
    assert.ok(menuItem("Archive"));
    assert.equal(menuItem("Snooze"), undefined);
  } finally { await view.unmount(); }
});

test("one snooze timer follows wall time after sleep, replaces its deadline and stops on disposal", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const start = 1_800_000_000_000;
  vi.setSystemTime(start);
  const elapsed: number[] = [];
  const timer = createSnoozeTimer((at) => elapsed.push(at));
  try {
    timer.schedule(start + 3_600_000);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.deepEqual(elapsed, []);
    timer.schedule(start + 4 * 3_600_000);
    assert.equal(vi.getTimerCount(), 1);
    vi.setSystemTime(start + 5 * 3_600_000);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(elapsed.length, 1);
    assert.equal(vi.getTimerCount(), 0);
    timer.schedule(Date.now() + 10);
    timer.dispose();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(elapsed.length, 1);
  } finally { timer.dispose(); vi.useRealTimers(); }
});
