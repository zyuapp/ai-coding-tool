/**
 * What a thread has to say for itself: the verdict its last run left, and what its runs found. A
 * verdict belongs to one run and the next run supersedes it; a finding outlives every run after it,
 * because the tick that raised it may have been at 3am. Both rank a thread in Priority, both are
 * marked read by landing on the thread, and both are retired by the same dismissal.
 */
import type { AutomationFire, RunEvent } from "../contracts/ipc.js";
import type { FindingReport } from "../contracts/threads.js";
import { declineCount, DECLINES_BEFORE_SURFACING } from "../domain/automation.js";
import { MAX_FINDINGS, MAX_SILENCED_KEYS, type Task, type TaskFinding, type TaskOutcome } from "../domain/task.js";
import { applyTask, createTaskMessage, type ActiveRun, type RunTransitionState, type ThreadMark } from "./task-workspace.js";
import type { WorkspaceEffect, WorkspaceTransition } from "./workspace-reducer.js";
import type { WorkspaceState } from "./workspace-state.js";

/**
 * What raising one did. A finding the thread already carries unread is the same finding, and a
 * thread already carrying its fill has nowhere to put another without losing one.
 */
export type FindingOutcome = "recorded" | "duplicate" | "full";

export function unreadFindings(task: Task): TaskFinding[] {
  return (task.findings ?? []).filter((finding) => !finding.read);
}

/** The headline a row shows: the newest thing the user has not seen. */
export function newestUnreadFinding(task: Task): TaskFinding | undefined {
  return unreadFindings(task).at(-1);
}

export function hasFindings(task: Task): boolean {
  return (task.findings ?? []).length > 0;
}

export function findingOutcome(task: Task, key?: string): FindingOutcome {
  /** A key holds while the thread carries it and while the user has it filed away: neither is news. */
  if (key !== undefined && ((task.findings ?? []).some((finding) => finding.key === key) || (task.silencedKeys ?? []).includes(key))) return "duplicate";
  return unreadFindings(task).length >= MAX_FINDINGS ? "full" : "recorded";
}

/**
 * Records the finding, oldest dropped once the thread is at its fill, and says it in the thread so
 * the transcript still carries it once the finding itself is filed away. A duplicate changes nothing.
 */
export function withFinding(task: Task, report: FindingReport, at: number, seen = false): Task {
  if (findingOutcome(task, report.key) !== "recorded") return task;
  const finding: TaskFinding = {
    id: crypto.randomUUID(),
    headline: report.headline,
    ...(report.detail ? { detail: report.detail } : {}),
    ...(report.key ? { key: report.key } : {}),
    at,
    ...(seen ? { read: true as const } : {}),
  };
  return {
    ...task,
    findings: [...task.findings ?? [], finding].slice(-MAX_FINDINGS),
    /** Outlives the finding itself, so a schedule that found something at 3am can still prove it. */
    lastFindingAt: at,
    messages: [...task.messages, createTaskMessage("system", report.headline, report.detail)],
    updatedAt: at,
  };
}

/** Landing on the thread takes the marks off. The findings stay, the way a verdict stays. */
export function withReadFindings(task: Task): Task {
  if (!unreadFindings(task).length) return task;
  return { ...task, findings: task.findings!.map((finding) => finding.read ? finding : { ...finding, read: true as const }) };
}

/** Filing the thread away is what retires what it found. */
export function withoutFindings(task: Task): Task {
  if (!task.findings) return task;
  const { findings: _filed, ...rest } = task;
  return rest;
}

/**
 * Puts a thread back where a tick found it: the messages that tick wrote count for nothing in the
 * thread's activity, the moments it moved are rolled back, and the verdict beginning the run
 * superseded is returned, unread as it was. A tick that says nothing takes nothing away either.
 */
export function silencedThread(task: Task, from: number, before: ThreadMark): Task {
  const { runEndedAt: _stamped, outcome: _superseded, outcomeUnread: _unread, ...rest } = task;
  return {
    ...rest,
    messages: task.messages.map((message, index) => index < from || message.quiet ? message : { ...message, quiet: true as const }),
    updatedAt: before.updatedAt,
    ...(before.runEndedAt === undefined ? {} : { runEndedAt: before.runEndedAt }),
    ...(before.outcome === undefined ? {} : { outcome: before.outcome }),
    ...(before.outcomeUnread ? { outcomeUnread: true as const } : {}),
  };
}

/** A run only earns a verdict when it settles on its own; cancelling is the user's own doing. */
export function outcomeFor(event: RunEvent): TaskOutcome | null {
  if (event.type !== "run.status") return null;
  if (event.status === "succeeded") return "finished";
  if (event.status === "failed") return "failed";
  return null;
}

/**
 * Landing on a thread takes its marks off. The verdict and what its runs found both stay, so the
 * thread keeps its place in Priority until the user files it away.
 */
export function readAttention<T extends { tasks: Task[] }>(state: T, taskId: string | null): T {
  const seen = taskId ? state.tasks.find((task) => task.id === taskId) : undefined;
  if (!seen || (!seen.outcomeUnread && !unreadFindings(seen).length)) return state;
  const { outcomeUnread: _read, ...rest } = seen;
  return { ...state, tasks: state.tasks.map((task) => task === seen ? withReadFindings(rest) : task) };
}

