import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";
import type { Thread } from "../../src/domain/thread.ts";
import { activeRun, correlatedRunEvent, effectOf, task, workspace } from "./workspace-reducer-fixtures.mts";

const ENDED = 1_000_000;
const DUE = ENDED + 54 * 60_000;
const PLAN = { status: "available" as const, subscription: "max", windows: [{ id: "five_hour", label: "Session", utilization: 20, resetsAt: null }] };

function idleThread(overrides: Partial<Thread> = {}): Thread {
  return task("task-a", {
    engine: "claude",
    model: "opus",
    continuation: { provider: "claude", value: "session-1" },
    continuationStatus: "available",
    contextUsage: { tokens: 400_000, limit: 1_000_000, model: "opus" },
    outcome: "finished",
    runEndedAt: ENDED,
    ...overrides,
  });
}

function idle(overrides: Partial<Thread> = {}, state: Partial<WorkspaceState> = {}) {
  return workspace({ threads: [idleThread(overrides)], planUsage: { read: 1, reports: { claude: PLAN, codex: PLAN }, reading: [], dismissed: [] }, ...state });
}

function compactions(state: WorkspaceState, at: number) {
  return reduce(state, { type: "idle-compaction.due", at }).effects.filter((effect) => effect.type === "resolve-run-workspace");
}

test("a large idle Claude thread compacts shortly before its prompt cache expires", () => {
  const state = idle();
  const due = reduce(state, { type: "idle-compaction.due", at: DUE });
  const resolved = reduce(due.state, {
    type: "run.resolved",
    pendingId: effectOf(due, "resolve-run-workspace").pendingId,
    workspace: { id: "projectless", kind: "projectless", root: "/tmp" },
  });
  const command = effectOf(resolved, "start-run").command;
  assert.deepEqual(command.operation, { type: "compact", preTokens: 400_000 });
  assert.equal(command.prompt, "");
  assert.equal(resolved.state.activeRuns["task-a"]?.idle, true);

  const compacted = reduce(resolved.state, correlatedRunEvent("task-a", command.runId, 1, { type: "context.compacted", trigger: "manual", preTokens: 400_000, postTokens: 30_000 }));
  const finished = reduce(compacted.state, correlatedRunEvent("task-a", command.runId, 2, { type: "run.status", status: "succeeded" }));
  const thread = finished.state.threads[0]!;
  assert.equal(thread.messages.at(-1)?.text, "Compacted while idle: 400,000 → 30,000 tokens.");
  assert.equal(thread.contextUsage?.tokens, 30_000);
  assert.equal(thread.runEndedAt, ENDED, "compacting is not a turn");
  assert.equal(thread.outcome, "finished");
  assert.deepEqual(compactions(finished.state, DUE + 1_000), [], "the same idle stretch compacts once");
});

test("a manual compaction keeps its own wording", () => {
  const state = idle({}, { currentId: "task-a" });
  const pending = reduce(state, { type: "run.compact" });
  const resolved = reduce(pending.state, { type: "run.resolved", pendingId: effectOf(pending, "resolve-run-workspace").pendingId, workspace: { id: "projectless", kind: "projectless", root: "/tmp" } });
  const command = effectOf(resolved, "start-run").command;
  assert.equal(resolved.state.activeRuns["task-a"]?.idle, undefined);
  const compacted = reduce(resolved.state, correlatedRunEvent("task-a", command.runId, 1, { type: "context.compacted", trigger: "manual", preTokens: 400_000, postTokens: 30_000 }));
  assert.equal(compacted.state.threads[0]!.messages.at(-1)?.text, "Context manual-compacted: 400,000 → 30,000 tokens.");
});

test("idle compaction leaves Codex threads alone", () => {
  const codex = idle({ engine: "codex", model: "gpt-6.1-sol", continuation: { provider: "codex", value: "thread-1" }, contextUsage: { tokens: 260_000, limit: 272_000, model: "gpt-6.1-sol" } });
  assert.deepEqual(compactions(codex, DUE), []);
  assert.equal(effectOf(reduce(codex, { type: "view.set-idle-compaction", enabled: false }), "persist-preferences").type, "persist-preferences");
  const scheduled = reduce({ ...codex, idleCompaction: false }, { type: "view.set-idle-compaction", enabled: true }).effects.filter((effect) => effect.type === "schedule-idle-compaction");
  assert.deepEqual(scheduled, [], "no timer is kept for a Codex thread");
});

test("idle compaction waits for the cache window and skips threads it would not help", () => {
  assert.deepEqual(compactions(idle(), DUE - 1), [], "not yet due");
  assert.deepEqual(compactions(idle(), DUE + 2 * 60_000), [], "too late: the cache may be gone");
  assert.deepEqual(compactions(idle({ contextUsage: { tokens: 150_000, limit: 1_000_000, model: "opus" } }), DUE), [], "too small");
  assert.deepEqual(compactions(idle({ archivedAt: 5 }), DUE), [], "archived");
  assert.deepEqual(compactions(idle({}, { idleCompaction: false }), DUE), [], "turned off");
  assert.deepEqual(compactions(idle({}, { activeRuns: { "task-a": activeRun("task-a", "run-1") } }), DUE), [], "busy");
  const near = { ...PLAN, windows: [{ ...PLAN.windows[0]!, utilization: 90 }] };
  assert.deepEqual(compactions(idle({}, { planUsage: { read: 1, reports: { claude: near }, reading: [], dismissed: [] } }), DUE), [], "near the plan limit");
  assert.deepEqual(compactions(idle({}, { planUsage: { read: 1, reports: { claude: { status: "not-applicable" } }, reading: [], dismissed: [] } }), DUE), [], "no plan");
});

test("the timer follows the next thread due and stops when turned off", () => {
  const state = idle({}, { idleCompaction: false });
  const on = reduce(state, { type: "view.set-idle-compaction", enabled: true });
  assert.deepEqual(effectOf(on, "schedule-idle-compaction"), { type: "schedule-idle-compaction", at: DUE });
  const off = reduce(on.state, { type: "view.set-idle-compaction", enabled: false });
  assert.deepEqual(effectOf(off, "schedule-idle-compaction"), { type: "schedule-idle-compaction", at: null });
  const lapsed = reduce(on.state, { type: "idle-compaction.due", at: DUE + 2 * 60_000 });
  assert.deepEqual(effectOf(lapsed, "schedule-idle-compaction"), { type: "schedule-idle-compaction", at: null }, "a lapsed thread is let go");
});
