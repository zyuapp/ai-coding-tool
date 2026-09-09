import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { reduce, type WorkspaceInput } from "../../src/application/workspace-reducer.ts";
import { deriveView } from "../../src/application/workspace-state.ts";
import { parseThreadStore, serializeThreadStore } from "../../src/domain/thread-storage.ts";
import { SNOOZE_OPTIONS } from "../../src/domain/thread-snooze.ts";
import { isWorkspaceViewInput } from "../../src/contracts/workspace-view-input.ts";
import { activeRun, effectOf, task, workspace } from "./workspace-reducer-fixtures.mts";

const at = 1_800_000_000_000;

test("each snooze duration moves Priority into Threads without dismissing its attention or changing selection", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    for (const { hours } of SNOOZE_OPTIONS) {
      const thread = task("waiting", { outcome: "finished", outcomeUnread: true, findings: [{ id: "finding", headline: "Needs review", at }] });
      const state = workspace({ threads: [thread], currentId: thread.id, sidebarMode: "activity" });
      const input = { type: "task.snooze", taskId: thread.id, hours } as const;
      assert.equal(isWorkspaceViewInput(input), true);
      const snoozed = reduce(state, input);
      const deadline = at + hours * 3_600_000;
      assert.equal(snoozed.state.threads[0].snoozedUntil, deadline);
      assert.equal(snoozed.state.threads[0].findings, thread.findings);
      assert.equal(snoozed.state.threads[0].outcome, "finished");
      assert.equal(snoozed.state.threads[0].outcomeUnread, true);
      assert.equal(snoozed.state.currentId, thread.id);
      assert.equal(snoozed.state.threads[0].updatedAt, thread.updatedAt);
      assert.deepEqual(deriveView(snoozed.state).activityThreads.priority, []);
      assert.equal(deriveView(snoozed.state).activityThreads.threads[0].id, thread.id);
      assert.deepEqual(effectOf(snoozed, "schedule-snooze-expiry"), { type: "schedule-snooze-expiry", at: deadline });
      const filed = reduce(snoozed.state, { type: "task.dismiss-all" });
      assert.equal(filed.state.threads[0].findings, thread.findings);
      const early = reduce(snoozed.state, { type: "snoozes.elapsed", at: deadline - 1 });
      assert.equal(early.state.threads[0].snoozedUntil, deadline);
      const expired = reduce(early.state, { type: "snoozes.elapsed", at: deadline });
      assert.equal(expired.state.threads[0].snoozedUntil, undefined);
      assert.equal(deriveView(expired.state).activityThreads.priority[0].id, thread.id);
      assert.equal(effectOf(expired, "schedule-snooze-expiry").at, null);
    }
  } finally { clock.mockRestore(); }
});

test("approval rows can snooze, while running, settled, archived, and side-chat threads cannot", () => {
  const state = workspace({
    threads: [task("blocked"), task("busy", { outcome: "finished" }), task("quiet"), task("archived", { outcome: "finished", archivedAt: 1 }), task("chat", { outcome: "finished" })],
    activeRuns: { blocked: activeRun("blocked", "r1", { status: "awaiting-approval" }), busy: activeRun("busy", "r2") },
    sideChats: [{ id: "chat", sourceThreadId: "blocked", error: null }],
  });
  const snoozed = reduce(state, { type: "task.snooze", taskId: "blocked", hours: 1 });
  assert.equal(deriveView(snoozed.state).activityThreads.threads.some((thread) => thread.id === "blocked"), true);
  assert.equal(snoozed.state.activeRuns, state.activeRuns);
  for (const taskId of ["busy", "quiet", "archived", "chat", "missing"]) {
    assert.equal(reduce(state, { type: "task.snooze", taskId, hours: 1 }).state.threads, state.threads);
  }
  for (const hours of [undefined, 0, -1, 2, 1.5, Infinity, NaN, "1"]) {
    assert.equal(isWorkspaceViewInput({ type: "task.snooze", taskId: "blocked", hours }), false);
  }
  assert.equal(isWorkspaceViewInput({ type: "snoozes.elapsed", at }), false);
});

test("reading, drafting, renaming and background findings leave snooze in place", () => {
  let state = workspace({ threads: [task("waiting", { outcome: "finished", snoozedUntil: at + 3_600_000 })] });
  const inputs: WorkspaceInput[] = [
    { type: "task.select", taskId: "waiting" },
    { type: "view.set-prompt", prompt: "Unsent draft" },
    { type: "task.rename", taskId: "waiting", title: "New title" },
    { type: "automation.notify", taskId: "waiting", headline: "A new finding" },
  ];
  for (const input of inputs) {
    state = reduce(state, input).state;
    assert.equal(state.threads[0].snoozedUntil, at + 3_600_000, input.type);
    assert.deepEqual(deriveView(state).activityThreads.priority, []);
  }
});

