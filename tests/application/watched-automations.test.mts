import { activeRun, task, workspace } from "./workspace-reducer-fixtures.mts";
import assert from "node:assert/strict";
import { test } from "vitest";

import { reduce } from "../../src/application/workspace-reducer.ts";
import { automationRunPrompt } from "../../src/application/thread-run-state.ts";
import { workspaceViewCollections } from "../../src/application/workspace-view-collections.ts";
import type { AutomationFinding } from "../../src/domain/finding.ts";
import type { AutomationView } from "../../src/domain/automation.ts";
import type { WorkspaceState } from "../../src/application/workspace-state.ts";

function automationView(overrides: Partial<AutomationView> = {}): AutomationView {
  return { id: "automation-1", taskId: "task-a", prompt: "Babysit the PR", schedule: "*/5 * * * *", paused: false, createdAt: 1, updatedAt: 1, runCount: 3, nextRunAt: null, ...overrides };
}

const FOUND: AutomationFinding = { id: "finding-1", headline: "CI failed", at: 2 };

function sections(state: WorkspaceState) {
  const { activityThreads } = workspaceViewCollections(state).lists;
  return { priority: activityThreads.priority.map((thread) => thread.id), running: activityThreads.running.map((thread) => thread.id), threads: activityThreads.threads.map((thread) => thread.id) };
}

test("a watch holds its thread in Running between ticks, whatever it has found", () => {
  const state = workspace({
    threads: [task("task-a", { findings: [FOUND], outcome: "finished" })],
    automations: [automationView({ endsWhen: "the PR is approved." })],
  });
  assert.deepEqual(sections(state), { priority: [], running: ["task-a"], threads: [] });
  assert.equal(workspaceViewCollections(state).everyBusy.has("task-a"), false, "between ticks the row draws no spinner");
});

test("a routine or a paused watch ranks by what the thread carries, as before", () => {
  const threads = [task("task-a", { findings: [FOUND] }), task("task-b")];
  for (const automations of [
    [automationView(), automationView({ id: "automation-2", taskId: "task-b" })],
    [automationView({ endsWhen: "the PR is approved.", paused: true }), automationView({ id: "automation-2", taskId: "task-b", endsWhen: "the PR is approved.", paused: true })],
  ]) {
    assert.deepEqual(sections(workspace({ threads, automations })), { priority: ["task-a"], running: [], threads: ["task-b"] });
  }
});

test("an approval still pulls a watched thread to Priority", () => {
  const state = workspace({
    threads: [task("task-a")],
    automations: [automationView({ endsWhen: "the PR is approved." })],
    activeRuns: { "task-a": activeRun("task-a", "run-1", { status: "awaiting-approval" }) },
  });
  assert.deepEqual(sections(state).priority, ["task-a"]);
});

test("a watch that is removed lands its thread in Priority, unread when it ended out of sight", () => {
  const watched = workspace({ threads: [task("task-a"), task("task-b")], automations: [automationView({ endsWhen: "the PR is approved." })] });
  const ended = reduce(watched, { type: "automations.changed", automations: [] }).state;
  assert.equal(ended.threads[0]!.outcome, "finished");
  assert.equal(ended.threads[0]!.outcomeUnread, true);
  assert.deepEqual(sections(ended).priority, ["task-a"]);

  const onScreen = reduce({ ...watched, currentId: "task-a" }, { type: "automations.changed", automations: [] }).state;
  assert.equal(onScreen.threads[0]!.outcome, "finished");
  assert.equal(onScreen.threads[0]!.outcomeUnread, undefined);
});

test("only a live watch leaving announces anything", () => {
  for (const before of [automationView(), automationView({ endsWhen: "the PR is approved.", paused: true })]) {
    const state = reduce(workspace({ threads: [task("task-a")], automations: [before] }), { type: "automations.changed", automations: [] }).state;
    assert.equal(state.threads[0]!.outcome, undefined);
  }
  const paused = reduce(workspace({ threads: [task("task-a")], automations: [automationView({ endsWhen: "the PR is approved." })] }), {
    type: "automations.changed", automations: [automationView({ endsWhen: "the PR is approved.", paused: true })],
  }).state;
  assert.equal(paused.threads[0]!.outcome, undefined, "pausing a watch is not finishing it");
});

test("a watch's tick is told what ends it", () => {
  const prompt = automationRunPrompt("Babysit the PR", 4, undefined, "the PR is approved.");
  assert.match(prompt, /This automation ends when: the PR is approved\. Once that holds, call the aicodingtool-automation stop tool/);
  assert.match(automationRunPrompt("Poll", 4), /stop condition is now met/);
});
