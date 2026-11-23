import assert from "node:assert/strict";
import { test } from "vitest";
import { reduce, type WorkspaceTransition } from "../../src/application/workspace-reducer.ts";
import { emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { viewPreferences } from "../../src/application/view-preferences.ts";
import type { PlanUsage } from "../../src/domain/plan-usage.ts";
import { correlatedRunEvent, effectOf, task, workspace } from "./workspace-reducer-fixtures.mts";

const ENDED = 1_000_000;
const DUE = ENDED + 54 * 60_000;
const RESOLVED = { id: "projectless", kind: "projectless" as const, root: "/tmp" };

function plan(utilization: number): PlanUsage {
  return { status: "available", subscription: "max", windows: [{ id: "five_hour", label: "Session", utilization, resetsAt: null }] };
}

function idle(state: Partial<WorkspaceState> = {}, report: PlanUsage | undefined = plan(10)): WorkspaceState {
  const thread = task("task-a", {
    engine: "claude",
    model: "opus",
    continuation: { provider: "claude", value: "session-1" },
    continuationStatus: "available",
    contextUsage: { tokens: 250_000, limit: 1_000_000, model: "opus" },
    outcome: "finished",
    runEndedAt: ENDED,
  });
  return workspace({ threads: [thread], planUsage: { read: 1, reports: report ? { claude: report } : {}, reading: [], dismissed: [] }, ...state });
}

function fire(state: WorkspaceState, at: number) {
  return reduce(state, { type: "idle-compaction.due", at });
}

function starts(transition: WorkspaceTransition) {
  return transition.effects.some((effect) => effect.type === "resolve-run-workspace");
}

function scheduled(transition: WorkspaceTransition) {
  return effectOf(transition, "schedule-idle-compaction").at;
}

/** Fires the compaction due and resolves its checkout, so it is running. */
function compacting(state = idle()) {
  const due = fire(state, DUE);
  const resolved = reduce(due.state, { type: "run.resolved", pendingId: effectOf(due, "resolve-run-workspace").pendingId, workspace: RESOLVED });
  return { resolved, runId: effectOf(resolved, "start-run").command.runId };
}

test("a large idle Claude thread is compacted once before its cache expires, and keeps its run end", () => {
  assert.equal(scheduled(reduce(idle(), { type: "preferences.loaded", preferences: viewPreferences(emptyWorkspaceState()) })), DUE);
  const { resolved, runId } = compacting();
  assert.equal(resolved.state.activeRuns["task-a"]?.idle, true);

  const compacted = reduce(resolved.state, correlatedRunEvent("task-a", runId, 1, { type: "context.compacted", trigger: "manual", preTokens: 250_000, postTokens: 30_000 }));
  const ended = reduce(compacted.state, correlatedRunEvent("task-a", runId, 2, { type: "run.status", status: "succeeded" }));
  const thread = ended.state.threads[0]!;
  assert.equal(thread.messages.at(-1)?.text, "Compacted while idle: 250,000 → 30,000 tokens.");
  assert.equal(thread.runEndedAt, ENDED);
  assert.equal(thread.outcome, "finished");
  assert.equal(scheduled(ended), null);
});

test("a failed idle compaction is not tried again until the thread runs again", () => {
  const { resolved, runId } = compacting();
  const failed = reduce(resolved.state, correlatedRunEvent("task-a", runId, 1, { type: "run.status", status: "failed", message: "Overloaded" }));
  assert.equal(scheduled(failed), null);
  assert.equal(starts(fire(failed.state, DUE + 1)), false);
});

test("an idle thread is left alone when compacting would not help", () => {
  const cases: Record<string, [WorkspaceState, number]> = {
    "its cache may already be gone": [idle(), DUE + 2 * 60_000],
    "a message waits for it": [idle({ queuedMessages: { "task-a": [{ id: "m", text: "next", prompt: "next", attachments: [] }] } }), DUE],
    "its plan is nearly spent": [idle({}, plan(85)), DUE],
    "it bills no plan": [idle({}, { status: "not-applicable" }), DUE],
    "the setting is off": [idle({ idleCompaction: false }), DUE],
  };
  for (const [name, [state, at]] of Object.entries(cases)) {
    const fired = fire(state, at);
    assert.equal(starts(fired), false, name);
    assert.equal(starts(fire(fired.state, at + 1)), false, `${name}, on the next tick`);
  }
});

test("a plan that could not be read does not stop idle compaction", () => {
  assert.equal(starts(fire(idle({}, undefined), DUE)), true);
});

test("turning idle compaction off cancels the timer, and on sets it again", () => {
  const off = reduce(idle(), { type: "view.set-idle-compaction", enabled: false });
  assert.equal(scheduled(off), null);
  assert.equal(scheduled(reduce(off.state, { type: "view.set-idle-compaction", enabled: true })), DUE);
});

test("an idle compaction that runs too long is stopped", () => {
  const { resolved, runId } = compacting();
  const deadline = DUE + 10 * 60_000;
  assert.equal(scheduled(resolved), deadline);
  assert.equal(fire(resolved.state, deadline - 1).effects.some((effect) => effect.type === "send-run-command"), false);
  const stopped = fire(resolved.state, deadline);
  assert.deepEqual(effectOf(stopped, "send-run-command").command, { type: "cancel", taskId: "task-a", runId });
});
