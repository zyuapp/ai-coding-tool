import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { SessionPanelProps } from "../../src/renderer/components/SessionPanel.tsx";

import { mount, query } from "../support/renderer-dom.mts";

const { WorkflowPanel } = await import("../../src/renderer/components/WorkflowPanel.tsx");

/** A workflow still going is drawn against the clock, so its fixture starts where a live one would. */
const workflowStart = Date.now() - 92_000;
type Workflow = SessionPanelProps["workflows"][number];
const workflowAgents: Workflow["agents"] = [
  { index: 0, label: "review:bugs", state: "done", phaseIndex: 0, phaseTitle: "Review", startedAt: workflowStart, durationMs: 60_000, tokens: 41_200, toolCalls: 12, resultPreview: "3 findings", model: "opus" },
  { index: 1, label: "verify:query.ts", state: "error", phaseIndex: 1, phaseTitle: "Verify", startedAt: workflowStart + 60_000, durationMs: 30_000, tokens: 20_500, error: "Agent returned no structured output" },
  { index: 2, label: "verify:store.ts", state: "running", phaseIndex: 1, phaseTitle: "Verify", queuedAt: workflowStart + 60_000, startedAt: workflowStart + 61_000, tokens: 18_600, lastToolName: "Grep", isolation: "worktree", attempt: 2, promptPreview: "Adversarially verify this finding" },
];

const liveWorkflow: Workflow = {
  id: "wf-1",
  name: "review-changes",
  description: "Review changed files across dimensions",
  status: "running",
  phases: [{ index: 0, title: "Review" }, { index: 1, title: "Verify" }],
  agents: workflowAgents,
  totalTokens: 80_300,
  totalToolCalls: 21,
  startedAt: workflowStart,
};

test("the workflow panel groups agents by phase, draws their lanes, and opens one", async () => {
  const stopped: string[] = [];
  const view = await mount(React.createElement(WorkflowPanel, { workflow: liveWorkflow, onStop: (id) => { stopped.push(id); } }));

  assert.match(view.container.textContent, /review-changes/);
  assert.match(view.container.textContent, /2\/3/, "done counts both the finished and the failed");
  assert.deepEqual([...view.container.querySelectorAll(".workflow-group-head h3")].map((head) => head.textContent), ["Review", "Verify"]);
  assert.equal(view.container.querySelectorAll(".workflow-lane").length, 3);
  assert.match(query(view.container, ".workflow-row .workflow-row-main small").textContent, /3 findings/);
  assert.match(view.container.textContent, /Using Grep/);
  assert.match(view.container.textContent, /retry 2/);
  assert.match(view.container.textContent, /worktree/);
  assert.match(view.container.textContent, /Agent returned no structured output/);

  await act(async () => { view.container.querySelector('button[aria-label="Stop review-changes"]'); });
  await act(async () => { query<HTMLButtonElement>(view.container, ".workflow-stop").click(); });
  assert.deepEqual(stopped, ["wf-1"]);

  await act(async () => { query<HTMLElement>(view.container, '.workflow-row[aria-label="Open verify:store.ts details"]').click(); });
  assert.match(view.container.textContent, /Adversarially verify this finding/);
  assert.match(view.container.textContent, /Previews are the first 400 characters/);
  await act(async () => { query<HTMLButtonElement>(view.container, ".session-back").click(); });
  assert.equal(view.container.querySelectorAll(".workflow-lane").length, 3, "the panel comes back to the whole workflow");
  await view.unmount();
});

test("a workflow that ended stops reporting its agents as live", async () => {
  const view = await mount(React.createElement(WorkflowPanel, {
    workflow: { ...liveWorkflow, status: "stopped", finishedAt: workflowStart + 92_000, summary: 'Dynamic workflow "review-changes" was stopped' },
    onStop() {},
  }));

  assert.equal(view.container.querySelector(".workflow-stop"), null, "a workflow that ended has nothing to stop");
  assert.match(view.container.textContent, /Stopped with the run/);
  assert.match(view.container.textContent, /was stopped/);
  assert.equal(view.container.querySelectorAll(".workflow-lane-track > i.run.running").length, 0);
  await view.unmount();
});
