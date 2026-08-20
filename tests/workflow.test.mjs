import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkflowProgress, workflowProgressOf } from "../dist/main/main/agent/workflow-progress.mjs";
import {
  agentStateIn,
  formatElapsed,
  workflowAgentNote,
  workflowBar,
  workflowGroups,
  workflowSpan,
  workflowTicks,
} from "../dist/main/domain/workflow.js";

const START = 1_700_000_000_000;

function workflow(agents, phases = []) {
  return {
    id: "wf-1",
    name: "review-changes",
    description: "Dynamic workflow",
    status: "running",
    phases,
    agents,
    totalTokens: 0,
    totalToolCalls: 0,
    startedAt: START,
  };
}

test("a progress payload becomes phases and one record per agent", () => {
  const progress = parseWorkflowProgress([
    { type: "workflow_phase", index: 0, title: "Review", kind: "fan-out" },
    { type: "workflow_log", message: "local branch is not pushed" },
    { type: "workflow_agent", index: 0, label: "review:bugs", phaseIndex: 0, phaseTitle: "Review", state: "start", queuedAt: START },
    { type: "workflow_agent", index: 0, label: "review:bugs", phaseIndex: 0, state: "done", queuedAt: START, startedAt: START + 1_000, durationMs: 70_000, tokens: 41_200, toolCalls: 12, resultPreview: "3 findings" },
    { type: "workflow_agent", index: 1, label: "review:perf", state: "progress", startedAt: START + 2_000, lastToolName: "Grep", model: "sonnet", isolation: "worktree", attempt: 2, cached: false },
  ]);

  assert.deepEqual(progress.phases, [{ index: 0, title: "Review" }]);
  assert.equal(progress.agents.length, 2, "the last entry for an agent replaces the earlier ones");
  assert.deepEqual(progress.agents[0], {
    index: 0,
    label: "review:bugs",
    state: "done",
    phaseIndex: 0,
    resultPreview: "3 findings",
    queuedAt: START,
    startedAt: START + 1_000,
    durationMs: 70_000,
    tokens: 41_200,
    toolCalls: 12,
  });
  assert.equal(progress.agents[1].state, "running");
  assert.equal(progress.agents[1].isolation, "worktree");
  assert.equal(progress.agents[1].attempt, 2);
  assert.equal("cached" in progress.agents[1], false, "only a cached agent carries the mark");
});

test("an agent that reports a start without a time is still queued", () => {
  const progress = parseWorkflowProgress([{ type: "workflow_agent", index: 3, label: "verify:auth.ts", state: "start", queuedAt: START }]);
  assert.equal(progress.agents[0].state, "queued");
});

test("a payload that is not the shape the panel expects costs a field, not the run", () => {
  assert.equal(parseWorkflowProgress(undefined), null);
  assert.equal(parseWorkflowProgress("progress"), null);
  assert.deepEqual(parseWorkflowProgress([]), { phases: [], agents: [] });
  assert.deepEqual(parseWorkflowProgress([null, 7, { type: "workflow_agent" }, { type: "workflow_phase", index: 0 }]), { phases: [], agents: [] });
  assert.deepEqual(parseWorkflowProgress([{ type: "workflow_agent", index: 0, label: 12, startedAt: "soon" }]), {
    phases: [],
    agents: [{ index: 0, label: "Agent 1", state: "queued" }],
  });
  assert.equal(workflowProgressOf({ subtype: "task_progress" }), undefined);
  assert.deepEqual(workflowProgressOf({ workflow_progress: [] }), []);
});

test("agents group by phase in phase order, with unphased work left to the end", () => {
  const groups = workflowGroups(workflow(
    [
      { index: 3, label: "loose", state: "running" },
      { index: 2, label: "verify:a", state: "running", phaseIndex: 1 },
      { index: 0, label: "review:b", state: "done", phaseIndex: 0 },
      { index: 1, label: "review:a", state: "done", phaseIndex: 0 },
    ],
    [{ index: 1, title: "Verify" }, { index: 0, title: "Review" }],
  ));

  assert.deepEqual(groups.map((group) => group.title), ["Review", "Verify", "Agents"]);
  assert.deepEqual(groups[0].agents.map((agent) => agent.label), ["review:b", "review:a"], "spawn order within a phase");
});

test("lanes share one origin, so queue time reads against every other agent's", () => {
  const now = START + 100_000;
  const model = workflow([
    { index: 0, label: "first", state: "done", startedAt: START, durationMs: 50_000 },
    { index: 1, label: "second", state: "running", queuedAt: START + 50_000, startedAt: START + 75_000 },
  ]);
  const span = workflowSpan(model, now);
  assert.deepEqual(span, { start: START, end: now });

  const [first, second] = model.agents.map((agent) => workflowBar(agent, span, now));
  assert.deepEqual(first, { run: { left: 0, width: 50 } });
  assert.deepEqual(second, { queue: { left: 50, width: 25 }, run: { left: 75, width: 25 } });
  assert.deepEqual(workflowTicks(span).map((tick) => tick.label), ["0:00", "0:30", "1:00", "1:30"]);
});

test("a workflow that ended took its unfinished agents with it", () => {
  const stopped = { ...workflow([{ index: 0, label: "verify:a", state: "running" }]), status: "stopped", finishedAt: START + 10 };
  assert.equal(agentStateIn(stopped, stopped.agents[0]), "stopped");
  assert.equal(workflowAgentNote(stopped.agents[0], "stopped"), "Stopped with the run");
  assert.equal(agentStateIn(workflow(stopped.agents), stopped.agents[0]), "running");
});

test("an agent's line says what it is doing, then what it came back with", () => {
  assert.equal(workflowAgentNote({ index: 0, label: "a", state: "running", lastToolName: "Grep" }), "Using Grep");
  assert.equal(workflowAgentNote({ index: 0, label: "a", state: "running" }), "Working");
  assert.equal(workflowAgentNote({ index: 0, label: "a", state: "queued" }), "Queued");
  assert.equal(workflowAgentNote({ index: 0, label: "a", state: "done", cached: true }), "Replayed from an earlier run");
  assert.equal(workflowAgentNote({ index: 0, label: "a", state: "done", resultPreview: "\nconfirmed\nmore" }), "confirmed");
  assert.equal(workflowAgentNote({ index: 0, label: "a", state: "error", error: "no structured output" }), "no structured output");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
});
