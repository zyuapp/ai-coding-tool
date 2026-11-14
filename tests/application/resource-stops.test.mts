import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import { restoredThreads } from "../../src/application/thread-restore.ts";
import { parseThreadStore, serializeThreadStore } from "../../src/domain/thread-storage.ts";
import { readViewPreferences, viewPreferences, viewPreferenceState } from "../../src/application/view-preferences.ts";
import { loadViewPreferences } from "../../src/host/view-preferences-store.ts";
import { sideChatView } from "../../src/application/side-chat-view.ts";
import { whyTickCannotRun } from "../../src/application/findings.ts";
import { activeRun, task, workspace, PROJECT } from "./workspace-reducer-fixtures.mts";

const stop = { at: 100, bytes: 4 * 1024 ** 3, cleanup: "stopping" as const };
function stoppedState() {
  const initial = workspace({ projects: [PROJECT], threads: [task("a", { projectId: PROJECT.id, continuation: { provider: "claude", value: "history" }, continuationStatus: "available" }), task("b")], activeRuns: { a: activeRun("a", "run-a"), b: activeRun("b", "run-b") }, currentId: "b", subagents: { a: [{ id: "child", description: "background agent", status: "working", sessionScoped: true, startedAt: 0, activity: [] }] }, backgroundProcesses: { a: [{ id: "shell", kind: "shell", description: "work" }] } });
  return reduce(initial, { type: "thread.event", event: { type: "resource.stopped", taskId: "a", stop } }).state;
}

test("a resource stop ends session background work and preserves the other thread, history and continuation", () => {
  let state = stoppedState();
  assert.equal(state.subagents.a![0]!.status, "stopped");
  assert.deepEqual(state.backgroundProcesses.a ?? [], []);
  assert.equal(state.threads[0]!.resourceStop?.cleanup, "stopping");
  assert.equal(state.threads[0]!.outcomeUnread, true);
  assert.equal(state.threads[0]!.continuation?.value, "history");
  assert.ok(state.activeRuns.b);
  state = reduce(state, { type: "run.event", event: { type: "run.status", taskId: "a", runId: "run-a", sequence: 1, status: "cancelled" } }).state;
  assert.equal(state.activeRuns.a, undefined);
  assert.ok(state.activeRuns.b);
  assert.match(reduce(state, { type: "task.send", taskId: "a", text: "restart" }).state.actionError ?? "", /Resume this thread/);
  assert.equal(reduce(state, { type: "resource.resume", taskId: "a" }).effects.length, 0);
  const stale = reduce(state, { type: "run.event", event: { type: "run.started", taskId: "a", runId: "late", sequence: 1, agentInitiated: true } });
  assert.equal(stale.state.activeRuns.a, undefined);
});

test("resume waits for verified cleanup, rejects stale cleanup, and resumes the saved continuation through normal effects", () => {
  let state = stoppedState();
  state = reduce(state, { type: "run.event", event: { type: "run.status", taskId: "a", runId: "run-a", sequence: 1, status: "cancelled" } }).state;
  state = reduce(state, { type: "thread.event", event: { type: "resource.stopped", taskId: "a", stop: { ...stop, at: 99, cleanup: "complete" } } }).state;
  assert.equal(state.threads[0]!.resourceStop?.cleanup, "stopping");
  state = reduce(state, { type: "thread.event", event: { type: "resource.stopped", taskId: "a", stop: { ...stop, cleanup: "complete" } } }).state;
  const resumed = reduce(state, { type: "resource.resume", taskId: "a" });
  assert.equal(resumed.state.threads[0]!.resourceStop, undefined);
  const effect = resumed.effects.find(effect => effect.type === "resolve-run-workspace");
  assert.ok(effect && effect.type === "resolve-run-workspace");
  const started = reduce(resumed.state, { type: "run.resolved", pendingId: effect.pendingId, workspace: { id: PROJECT.workspaceId!, kind: "project", root: PROJECT.root } });
  const run = started.effects.find(effect => effect.type === "start-run");
  assert.ok(run && run.type === "start-run");
  assert.equal(run.command.continuation?.value, "history");
  assert.match(run.command.prompt, /Inspect the current state/);
});

