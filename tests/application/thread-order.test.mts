import assert from "node:assert/strict";
import { test } from "vitest";
import { activitySections, backfillSortIndex, moveThread, nextSortIndex, orderThreads } from "../../src/application/thread-order.ts";
import type { Thread } from "../../src/domain/thread.ts";

function task(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    engine: "claude",
    executionPolicy: "confirm",
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
    ...overrides,
  };
}

function ids(threads: Thread[]) {
  return orderThreads(threads.filter((item) => item.archivedAt === undefined)).map((item) => item.id);
}

test("sort index outranks recency, and tasks without one fall back to it", () => {
  const threads = [
    task("a", { sortIndex: 1, updatedAt: 10 }),
    task("b", { sortIndex: 0, updatedAt: 5 }),
    task("older", { updatedAt: 2 }),
    task("newer", { updatedAt: 9 }),
  ];
  assert.deepEqual(orderThreads(threads).map((item) => item.id), ["b", "a", "newer", "older"]);
});

test("backfill freezes the loaded order and leaves settled tasks untouched", () => {
  const settled = [task("a", { sortIndex: 0 }), task("b", { sortIndex: 1 })];
  assert.equal(orderThreads(settled), settled);
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
  const threads = [task("a", { sortIndex: 0 }), task("b", { sortIndex: 1 }), task("c", { sortIndex: 2 })];
  assert.deepEqual(ids(moveThread(threads, "c", { projectId: null, index: 0 })), ["c", "a", "b"]);
  assert.deepEqual(ids(moveThread(threads, "a", { projectId: null, index: 1 })), ["b", "a", "c"]);
  assert.deepEqual(ids(moveThread(threads, "a", { projectId: null, index: 9 })), ["b", "c", "a"]);
  assert.deepEqual(moveThread(threads, "a", { projectId: null, index: 0 }).map((item) => item.updatedAt), [1, 1, 1]);
});

test("a drop into another project reparents as well as repositions", () => {
  const threads = [
    task("a", { sortIndex: 0, projectId: "one" }),
    task("b", { sortIndex: 1, projectId: "two" }),
    task("loose", { sortIndex: 2 }),
  ];
  const reparented = moveThread(threads, "loose", { projectId: "two", index: 0 });
  assert.equal(reparented.find((item) => item.id === "loose")!.projectId, "two");
  assert.deepEqual(ids(reparented), ["a", "loose", "b"]);

  const detached = moveThread(reparented, "loose", { projectId: null, index: 0 });
  assert.equal("projectId" in detached.find((item) => item.id === "loose")!, false);
});

test("a drop into an empty project still joins it", () => {
  const threads = [task("a", { sortIndex: 0, projectId: "one" }), task("loose", { sortIndex: 1 })];
  const moved = moveThread(threads, "loose", { projectId: "empty", index: 0 });
  assert.equal(moved.find((item) => item.id === "loose")!.projectId, "empty");
  assert.deepEqual(ids(moved), ["loose", "a"]);
});

test("unknown and archived tasks leave the list alone", () => {
  const threads = [task("a", { sortIndex: 0 }), task("gone", { sortIndex: 1, archivedAt: 5 })];
  assert.equal(moveThread(threads, "missing", { projectId: null, index: 0 }), threads);
  assert.equal(moveThread(threads, "gone", { projectId: null, index: 0 }), threads);
});

test("a thread working in a checkout reorders in its project's list but never leaves that project", () => {
  const threads = [
    task("loose", { projectId: "project-1", sortIndex: 0 }),
    task("first", { projectId: "project-1", worktreeId: "wt1", sortIndex: 1 }),
    task("second", { projectId: "project-1", worktreeId: "wt1", sortIndex: 2 }),
  ];

  const reordered = moveThread(threads, "second", { projectId: "project-1", index: 0 });
  assert.deepEqual(ids(reordered), ["second", "loose", "first"], "one list, so the index counts every row the project holds");

  assert.equal(moveThread(threads, "first", { projectId: "project-2", index: 0 }), threads, "a checkout is cut from one project, so nothing drags a thread in one to another");
  assert.equal(moveThread(threads, "first", { projectId: null, index: 0 }), threads, "and nothing drags one out to the project-less list");
});

