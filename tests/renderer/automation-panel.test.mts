import { mountWorkspace } from "../support/workspace-renderer.mts";
import { automationView, fakeDesktop } from "../support/desktop-api.mts";
import assert from "node:assert/strict";
import { test } from "vitest";
import React, { act } from "react";
import type { RunCommand } from "../../src/contracts/ipc.ts";

import type { AutomationPatch } from "../../src/domain/automation.ts";
import type { Thread } from "../../src/domain/thread.ts";

import { dom, item, mount, query } from "../support/renderer-dom.mts";
import { settleFrame } from "../support/settle.mts";

const { useTaskWorkspace } = await import("../../src/renderer/task-workspace/useTaskWorkspace.ts");
const { AutomationPanel, automationStatusLabel, formatCountdown } = await import("../../src/renderer/components/AutomationPanel.tsx");

function startCommand(command: RunCommand | undefined): Extract<RunCommand, { type: "start" }> {
  assert.equal(command?.type, "start");
  return command;
}

test("the automation panel explains itself before an automation exists", async () => {
  const view = await mount(React.createElement(AutomationPanel, {
    automation: null, engineLabel: "Claude", lastFoundAt: null, lastChecked: null, onUpdate() {}, onDelete() {}, onRunNow() {},
  }));

  assert.match(view.container.textContent, /Ask Claude to repeat this task/);
  assert.match(view.container.textContent, /No automation yet/);
  assert.equal(view.container.querySelector('input[aria-label="Automation schedule"]'), null);
  await view.unmount();
});

test("the automation panel edits the schedule and prompt in one save", async () => {
  const patches: AutomationPatch[] = [];
  const automation = automationView();
  const view = await mount(React.createElement(AutomationPanel, {
    automation, engineLabel: "Claude", lastFoundAt: null, lastChecked: null, onUpdate: (patch) => { patches.push(patch); }, onDelete() {}, onRunNow() {},
  }));

  const schedule = query<HTMLInputElement>(view.container, 'input[aria-label="Automation schedule"]');
  const prompt = query<HTMLTextAreaElement>(view.container, 'textarea[aria-label="Automation prompt"]');
  const save = query<HTMLButtonElement>(view.container, ".automation-actions button");
  const setInput = item(Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")).set;
  const setTextarea = item(Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")).set;
  assert.equal(schedule.value, "*/5 * * * *");
  assert.equal(prompt.value, "Check whether the PR is approved");
  assert.equal(save.disabled, true, "an untouched automation has nothing to save");
  assert.match(view.container.textContent, /2 runs/);
  assert.match(view.container.textContent, /succeeded at/);

  await act(async () => {
    item(setInput).call(schedule, "0 8 * * *");
    schedule.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "0 8 * * *" }));
    schedule.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    item(setTextarea).call(prompt, "Check the PR and stop once it is approved");
    prompt.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "Check the PR and stop once it is approved" }));
    prompt.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => { query<HTMLButtonElement>(view.container, ".automation-actions button").click(); });

  assert.deepEqual(patches, [{ schedule: "0 8 * * *", prompt: "Check the PR and stop once it is approved" }]);
  await view.unmount();
});

test("the automation panel pauses, reruns, and removes without editing", async () => {
  const patches: AutomationPatch[] = [];
  let deleted = 0;
  let ranNow = 0;
  const view = await mount(React.createElement(AutomationPanel, {
    automation: automationView(),
    engineLabel: "Claude",
    lastFoundAt: null,
    lastChecked: null,
    onUpdate: (patch) => { patches.push(patch); },
    onDelete: () => { deleted += 1; },
    onRunNow: () => { ranNow += 1; },
  }));

  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Pause automation"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Run automation now"]').click(); });
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Remove automation"]').click(); });

  assert.deepEqual([...patches], [{ paused: true }]);
  assert.equal(ranNow, 1);
  assert.equal(deleted, 1);

  await view.render(React.createElement(AutomationPanel, {
    automation: automationView({ paused: true, nextRunAt: null }),
    engineLabel: "Claude",
    lastFoundAt: null,
    lastChecked: null,
    onUpdate: (patch) => { patches.push(patch); },
    onDelete() {},
    onRunNow() {},
  }));
  assert.match(view.container.textContent, /Paused/);
  await act(async () => { query<HTMLButtonElement>(view.container, 'button[aria-label="Resume automation"]').click(); });
  assert.deepEqual(patches.at(-1), { paused: false });
  await view.unmount();
});

test("the automation countdown stays readable at every distance", () => {
  const at = Date.parse("2026-08-17T09:00:00Z");
  assert.equal(formatCountdown(at + 45_000, at), "in 45s");
  assert.equal(formatCountdown(at + 300_000, at), "in 5m");
  assert.equal(formatCountdown(at + 7_200_000, at), "in 2h");
  assert.equal(formatCountdown(at - 5_000, at), "in 0s");
});