test("memory interruptions survive storage and restart without automatic schedule reactivation", () => {
  const thread = task("a", { resourceStop: stop });
  const data = { version: 2 as const, tasks: [thread], projects: [], worktrees: [], lastFolder: null };
  const parsed = parseThreadStore(serializeThreadStore(data));
  assert.ok(parsed.ok);
  const restored = restoredThreads(parsed.data.tasks).threads[0]!;
  assert.equal(restored.resourceStop?.cleanup, "complete");
  assert.equal(restored.resourceStop?.bytes, stop.bytes);
  const state = workspace({ threads: [restored] });
  assert.equal(whyTickCannotRun(state, { taskId: "a", automationId: "auto", runId: "tick", prompt: "poll", runNumber: 1 }, restored), "busy-user");
});

test("the memory protection setting defaults on, persists off, and updates the running host immediately", () => {
  const initial = workspace();
  assert.equal(initial.memoryProtection, true);
  const changed = reduce(initial, { type: "view.set-memory-protection", enabled: false });
  assert.equal(changed.state.memoryProtection, false);
  assert.ok(changed.effects.some(effect => effect.type === "send-run-command" && effect.command.type === "memory-protection" && !effect.command.enabled));
  const preferences = viewPreferences(changed.state);
  assert.equal(preferences.memoryProtection, false);
  assert.equal(viewPreferenceState({ ...preferences, memoryProtection: undefined }).memoryProtection, true);
  const stored = readViewPreferences({ getItem: () => JSON.stringify(preferences), setItem() {} });
  assert.equal(stored.memoryProtection, false);
  const loaded = loadViewPreferences({ getItem: () => JSON.stringify(preferences), setItem() {} });
  const restored = reduce(workspace(), { type: "preferences.loaded", preferences: loaded });
  assert.equal(restored.state.memoryProtection, false);
  assert.ok(restored.effects.some(effect => effect.type === "send-run-command" && effect.command.type === "memory-protection" && !effect.command.enabled));
});

for (const operation of [undefined, { type: "compact" }, { type: "review", target: { type: "uncommittedChanges" } }, { type: "resume", after: "update" }] as const) {
  test(`a stopped thread refuses a resolved ${operation?.type ?? "send"} that began before the stop`, () => {
    const pending = { id: "pending", projectId: PROJECT.id, taskId: "a", runId: "pending-run", origin: "composer" as const, text: "work", prompt: "work", attachments: [], ...(operation ? { operation } : {}) };
    const state = workspace({ projects: [PROJECT], threads: [task("a", { resourceStop: { ...stop, cleanup: "complete" } })], pendingRuns: { pending } });
    const result = reduce(state, { type: "run.resolved", pendingId: "pending", workspace: { id: PROJECT.workspaceId!, kind: "project", root: PROJECT.root }, worktree: { id: "created-checkout", root: "/tmp/created-checkout", workspaceId: "created-workspace", baseCommit: "base", createdAt: 1, lastUsedAt: 1 } });
    assert.equal(result.effects.some(effect => effect.type === "start-run"), false);
    assert.equal(result.state.activeRuns.a, undefined);
    assert.equal(result.state.pendingRuns.pending, undefined);
    assert.ok(result.state.worktrees.some(worktree => worktree.id === "created-checkout"), "a checkout that already finished creating remains tracked for cleanup");
    assert.ok(result.state.threads[0]!.resourceStop);
  });
}

test("a side chat is an ordinary thread, so its memory stop is displayed by its shared conversation timeline", () => {
  const state = workspace({ threads: [task("main"), task("chat", { continuation: { provider: "claude", value: "chat-session" }, continuationStatus: "available" })], sideChats: [{ id: "chat", sourceThreadId: "main", error: null }] });
  const result = reduce(state, { type: "thread.event", event: { type: "resource.stopped", taskId: "chat", stop } });
  assert.deepEqual(result.state.threads.find(thread => thread.id === "chat")?.resourceStop, stop);
  assert.deepEqual(sideChatView(result.state, result.state.sideChats[0]!)[0]?.thread.resourceStop, stop);
  assert.equal(reduce(result.state, { type: "task.send", taskId: "chat", text: "again" }).result?.ok, false);
});