test("activity leads with the threads that want the user, and every thread appears once", () => {
  const threads = [
    task("quiet", { createdAt: 1 }),
    task("busy", { createdAt: 2 }),
    task("asked", { createdAt: 3 }),
    task("settled", { createdAt: 5, outcome: "finished" }),
    task("newest", { createdAt: 9 }),
    /** Working again after its last run settled: the verdict is stale, so the work wins. */
    task("both", { createdAt: 4, outcome: "finished" }),
    /** Asking, and carrying a verdict from before: it belongs to Priority once, for the question. */
    task("asked-again", { createdAt: 6, outcome: "failed" }),
  ];

  const sections = activitySections(threads, new Set(["busy", "both", "asked", "asked-again"]), new Set(["asked", "asked-again"]));

  assert.deepEqual(sections.priority.map((item) => item.id), ["asked-again", "settled", "asked"]);
  assert.deepEqual(sections.running.map((item) => item.id), ["busy", "both"], "a working thread keeps its sidebar place, however its last run ended");
  assert.deepEqual(sections.threads.map((item) => item.id), ["newest", "quiet"]);
  assert.deepEqual(
    [...sections.priority, ...sections.running, ...sections.threads].map((item) => item.id).sort(),
    threads.map((item) => item.id).sort(),
    "the three lists partition the threads rather than repeating or losing any",
  );
});

test("running holds the sidebar's order, so a thread speaking never moves the rows", () => {
  const threads = [
    task("first", { sortIndex: 0, createdAt: 1 }),
    task("second", { sortIndex: 1, createdAt: 2 }),
  ];
  const busy = new Set(["first", "second"]);

  assert.deepEqual(activitySections(threads, busy, new Set()).running.map((item) => item.id), ["first", "second"]);

  const spoke: Thread[] = [threads[0], { ...threads[1], messages: [{ id: "m", kind: "assistant", text: "working", at: 500 }] }];
  assert.deepEqual(activitySections(spoke, busy, new Set()).running.map((item) => item.id), ["first", "second"]);
});

test("a thread carrying a verdict ranks in Priority only while it is idle", () => {
  const threads = [task("done", { createdAt: 1, outcome: "finished" })];

  assert.deepEqual(activitySections(threads, new Set(), new Set()).priority.map((item) => item.id), ["done"]);
  assert.deepEqual(activitySections(threads, new Set(["done"]), new Set()).priority, [], "starting work on it takes it out of Priority");
  assert.deepEqual(activitySections(threads, new Set(["done"]), new Set()).running.map((item) => item.id), ["done"]);
});

test("activity dates a thread by what it last did, not by every write to it", () => {
  const threads = [
    task("stale-run", { createdAt: 1, runEndedAt: 50, updatedAt: 99 }),
    task("fresh-message", { createdAt: 2, messages: [{ id: "m", kind: "user", text: "hi", at: 80 }], updatedAt: 3 }),
  ];

  assert.deepEqual(activitySections(threads, new Set(), new Set()).threads.map((item) => item.id), ["fresh-message", "stale-run"]);
});

test("activity sections keep input order when activity ties", () => {
  const threads = [
    task("priority-first", { outcome: "finished" }),
    task("running", { sortIndex: 0 }),
    task("thread-first"),
    task("priority-second", { outcome: "failed" }),
    task("thread-second"),
  ];

  const sections = activitySections(threads, new Set(["running"]), new Set());
  assert.deepEqual(sections.priority.map((item) => item.id), ["priority-first", "priority-second"]);
  assert.deepEqual(sections.running.map((item) => item.id), ["running"]);
  assert.deepEqual(sections.threads.map((item) => item.id), ["thread-first", "thread-second"]);
});
