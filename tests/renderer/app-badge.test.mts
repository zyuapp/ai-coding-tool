import assert from "node:assert/strict";
import { test } from "vitest";
import { showUnreadCount } from "../../src/renderer/task-workspace/app-badge.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";

const finding = { id: "finding-1", headline: "5xx on checkout", at: 2 };

/** The window the count is sent through, kept to the one call the icon needs. */
function fakeWindow() {
  const counts: number[] = [];
  const desktop = { setBadgeCount: (count: number) => { counts.push(count); } } satisfies Pick<DesktopAPI, "setBadgeCount">;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { desktop } });
  return counts;
}

function withWindow(run: (counts: number[]) => void) {
  const counts = fakeWindow();
  try {
    run(counts);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
}

function countOf(tasks: Thread[], sideChats: { id: string; sourceThreadId: string; error: null }[] = []) {
  return deriveView(workspace({ threads: tasks, sideChats })).unreadCount;
}

test("the count is one for every thread carrying an unseen mark", () => {
  assert.equal(countOf([
    task("open"),
    task("failed", { outcome: "failed", outcomeUnread: true }),
    task("found", { findings: [finding] }),
    task("read", { outcome: "finished" }),
    task("filed", { findings: [{ ...finding, read: true }] }),
  ]), 2);
});

test("threads the user has seen leave the icon with no count at all", () => {
  assert.equal(countOf([task("open"), task("read", { outcome: "finished" })]), 0);
});

test("a side chat counts once, under the thread whose dock holds it", () => {
  const tasks = [
    task("main-task"),
    task("chat-1", { outcome: "finished", outcomeUnread: true }),
    task("chat-2", { outcome: "failed", outcomeUnread: true }),
  ];
  const chats = [
    { id: "chat-1", sourceThreadId: "main-task", error: null },
    { id: "chat-2", sourceThreadId: "main-task", error: null },
  ];
  assert.equal(countOf(tasks, chats), 1);
});

test("the icon carries whatever count it is handed", () => {
  withWindow((counts) => {
    showUnreadCount(3);
    showUnreadCount(0);
    assert.deepEqual(counts, [3, 0]);
  });
});
