import assert from "node:assert/strict";
import { test } from "vitest";
import { showUnreadCount } from "../../src/renderer/task-workspace/app-badge.ts";
import type { DesktopAPI } from "../../src/contracts/ipc.ts";
import type { Task } from "../../src/domain/task.ts";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    engine: "claude",
    executionPolicy: "confirm",
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 0 },
    ...overrides,
  };
}

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

test("the count is one for every thread carrying an unseen mark", () => {
  withWindow((counts) => {
    showUnreadCount([
      task("open"),
      task("failed", { outcome: "failed", outcomeUnread: true }),
      task("found", { findings: [finding] }),
      task("read", { outcome: "finished" }),
      task("filed", { findings: [{ ...finding, read: true }] }),
    ]);
    assert.deepEqual(counts, [2]);
  });
});

test("threads the user has seen leave the icon with no count at all", () => {
  withWindow((counts) => {
    showUnreadCount([task("open"), task("read", { outcome: "finished" })]);
    assert.deepEqual(counts, [0]);
  });
});
