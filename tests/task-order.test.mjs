import assert from "node:assert/strict";
import test from "node:test";
import { backfillSortIndex, moveTask, nextSortIndex, orderTasks } from "../dist/main/application/task-order.js";

function task(id, overrides = {}) {
  return {
    id,
    title: id,
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

function ids(tasks) {
  return orderTasks(tasks.filter((item) => item.archivedAt === undefined)).map((item) => item.id);
}

test("sort index outranks recency, and tasks without one fall back to it", () => {
  const tasks = [
    task("a", { sortIndex: 1, updatedAt: 10 }),
    task("b", { sortIndex: 0, updatedAt: 5 }),
    task("older", { updatedAt: 2 }),
    task("newer", { updatedAt: 9 }),
  ];
  assert.deepEqual(orderTasks(tasks).map((item) => item.id), ["b", "a", "newer", "older"]);
});

test("backfill freezes the loaded order and leaves settled tasks untouched", () => {
  const settled = [task("a", { sortIndex: 0 }), task("b", { sortIndex: 1 })];
  assert.equal(backfillSortIndex(settled), settled);

  const mixed = backfillSortIndex([task("a", { sortIndex: 0 }), task("b", { updatedAt: 9 }), task("c", { updatedAt: 3 })]);
  assert.deepEqual(mixed.map((item) => [item.id, item.sortIndex]), [["a", 0], ["b", 1], ["c", 2]]);
  assert.deepEqual(nextSortIndex(mixed), -1);
});

test("new tasks land above everything, including a list that was never reordered", () => {
  assert.equal(nextSortIndex([]), -1);
  assert.equal(nextSortIndex([task("a", { sortIndex: -3 }), task("b", { sortIndex: 4 })]), -4);
});

test("a drop lands at its slot and past the end without touching recency", () => {
  const tasks = [task("a", { sortIndex: 0 }), task("b", { sortIndex: 1 }), task("c", { sortIndex: 2 })];
  assert.deepEqual(ids(moveTask(tasks, "c", { projectId: null, index: 0 })), ["c", "a", "b"]);
  assert.deepEqual(ids(moveTask(tasks, "a", { projectId: null, index: 1 })), ["b", "a", "c"]);
  assert.deepEqual(ids(moveTask(tasks, "a", { projectId: null, index: 9 })), ["b", "c", "a"]);
  assert.deepEqual(moveTask(tasks, "a", { projectId: null, index: 0 }).map((item) => item.updatedAt), [1, 1, 1]);
});

test("a drop into another project reparents as well as repositions", () => {
  const tasks = [
    task("a", { sortIndex: 0, projectId: "one" }),
    task("b", { sortIndex: 1, projectId: "two" }),
    task("loose", { sortIndex: 2 }),
  ];
  const reparented = moveTask(tasks, "loose", { projectId: "two", index: 0 });
  assert.equal(reparented.find((item) => item.id === "loose").projectId, "two");
  assert.deepEqual(ids(reparented), ["a", "loose", "b"]);

  const detached = moveTask(reparented, "loose", { projectId: null, index: 0 });
  assert.equal("projectId" in detached.find((item) => item.id === "loose"), false);
});

test("a drop into an empty project still joins it", () => {
  const tasks = [task("a", { sortIndex: 0, projectId: "one" }), task("loose", { sortIndex: 1 })];
  const moved = moveTask(tasks, "loose", { projectId: "empty", index: 0 });
  assert.equal(moved.find((item) => item.id === "loose").projectId, "empty");
  assert.deepEqual(ids(moved), ["loose", "a"]);
});

test("unknown and archived tasks leave the list alone", () => {
  const tasks = [task("a", { sortIndex: 0 }), task("gone", { sortIndex: 1, archivedAt: 5 })];
  assert.equal(moveTask(tasks, "missing", { projectId: null, index: 0 }), tasks);
  assert.equal(moveTask(tasks, "gone", { projectId: null, index: 0 }), tasks);
});
