import assert from "node:assert/strict";
import { test } from "vitest";
import { deriveView } from "../../src/application/workspace-state.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { task, workspace } from "../application/workspace-reducer-fixtures.mts";

const finding = { id: "finding-1", headline: "5xx on checkout", at: 2 };

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
