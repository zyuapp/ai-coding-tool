/**
 * Where a scheduled tick meets the workspace: whether it can run at all, what a run of it raises,
 * and what a schedule turned away says for itself. A function belongs here when it needs the whole
 * workspace or has to tell the desktop.
 */
import type { AutomationFire } from "../contracts/ipc.js";
import type { FindingReport } from "../contracts/threads.js";
import { isNews, withFinding } from "../domain/attention.js";
import { declineCount, DECLINES_BEFORE_SURFACING } from "../domain/automation.js";
import type { Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import { announced } from "./notices.js";
import { scheduledRun, withNotifiedRun } from "./run-testimony.js";
import { threadBusy } from "./thread-projection.js";
import { applyTask } from "./task-workspace.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./workspace-reducer.js";
import type { WorkspaceState } from "./workspace-state.js";

/** Why a tick has nowhere to run. */
export type TickRefusal = "no-thread" | "archived" | "busy-user" | "busy-agent" | "no-workspace";

/** Whether the user has a turn of their own going, which is what a tick waits behind. */
function userIsHere(state: WorkspaceState, taskId: string): boolean {
  return state.activeRuns[taskId]?.origin === "composer"
    || Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId && pending.origin === "composer");
}

/**
 * Who the thread is working for, if anyone. Busy is {@link threadBusy}'s answer, so a send still
 * resolving and a message still queued both count: two runs in one thread would make two checkouts.
 */
function whoIsBusy(state: WorkspaceState, taskId: string): "busy-user" | "busy-agent" | null {
  if (!threadBusy(state, taskId)) return null;
  return userIsHere(state, taskId) ? "busy-user" : "busy-agent";
}

/**
 * Why this tick cannot run, or null when it can. A thread its own user is working in is named apart
 * from one an agent is busy in, and answered first: the two would otherwise both read as busy, and
 * only the second is a schedule failing to get a turn.
 */
export function whyTickCannotRun(state: WorkspaceState, fire: AutomationFire, task?: Thread, project?: Project): TickRefusal | null {
  if (!task) return "no-thread";
  const busy = whoIsBusy(state, fire.taskId);
  if (busy) return busy;
  if (task.archivedAt !== undefined) return "archived";
  /** A thread in a project runs in that project's checkout, so it waits until there is one. */
  if (task.projectId && !project?.workspaceId) return "no-workspace";
  return null;
}

/** Only a scheduled run may raise one: a turn the user is present for answers them directly. */
export function raisedFinding(state: WorkspaceState, report: FindingReport & { taskId: string }): WorkspaceTransition {
  const task = scheduledRun(state, report.taskId) ? state.tasks.find((item) => item.id === report.taskId) : undefined;
  if (!task) return { state, effects: [] };
  const raised = isNews(task, report.key);
  /** A thread the user is watching cannot have missed it. */
  const seen = state.focused && state.currentId === report.taskId;
  const next = withNotifiedRun(state, report.taskId, report, Date.now(), seen);
  return { state: next, effects: raised ? announced(state, task, report.headline) : [] };
}

/**
 * A tick with nowhere to run is acknowledged and dropped, which the scheduler counts. A schedule
 * turned away over and over is a silence of its own, so the thread says so out loud, once.
 */
export function declinedTick(state: WorkspaceState, fire: AutomationFire, task: Thread | undefined, refusal: TickRefusal): WorkspaceTransition {
  const acked: WorkspaceEffect[] = [{ type: "automation.ack", ack: { automationId: fire.automationId, runId: fire.runId, started: false } }];
  const automation = state.automations.find((item) => item.id === fire.automationId);
  if (!task || !automation || declineCount(automation) + 1 < DECLINES_BEFORE_SURFACING) return { state, effects: acked };
  /** A thread its own user is working in is not a broken schedule: they are here, and the ticks resume when they stop. */
  if (refusal === "busy-user") return { state, effects: acked };
  const key = `declined:${automation.id}`;
  /**
   * Once per stretch of declines, however many the scheduler counted before the workspace saw one:
   * ticks turned away where no reducer was listening still climb the count. A notice from an earlier
   * stretch was about a schedule that has run since, so it does not stand in for this one.
   */
  const since = automation.lastRunAt ?? 0;
  const said = !isNews(task, key) || (task.findings ?? []).some((finding) => finding.key === key && finding.at >= since);
  if (said) return { state, effects: acked };
  const headline = `This automation has not been able to run since ${new Date(automation.lastRunAt ?? automation.createdAt).toLocaleString()}`;
  const report = { headline, key };
  const seen = state.focused && state.currentId === task.id;
  return {
    state: applyTask(state, task.id, (item) => withFinding(item, report, Date.now(), seen)),
    effects: [...acked, ...announced(state, task, headline)],
  };
}