test("accepted messages clear snooze for either provider, including external sends, queues and steering", () => {
  for (const engine of ["claude", "codex"] as const) {
    for (const active of [false, true]) {
      for (const steer of [false, true]) {
        const state = workspace({
          threads: [task("waiting", { engine, outcome: "finished", snoozedUntil: at })], currentId: "waiting",
          ...(active ? { activeRuns: { waiting: activeRun("waiting", "run") } } : {}),
        });
        const sent = reduce(state, { type: "task.send", taskId: "waiting", text: "Continue", steer });
        assert.equal(sent.state.threads[0].snoozedUntil, undefined);
        assert.equal(effectOf(sent, "schedule-snooze-expiry").at, null);
        assert.ok(active ? sent.state.queuedMessages.waiting.length : Object.keys(sent.state.pendingRuns).length);
        const drafted = reduce(state, { type: "view.set-prompt", prompt: "Composer message" }).state;
        assert.equal(reduce(drafted, { type: "task.send" }).state.threads[0].snoozedUntil, undefined);
      }
    }
  }
});

test("empty or rejected sends preserve snooze", () => {
  const state = workspace({ threads: [task("waiting", { snoozedUntil: at })], currentId: "waiting" });
  assert.equal(reduce(state, { type: "task.send", text: "  ", taskId: "waiting" }).state.threads[0].snoozedUntil, at);
  const refused = reduce({ ...state, creatingWorktrees: ["waiting"] }, { type: "task.send", text: "Continue", taskId: "waiting" });
  assert.equal(refused.result?.ok, false);
  assert.equal(refused.state.threads[0].snoozedUntil, at);
});

test("actively steering an earlier queued message clears a snooze applied after it was queued", () => {
  const state = workspace({
    threads: [task("waiting", { snoozedUntil: at })],
    activeRuns: { waiting: activeRun("waiting", "run", { status: "awaiting-approval" }) },
    queuedMessages: { waiting: [{ id: "queued", text: "Continue", prompt: "Continue", attachments: [] }] },
  });
  const sent = reduce(state, { type: "task.steer-queued", taskId: "waiting", messageId: "queued" });
  assert.equal(sent.state.threads[0].snoozedUntil, undefined);
  assert.equal(sent.state.queuedMessages.waiting[0].steering, true);
});

test("background runs preserve snooze and expiry uses the thread's current activity", () => {
  const state = workspace({
    threads: [task("waiting", { snoozedUntil: at, outcome: "finished" })],
    activeRuns: { waiting: activeRun("waiting", "run", { origin: "automation" }) },
  });
  const expired = reduce(state, { type: "snoozes.elapsed", at });
  assert.deepEqual(deriveView(expired.state).activityThreads.running.map((thread) => thread.id), ["waiting"]);
  const settled = reduce(state, { type: "run.event", event: { type: "run.status", taskId: "waiting", runId: "run", sequence: 1, status: "succeeded" } });
  assert.equal(settled.state.threads[0].snoozedUntil, at);
  assert.deepEqual(deriveView(settled.state).activityThreads.priority, []);
  const archived = reduce(state, { type: "task.archive", taskId: "waiting" });
  assert.equal(archived.state.threads[0].snoozedUntil, at);
  assert.equal(effectOf(archived, "schedule-snooze-expiry").at, null);
});

test("storage retains deadlines and reload expires elapsed snoozes while scheduling the next one", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
    const parsed = parseThreadStore(serializeThreadStore({ version: 2, projects: [], worktrees: [], lastFolder: null, tasks: [
      task("expired", { outcome: "finished", snoozedUntil: at - 1 }),
      task("later", { outcome: "failed", snoozedUntil: at + 1000 }),
    ] }));
    assert.ok(parsed.ok);
    assert.equal(parsed.data.tasks[1].snoozedUntil, at + 1000);
    const restored = reduce(workspace(), { type: "store.loaded", data: parsed.data });
    assert.equal(restored.state.threads.find((thread) => thread.id === "expired")?.snoozedUntil, undefined);
    assert.deepEqual(deriveView(restored.state).activityThreads.priority.map((thread) => thread.id), ["expired"]);
    assert.equal(effectOf(restored, "schedule-snooze-expiry").at, at + 1000);
    clock.mockReturnValue(at + 1000);
    const awake = reduce(restored.state, { type: "view.set-focused", focused: true });
    assert.equal(deriveView(awake.state).activityThreads.priority.length, 2);
    assert.equal(effectOf(awake, "schedule-snooze-expiry").at, null);
  } finally { clock.mockRestore(); }
});
