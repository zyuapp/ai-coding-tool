import assert from "node:assert/strict";
import { test } from "vitest";
import { createRuntimeHistory } from "../../src/renderer/task-workspace/runtime-history.ts";
import { drainLatestPersistence, persistenceDelta, persistenceState, type PersistenceQueue } from "../../src/renderer/task-workspace/workspace-persistence.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { ConversationMessage } from "../../src/domain/conversation.ts";
import { heldWorktree, task, workspace } from "../application/workspace-reducer-fixtures.mts";

const messages: ConversationMessage[] = [{ id: "message", kind: "user", text: "original conversation", at: 1 }];

function cold(id: string) {
  return task(id, { historySummary: { messageCount: 1, attachmentCount: 0 } });
}

test("concurrent history readers share one load and preserve metadata edited during it", async () => {
  let state = workspace({ threads: [cold("thread")] });
  const pending = Promise.withResolvers<ConversationMessage[]>();
  let reads = 0;
  const persistence: PersistenceQueue = { persisted: persistenceState(state), pending: null, inFlight: null };
  const history = createRuntimeHistory({
    state: () => state,
    load: () => { reads++; return pending.promise; },
    dispatch: async (input) => { state = reduce(state, input).state; },
    persistence,
  });
  const first = history.hydrate("thread");
  const second = history.hydrate("thread");
  state = reduce(state, { type: "task.rename", taskId: "thread", title: "New title" }).state;
  pending.resolve(messages);
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(state.threads[0].title, "New title");
  assert.equal(state.threads[0].historySummary, undefined);
  assert.equal(state.threads[0].messages, messages);
  const delta = persistenceDelta(persistence.persisted, persistenceState(state));
  assert.equal(delta.tasks[0].task.title, "New title");
  assert.deepEqual(delta.tasks[0].messages, []);
});

test("a failed history read leaves its marker intact and can be retried", async () => {
  let state = workspace({ threads: [cold("thread")] });
  let reads = 0;
  const history = createRuntimeHistory({
    state: () => state,
    load: async () => { if (++reads === 1) throw new Error("read failed"); return messages; },
    dispatch: async (input) => { state = reduce(state, input).state; },
    persistence: { persisted: persistenceState(state), pending: null, inFlight: null },
  });
  await assert.rejects(history.hydrate("thread"), /read failed/);
  assert.ok(state.threads[0].historySummary);
  await history.hydrate("thread");
  assert.equal(state.threads[0].messages, messages);
  assert.equal(reads, 2);
});

test("a late history response cannot recreate a removed thread", async () => {
  let state = workspace({ threads: [cold("thread")] });
  const pending = Promise.withResolvers<ConversationMessage[]>();
  const history = createRuntimeHistory({
    state: () => state,
    load: () => pending.promise,
    dispatch: async (input) => { state = reduce(state, input).state; },
    persistence: { persisted: persistenceState(state), pending: null, inFlight: null },
  });
  const loading = history.hydrate("thread");
  state = reduce(state, { type: "task.archive", taskId: "thread" }).state;
  state = reduce(state, { type: "task.clear-archive" }).state;
  pending.resolve(messages);
  await loading;
  assert.deepEqual(state.threads, []);
});

test("hydration survives an older metadata snapshot finishing its persistence write", async () => {
  const before = workspace({ threads: [cold("thread")] });
  let state = reduce(before, { type: "task.rename", taskId: "thread", title: "Renamed" }).state;
  const persistence: PersistenceQueue = { persisted: persistenceState(before), pending: persistenceState(state), inFlight: null };
  const write = Promise.withResolvers<void>();
  const draining = drainLatestPersistence(persistence, () => write.promise);
  await Promise.resolve();
  const history = createRuntimeHistory({
    state: () => state,
    load: async () => messages,
    dispatch: async (input) => { state = reduce(state, input).state; },
    persistence,
  });
  const hydrating = history.hydrate("thread");
  await Promise.resolve();
  write.resolve();
  await Promise.all([draining, hydrating]);
  state = reduce(state, { type: "task.rename", taskId: "thread", title: "Renamed again" }).state;
  assert.deepEqual(persistenceDelta(persistence.persisted, persistenceState(state)).tasks[0].messages, []);
});

test("a shared checkout removal prepares every claimant transcript", () => {
  const worktree = heldWorktree();
  const state = workspace({
    threads: [task("visible"), { ...cold("first"), worktreeId: worktree.id }, { ...cold("second"), worktreeId: worktree.id }],
    currentId: "visible", worktrees: [worktree],
  });
  const history = createRuntimeHistory({
    state: () => state,
    load: async () => [],
    dispatch: async () => {},
    persistence: { persisted: persistenceState(state), pending: null, inFlight: null },
  });
  assert.deepEqual(new Set(history.needed({ type: "worktree.delete", root: worktree.root })), new Set(["first", "second"]));
  assert.deepEqual(new Set(history.needed({ type: "worktree.deleted", worktreeId: worktree.id, root: worktree.root, snapshot: { commit: null, shortCommit: null, ref: null } })), new Set(["first", "second"]));
});