test("an automation with no next run reads as missed unless the user paused it", () => {
  const at = Date.parse("2026-08-17T09:00:00Z");
  assert.equal(automationStatusLabel(automationView({ nextRunAt: at + 60_000 }), at), "in 1m");
  assert.equal(automationStatusLabel(automationView({ paused: true, nextRunAt: null }), at), "Paused");
  assert.equal(automationStatusLabel(automationView({ nextRunAt: null, lastStatus: "missed" }), at), "Missed");
});

test("a scheduled tick runs in the original thread and reports back to the scheduler", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Watch PR 42"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent[0]);
  await act(async () => {
    desktop.listener({ type: "continuation.updated", taskId: first.taskId, runId: first.runId, sequence: 1, continuation: { provider: "claude", value: "session-1" } });
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 2, status: "succeeded" });
  });
  await settleFrame();

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: first.taskId, runId: "run-scheduled", prompt: "Check PR 42", runNumber: 3, policy: "autonomous" });
  });

  const scheduled = startCommand(desktop.sent[1]);
  assert.equal(scheduled.taskId, first.taskId, "the tick continues the original thread");
  assert.equal(scheduled.runId, "run-scheduled", "the scheduler's run ID is what comes back to it");
  assert.equal(scheduled.policy, "autonomous", "the automation's policy wins over the task's");
  assert.deepEqual(scheduled.continuation, { provider: "claude", value: "session-1" });
  assert.match(scheduled.prompt, /^Check PR 42/);
  assert.match(scheduled.prompt, /automated run #3/);
  assert.match(scheduled.prompt, /stop tool/);
  assert.deepEqual(desktop.acknowledged, [{ automationId: "automation-1", runId: "run-scheduled", started: true }]);

  const messages = item(workspace.get().currentThread).messages;
  assert.equal(item(messages.at(-1)).text, "Check PR 42", "the transcript shows the prompt, not the scheduler's framing");
  assert.equal(item(messages.at(-1)).detail, "Automation run #3");
  await workspace.view.unmount();
});

test("a tick that lands on a busy or archived task is declined instead of queued", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Watch PR 42"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent[0]);

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: first.taskId, runId: "run-overlap", prompt: "Check PR 42", runNumber: 2 });
  });
  assert.equal(desktop.sent.length, 1, "the running task never gets a second run");
  assert.deepEqual(desktop.acknowledged, [{ automationId: "automation-1", runId: "run-overlap", started: false }]);

  await act(async () => {
    await desktop.fireAutomation({ automationId: "automation-1", taskId: "task-gone", runId: "run-missing", prompt: "Check PR 42", runNumber: 2 });
  });
  assert.equal(item(desktop.acknowledged.at(-1)).started, false, "a tick for a task that no longer exists is declined");
  await workspace.view.unmount();
});

test("removing a project retires the automations of every task it takes with it", async () => {
  const project = { id: "project-1", root: "/project", workspaceId: "workspace-1" };
  const task = (id: string): Thread => ({
    id, title: id, projectId: project.id, engine: "claude", executionPolicy: "confirm", messages: [],
    continuationStatus: "none", lastChangeSnapshot: { files: [], capturedAt: 1 }, updatedAt: 1,
  });
  const desktop = fakeDesktop({
    loadTaskStore: async () => ({ version: 2, hiddenTasks: 0, projects: [project], worktrees: [], tasks: [task("task-1"), task("task-2"), task("task-3")], lastFolder: project.root }),
  });
  const workspace = await mountWorkspace(desktop);
  await act(async () => {});
  await act(async () => {
    desktop.automationsChanged([automationView({ taskId: "task-1" }), automationView({ id: "automation-2", taskId: "task-3" })]);
  });

  await act(async () => { workspace.get().actions.removeProject(project.id); });

  assert.deepEqual(
    desktop.automationChanges.map((change) => change.taskId).sort(),
    ["task-1", "task-3"],
    "every archived task's automation is retired, and tasks without one are left alone",
  );
  await workspace.view.unmount();
});

test("archiving a task retires its automation", async () => {
  const desktop = fakeDesktop();
  const workspace = await mountWorkspace(desktop);
  await act(async () => { workspace.get().actions.setPrompt("Watch PR 42"); });
  await act(async () => { await workspace.get().actions.sendPrompt(); });
  const first = startCommand(desktop.sent[0]);
  await act(async () => {
    desktop.listener({ type: "run.status", taskId: first.taskId, runId: first.runId, sequence: 1, status: "succeeded" });
  });
  await act(async () => { desktop.automationsChanged([automationView({ taskId: first.taskId })]); });
  assert.equal(item(workspace.get().automation).taskId, first.taskId);

  await act(async () => { workspace.get().actions.archiveThread(first.taskId); });

  assert.deepEqual(desktop.automationChanges, [{ taskId: first.taskId, deleted: true }]);
  await workspace.view.unmount();
});