/** Retires the named threads' verdicts, leaving the list alone when none of them carry one. */
export function withoutOutcome(tasks: Task[], dismissing: Set<string>): Task[] {
  if (!tasks.some((task) => dismissing.has(task.id) && task.outcome)) return tasks;
  return tasks.map((task) => {
    if (!dismissing.has(task.id) || !task.outcome) return task;
    const { outcome: _gone, outcomeUnread: _read, ...rest } = task;
    return rest;
  });
}

/**
 * Filing a thread away retires what its runs found along with the verdict of the last one. The keys
 * go with it rather than being forgotten: a dismissal says the finding is handled, not that the user
 * wants telling again on the next tick.
 */
export function dismissed(tasks: Task[], dismissing: Set<string>): Task[] {
  const filed = withoutOutcome(tasks, dismissing);
  if (!filed.some((task) => dismissing.has(task.id) && task.findings)) return filed;
  return filed.map((task) => dismissing.has(task.id) ? withoutFindings(silenceKeys(task)) : task);
}

function silenceKeys(task: Task): Task {
  const keys = (task.findings ?? []).flatMap((finding) => finding.key ?? []);
  if (!keys.length) return task;
  const silenced = [...(task.silencedKeys ?? []).filter((key) => !keys.includes(key)), ...keys];
  return { ...task, silencedKeys: silenced.slice(-MAX_SILENCED_KEYS) };
}

/**
 * What a run that has finished looking says about the keys it did not report: the thing it was
 * filed away for is over, so the next sighting is news again.
 */
export function withLiftedSilences(task: Task, reportedKeys: string[]): Task {
  const held = task.silencedKeys ?? [];
  const still = held.filter((key) => reportedKeys.includes(key));
  if (still.length === held.length) return task;
  if (!still.length) {
    const { silencedKeys: _lifted, ...rest } = task;
    return rest;
  }
  return { ...task, silencedKeys: still };
}

/** Which threads a "dismiss everything" reaches: the ones carrying anything to file away. */
export function dismissableTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => task.outcome || hasFindings(task));
}

/** Whether the thread is turning ticks away because the user is using it themselves. */
function userIsHere(state: WorkspaceState, taskId: string): boolean {
  return state.activeRuns[taskId]?.origin === "composer"
    || Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId && pending.origin === "composer");
}

/** The run a scheduled tick is executing, and nothing else. Silence is only ever a schedule's to earn. */
export function scheduledRun(state: RunTransitionState, taskId: string): ActiveRun | undefined {
  const active = state.activeRuns[taskId];
  return active?.origin === "automation" ? active : undefined;
}

/**
 * Records what a run found and marks the run as having spoken. The mark is set even when the finding
 * itself is turned away, so a run that says it found something can never be settled unseen.
 */
export function withNotifiedRun<T extends RunTransitionState>(state: T, taskId: string, report: FindingReport, at: number, seen = false): T {
  const active = scheduledRun(state, taskId);
  if (!active) return state;
  /** A duplicate is still the run answering for itself, but it is not news, so it does not break the silence. */
  const raised = state.tasks.some((task) => task.id === taskId && findingOutcome(task, report.key) === "recorded");
  return {
    ...state,
    activeRuns: { ...state.activeRuns, [taskId]: {
      ...active,
      acknowledged: true,
      notified: active.notified || raised,
      reportedKeys: report.key === undefined || active.reportedKeys.includes(report.key) ? active.reportedKeys : [...active.reportedKeys, report.key],
    } },
    tasks: state.tasks.map((task) => task.id === taskId ? withFinding(task, report, at, seen) : task),
  };
}

/** A run saying it looked and found nothing. What it says never retracts what it already surfaced. */
export function withNothingToReport<T extends RunTransitionState>(state: T, taskId: string, checked: string, at: number): T {
  const active = scheduledRun(state, taskId);
  if (!active) return state;
  const acknowledged = { ...state, activeRuns: { ...state.activeRuns, [taskId]: { ...active, acknowledged: true } } };
  return applyTask(acknowledged, taskId, (task) => ({ ...task, lastChecked: { at, note: checked } }));
}

/**
 * Whether this run settled with nothing to say. Silence is earned by a scheduled quiet run that
 * succeeded and answered for itself without raising anything new: a failure, a cancellation, a run
 * that found something, and a run that answered nothing at all surface as they always have.
 */
export function settledUnseen(active: ActiveRun, event: RunEvent): boolean {
  return active.origin === "automation"
    && active.quiet
    && event.type === "run.status"
    && event.status === "succeeded"
    && active.acknowledged
    && !active.notified;
}

/**
 * What a settling run leaves on its thread besides a verdict: an unseen tick puts the thread back
 * where it found it, and a scheduled run that finished looking lifts the filed-away findings it no
 * longer reports.
 */
export function withSettledTick<T extends RunTransitionState>(state: T, taskId: string, active: ActiveRun, unseen: boolean, outcome: TaskOutcome): T {
  const lifting = outcome === "finished" && active.origin === "automation" && active.acknowledged;
  if (!unseen && !lifting) return state;
  return applyTask(state, taskId, (task) => {
    const settled = unseen ? silencedThread(task, active.messagesBefore, active.before) : task;
    return lifting ? withLiftedSilences(settled, active.reportedKeys) : settled;
  });
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