test("a broken current history does not block unrelated settings, browser, focus, or cancellation", () => {
  const state = workspace({ threads: [cold("broken"), cold("other")], currentId: "broken" });
  const history = createRuntimeHistory({ state: () => state, load: async () => { throw new Error("broken history"); }, dispatch: async () => {}, persistence: { persisted: null, pending: null, inFlight: null } });
  assert.deepEqual(history.needed({ type: "view.set-settings-open", open: true }), []);
  assert.deepEqual(history.needed({ type: "view.set-focused", focused: true }), []);
  assert.deepEqual(history.needed({ type: "browser.open", taskId: "other", url: "https://example.com" }), []);
  assert.deepEqual(history.needed({ type: "task.rename", taskId: "other", title: "Renamed" }), []);
  assert.deepEqual(history.needed({ type: "run.cancel" }), []);
  assert.deepEqual(history.needed({ type: "task.send", text: "new thread" }), []);
  assert.deepEqual(history.needed({ type: "task.send", taskId: "other", text: "existing thread" }), ["other"]);
  assert.deepEqual(history.needed({ type: "task.select", taskId: "other" }), ["other"]);
});

test("keyboard navigation and an explicit find target hydrate the thread they reach", () => {
  const state = workspace({ threads: [cold("first"), cold("second")], currentId: "first", history: ["second", "first"], historyIndex: 1 });
  const history = createRuntimeHistory({ state: () => state, load: async () => [], dispatch: async () => {}, persistence: { persisted: null, pending: null, inFlight: null } });
  assert.deepEqual(history.needed({ type: "view.go-back" }), ["second"]);
  assert.deepEqual(history.needed({ type: "view.shortcut", action: "nav.back", surface: "any" }), ["second"]);
  assert.deepEqual(history.needed({ type: "view.find-open", target: { kind: "thread", taskId: "second" } }), ["second"]);
  assert.deepEqual(history.needed({ type: "view.shortcut", action: "thread.new-worktree", surface: "any" }), []);
});

test("transcript references resolve titles and ID prefixes before loading", async () => {
  let state = workspace({ threads: [{ ...cold("long-thread-id"), title: "Original title" }] });
  const reads: string[] = [];
  const history = createRuntimeHistory({ state: () => state, load: async (id) => { reads.push(id); return messages; }, dispatch: async (input) => { state = reduce(state, input).state; }, persistence: { persisted: null, pending: null, inFlight: null } });
  await history.prepareThreadRequest({ type: "thread.request", requestId: "read", taskId: "caller", op: "read", threadId: "Original title" });
  assert.deepEqual(reads, ["long-thread-id"]);
  state = workspace({ threads: [cold("another-long-id")] });
  await history.prepareThreadRequest({ type: "thread.request", requestId: "wait", taskId: "caller", op: "wait", threadId: "another-long", timeoutMs: 100 });
  assert.deepEqual(reads, ["long-thread-id", "another-long-id"]);
});

test("scoped search loads matching project histories without touching unrelated or archived threads", async () => {
  let state = workspace({
    threads: [
      { ...cold("caller"), projectId: "project" },
      { ...cold("other-project"), projectId: "other" },
      { ...cold("archive"), projectId: "project", archivedAt: 1 },
      { ...cold("title-match"), projectId: "project", title: "Needle in title" },
    ],
    projects: [{ id: "project", root: "/repo" }, { id: "other", root: "/other" }],
  });
  const reads: string[] = [];
  const history = createRuntimeHistory({ state: () => state, load: async (id) => { reads.push(id); if (id !== "caller") throw new Error("unrelated corrupt history"); return messages; }, dispatch: async (input) => { state = reduce(state, input).state; }, persistence: { persisted: null, pending: null, inFlight: null } });
  await history.prepareThreadRequest({ type: "thread.request", requestId: "search", taskId: "caller", op: "list", search: "needle" });
  assert.deepEqual(reads, ["caller"]);
});

test("invalidated history reads cannot modify a later runtime lifetime or erase its active read", async () => {
  let state = workspace({ threads: [cold("thread")] });
  const oldRead = Promise.withResolvers<ConversationMessage[]>();
  const newRead = Promise.withResolvers<ConversationMessage[]>();
  let loads = 0;
  const persistence: PersistenceQueue = { persisted: persistenceState(state), pending: null, inFlight: null };
  const history = createRuntimeHistory({ state: () => state, load: () => (++loads === 1 ? oldRead.promise : newRead.promise), dispatch: async (input) => { state = reduce(state, input).state; }, persistence });
  const oldLoading = history.hydrate("thread");
  history.invalidate();
  const newLoading = history.hydrate("thread");
  oldRead.resolve([{ id: "stale", kind: "assistant", text: "stale", at: 1 }]);
  await oldLoading;
  assert.ok(state.threads[0].historySummary);
  assert.ok(persistence.persisted?.threads[0].historySummary);
  assert.equal(history.hydrate("thread"), newLoading);
  newRead.resolve(messages);
  await newLoading;
  assert.equal(loads, 2);
  assert.equal(state.threads[0].messages, messages);
});
