import assert from "node:assert/strict";
import { test } from "vitest";
import type { TaskStoreDelta } from "../../src/contracts/ipc.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { appendMessages, replaceLastMessage, withdrawMessages } from "../../src/domain/conversation-updates.ts";
import {
  drainLatestPersistence,
  storeBackfill,
  persistedStoreState,
  persistenceDelta,
  hasPersistenceChanges,
  adoptPersistedMessages,
  type PersistenceQueue,
  type PersistenceState,
} from "../../src/renderer/task-workspace/workspace-persistence.ts";

function snapshot(text: string): PersistenceState {
  const task: Thread = {
    id: "task-1",
    title: "Task",
    engine: "claude",
    executionPolicy: "confirm",
    messages: [{ id: "message-1", kind: "assistant", text, at: 1 }],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: 1 },
    updatedAt: 1,
  };
  return { threads: [task], subagents: {}, sideChats: [], projects: [], worktrees: [], lastFolder: null };
}

test("slow persistence keeps only the latest workspace snapshot queued", async () => {
  const queue: PersistenceQueue = { persisted: null, pending: snapshot("one"), inFlight: null };
  const firstWrite = Promise.withResolvers<void>();
  const deltas: TaskStoreDelta[] = [];
  const draining = drainLatestPersistence(queue, async (delta) => {
    deltas.push(delta);
    if (deltas.length === 1) await firstWrite.promise;
  });
  await Promise.resolve();

  queue.pending = snapshot("one two");
  queue.pending = snapshot("one two three");
  let flushed = false;
  const flushing = drainLatestPersistence(queue, async () => assert.fail("a second drain must not start"))
    .then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);
  assert.equal(deltas.length, 1);

  firstWrite.resolve();
  await Promise.all([draining, flushing]);
  assert.equal(flushed, true);
  assert.equal(deltas.length, 2);
  assert.equal(deltas[1].tasks[0].messages[0].message.text, "one two three");
});

test("startup backfill preserves a worktree created before the store finished loading", () => {
  const current = snapshot("working");
  current.worktrees = [{
    id: "wt1",
    projectId: "project-1",
    root: "/worktrees/repo-wt1",
    workspaceId: "workspace-wt1",
    baseCommit: "abcdef1",
    createdAt: 1,
    lastUsedAt: 1,
  }];
  const delta = storeBackfill({ version: 2, tasks: [], projects: [], worktrees: [], lastFolder: null }, current);

  assert.deepEqual(delta.worktrees, current.worktrees);
  assert.equal(delta.tasks[0]?.task.id, "task-1");
});


