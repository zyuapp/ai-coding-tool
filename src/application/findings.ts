/**
 * Raising a finding on the workspace's behalf: what a scheduled run reports, and what a schedule
 * that cannot run at all says for itself. A function belongs here when it needs the whole workspace
 * or has to tell the desktop.
 */
import type { AutomationFire } from "../contracts/ipc.js";
import type { FindingReport } from "../contracts/threads.js";
import { findingOutcome, withFinding } from "../domain/attention.js";
import { declineCount, DECLINES_BEFORE_SURFACING } from "../domain/automation.js";
import type { Task } from "../domain/task.js";
import { scheduledRun, withNotifiedRun } from "./run-testimony.js";
import { applyTask } from "./task-workspace.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./workspace-reducer.js";
import type { WorkspaceState } from "./workspace-state.js";

/** Whether the thread is turning ticks away because the user is using it themselves. */
function userIsHere(state: WorkspaceState, taskId: string): boolean {
  return state.activeRuns[taskId]?.origin === "composer"
    || Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId && pending.origin === "composer");
}

/** What raising a finding tells the desktop, so a thread that spoke while hidden still reaches the user. */
function announced(task: Task, headline: string): WorkspaceEffect {
  return { type: "announce-finding", notice: { taskId: task.id, title: task.title, headline } };
}

/** Only a scheduled run may raise one: a turn the user is present for answers them directly. */
export function raisedFinding(state: WorkspaceState, report: FindingReport & { taskId: string }): WorkspaceTransition {
  const task = scheduledRun(state, report.taskId) ? state.tasks.find((item) => item.id === report.taskId) : undefined;
  if (!task) return { state, effects: [] };
  const raised = findingOutcome(task, report.key) === "recorded";
  /** A thread the user is watching cannot have missed it, exactly as a settled run's verdict is not marked. */
  const seen = state.focused && state.currentId === report.taskId;
  const next = withNotifiedRun(state, report.taskId, report, Date.now(), seen);
  return { state: next, effects: raised ? [announced(task, report.headline)] : [] };
}

/**
 * A tick with nowhere to run is acknowledged and dropped, which the scheduler counts. A schedule
 * turned away over and over is a silence of its own, so the thread says so out loud, once.
 */
export function declinedTick(state: WorkspaceState, fire: AutomationFire, task?: Task): WorkspaceTransition {
  const acked: WorkspaceEffect[] = [{ type: "automation.ack", ack: { automationId: fire.automationId, runId: fire.runId, started: false } }];
  const automation = state.automations.find((item) => item.id === fire.automationId);
  if (!task || !automation || declineCount(automation) + 1 < DECLINES_BEFORE_SURFACING) return { state, effects: acked };
  /** A thread its own user is working in is not a broken schedule: they are here, and the ticks resume when they stop. */
  if (userIsHere(state, fire.taskId)) return { state, effects: acked };
  const key = `declined:${automation.id}`;
  /**
   * Once per stretch of declines, however many the scheduler counted before the workspace saw one:
   * ticks turned away where no reducer was listening still climb the count. A notice from an earlier
   * stretch was about a schedule that has run since, so it does not stand in for this one.
   */
  const since = automation.lastRunAt ?? 0;
  const said = findingOutcome(task, key) !== "recorded" || (task.findings ?? []).some((finding) => finding.key === key && finding.at >= since);
  if (said) return { state, effects: acked };
  const headline = `This automation has not been able to run since ${new Date(automation.lastRunAt ?? automation.createdAt).toLocaleString()}`;
  const report = { headline, key };
  const seen = state.focused && state.currentId === task.id;
  return {
    state: applyTask(state, task.id, (item) => withFinding(item, report, Date.now(), seen)),
    effects: [...acked, announced(task, headline)],
  };
}