test("a failed write keeps its snapshot pending and leaves its durable baseline unchanged", async () => {
  const before = snapshot("before");
  const after = snapshot("after");
  const queue: PersistenceQueue = { persisted: before, pending: after, inFlight: null };
  await assert.rejects(drainLatestPersistence(queue, async () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(queue.persisted, before);
  assert.equal(queue.pending, after);
  assert.equal(queue.inFlight, null);
  const writes: TaskStoreDelta[] = [];
  await drainLatestPersistence(queue, async (delta) => { writes.push(delta); });
  assert.equal(queue.persisted, after);
  assert.equal(queue.pending, null);
  assert.equal(writes[0].tasks[0].messages[0].message.text, "after");
});

test("a failed in-flight write retains a newer pending snapshot and rejects all flush callers", async () => {
  const before = snapshot("before");
  const latest = snapshot("latest");
  const firstWrite = Promise.withResolvers<void>();
  const queue: PersistenceQueue = { persisted: before, pending: snapshot("middle"), inFlight: null };
  const draining = drainLatestPersistence(queue, () => firstWrite.promise);
  await Promise.resolve();
  queue.pending = latest;
  const flushing = drainLatestPersistence(queue, async () => assert.fail("concurrent writer"));
  const drainsRejected = assert.rejects(draining, /disk full/);
  const flushRejected = assert.rejects(flushing, /disk full/);
  firstWrite.reject(new Error("disk full"));
  await Promise.all([drainsRejected, flushRejected]);
  assert.equal(queue.persisted, before);
  assert.equal(queue.pending, latest);
  await drainLatestPersistence(queue, async (delta) => {
    assert.equal(delta.tasks[0].messages[0].message.text, "latest");
  });
  assert.equal(queue.persisted, latest);
});

test("startup persistence includes updates that arrive while its backfill is writing", async () => {
  const stored = { version: 2 as const, tasks: [], projects: [], worktrees: [], lastFolder: null };
  const initial = snapshot("initial");
  const latest = snapshot("latest");
  latest.worktrees = [{ id: "wt", projectId: "project", root: "/worktrees/wt", workspaceId: "workspace", baseCommit: "abc", createdAt: 1, lastUsedAt: 1 }];
  const queue: PersistenceQueue = { persisted: persistedStoreState(stored), pending: initial, inFlight: null };
  const firstWrite = Promise.withResolvers<void>();
  const writes: TaskStoreDelta[] = [];
  const draining = drainLatestPersistence(queue, async (delta) => {
    writes.push(delta);
    if (writes.length === 1) await firstWrite.promise;
  });
  await Promise.resolve();
  queue.pending = latest;
  firstWrite.resolve();
  await draining;
  assert.equal(writes.length, 2);
  assert.equal(writes[1].tasks[0].messages[0].message.text, "latest");
  assert.deepEqual(writes[1].worktrees, latest.worktrees);
  assert.equal(queue.persisted, latest);
});

test("a snapshot queued as the active write settles is included before flush resolves", async () => {
  const queue: PersistenceQueue = { persisted: null, pending: snapshot("first"), inFlight: null };
  const writes: string[] = [];
  const persist = async (delta: TaskStoreDelta) => { writes.push(delta.tasks[0].messages[0].message.text); };
  const draining = drainLatestPersistence(queue, persist);
  const active = queue.inFlight!;
  const latest = snapshot("latest");
  const pending = active.then(() => {
    queue.pending = latest;
    return drainLatestPersistence(queue, persist);
  });
  await Promise.all([draining, pending]);
  assert.deepEqual(writes, ["first", "latest"]);
  assert.equal(queue.persisted, latest);
});

test("UI-only changes do not inspect thread collections, and metadata edits do not inspect history", () => {
  const before = snapshot("old");
  let historyReads = 0;
  before.threads[0].messages = new Proxy(before.threads[0].messages, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) historyReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const metadataChange = { ...before, threads: [{ ...before.threads[0], title: "Renamed" }] };
  const delta = persistenceDelta(before, metadataChange);
  assert.equal(delta.tasks[0].task.title, "Renamed");
  assert.deepEqual(delta.tasks[0].messages, []);
  assert.equal(historyReads, 0);
  let threadReads = 0;
  before.threads = new Proxy(before.threads, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) threadReads++;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(hasPersistenceChanges(before, { ...before }), false);
  assert.deepEqual(persistenceDelta(before, { ...before }), { tasks: [] });
  assert.equal(threadReads, 0);
});

test("message edits before the last message are persisted, including coalesced changes", () => {
  const before = snapshot("first");
  before.threads[0].messages.push({ id: "message-2", kind: "assistant", text: "last", at: 2 });
  const next = {
    ...before,
    threads: [{ ...before.threads[0], messages: [{ ...before.threads[0].messages[0], withdrawn: true as const }, before.threads[0].messages[1]] }],
  };
  const delta = persistenceDelta(before, next);
  assert.deepEqual(delta.tasks[0].messages.map((item) => item.index), [0]);
  assert.equal(delta.tasks[0].messages[0].message.withdrawn, true);
});

test("side chats stay ephemeral when they are added, changed, and removed", () => {
  const before = snapshot("before");
  const sideChat = { ...snapshot("private").threads[0], id: "side" };
  const next = { ...before, threads: [...before.threads, sideChat], sideChats: [{ id: "side", sourceThreadId: "task-1", error: null }] };
  assert.deepEqual(persistenceDelta(before, next), { tasks: [] });
  const changed = { ...next, threads: [before.threads[0], { ...sideChat, title: "Changed" }] };
  assert.deepEqual(persistenceDelta(next, changed), { tasks: [] });
  assert.deepEqual(persistenceDelta(changed, before), { tasks: [] });
});


test("a large committed history does not get scanned again for an appended assistant block", () => {
  const before = snapshot("old");
  before.threads[0].messages = Array.from({ length: 20_000 }, (_, index) => ({ id: String(index), kind: "assistant" as const, text: "old", at: index }));
  let reads = 0;
  before.threads[0].messages = new Proxy(before.threads[0].messages, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const appended = appendMessages(before.threads[0].messages, [{ id: "new", kind: "assistant", text: "new", at: 20_000 }]);
  const messages = replaceLastMessage(appended, { ...appended.at(-1)!, text: "new block" });
  const next = { ...before, threads: [{ ...before.threads[0], messages }] };
  reads = 0;
  const delta = persistenceDelta(before, next);
  assert.equal(reads, 1);
  assert.deepEqual(delta.tasks[0].messages.map((item) => item.index), [20_000]);
  assert.equal(delta.tasks[0].messages[0].message.text, "new block");
  const withdrawn = { ...next, threads: [{ ...next.threads[0], messages: withdrawMessages(messages, 19_999) }] };
  assert.deepEqual(persistenceDelta(before, withdrawn).tasks[0].messages.map((item) => item.index), [19_999, 20_000]);
});

test("history hydration survives an active write and a newer queued metadata snapshot", async () => {
  const before = snapshot("disk message");
  const messages = before.threads[0].messages;
  before.threads[0] = { ...before.threads[0], messages: [], historySummary: { messageCount: 1, attachmentCount: 0 } };
  const first = { ...before, threads: [{ ...before.threads[0], title: "First title" }] };
  const queue: PersistenceQueue = { persisted: before, pending: first, inFlight: null };
  const firstWrite = Promise.withResolvers<void>();
  const writes: TaskStoreDelta[] = [];
  const drain = drainLatestPersistence(queue, async (delta) => {
    writes.push(delta);
    if (writes.length === 1) await firstWrite.promise;
  });
  await Promise.resolve();
  queue.pending = { ...first, threads: [{ ...first.threads[0], title: "Latest title" }] };
  adoptPersistedMessages(queue, "task-1", messages);
  firstWrite.resolve();
  await drain;
  assert.equal(queue.persisted?.threads[0].messages, messages);
  assert.equal(queue.persisted?.threads[0].title, "Latest title");
  assert.equal(queue.persisted?.threads[0].historySummary, undefined);
  assert.deepEqual(writes.map((delta) => delta.tasks[0].messages), [[], []]);
});

test("a failed write retains the hydrated history when retried", async () => {
  const before = snapshot("disk message");
  const messages = before.threads[0].messages;
  before.threads[0] = { ...before.threads[0], messages: [], historySummary: { messageCount: 1, attachmentCount: 0 } };
  const queue: PersistenceQueue = { persisted: before, pending: { ...before, threads: [{ ...before.threads[0], title: "Rename" }] }, inFlight: null };
  const firstWrite = Promise.withResolvers<void>();
  const drain = drainLatestPersistence(queue, () => firstWrite.promise);
  await Promise.resolve();
  adoptPersistedMessages(queue, "task-1", messages);
  const rejected = assert.rejects(drain, /disk full/);
  firstWrite.reject(new Error("disk full"));
  await rejected;
  assert.equal(queue.pending?.threads[0].messages, messages);
  await drainLatestPersistence(queue, async (delta) => { assert.deepEqual(delta.tasks[0].messages, []); });
  assert.equal(queue.persisted?.threads[0].title, "Rename");
});
