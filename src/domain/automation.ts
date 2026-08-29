import type { ExecutionPolicy } from "./run.js";

export const MAX_AUTOMATION_PROMPT = 100_000;
export const MAX_AUTOMATION_SCHEDULE = 200;
export const MAX_AUTOMATION_TIMEZONE = 100;
export const MAX_SURFACE_WHEN = 500;

/** `missed` is not a run: it marks a one-shot whose moment passed without one. */
export type AutomationRunStatus = "succeeded" | "failed" | "cancelled" | "skipped" | "missed";

/** A thread's recurring prompt. One per thread: re-creating replaces the previous one. */
export type Automation = {
  id: string;
  taskId: string;
  prompt: string;
  /** A five-field cron expression, or an ISO 8601 timestamp for a single run. */
  schedule: string;
  timezone?: string;
  /** Overrides the thread's policy for scheduled runs; unattended runs usually need `autonomous`. */
  policy?: ExecutionPolicy;
  /**
   * When a scheduled tick is worth the user's attention, in the automation's own words. Present makes
   * the schedule quiet: a tick that says it found nothing settles without surfacing. Absent is loud.
   */
  surfaceWhen?: string;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  lastRunAt?: number;
  lastStatus?: AutomationRunStatus;
  /** When `lastStatus` was recorded. A tick that never ran moves this without moving `lastRunAt`. */
  lastStatusAt?: number;
  /** Ticks turned away in a row. A schedule that cannot run is a silence the user has to hear about. */
  consecutiveDeclines?: number;
  /** Ticks croner dropped because the previous run was still going. Nothing else records these. */
  overrunCount?: number;
};

/** What the renderer renders: the record plus the firing time only the scheduler can compute. */
export type AutomationView = Automation & { nextRunAt: number | null };

export type AutomationDraft = {
  taskId: string;
  prompt: string;
  schedule: string;
  timezone?: string;
  policy?: ExecutionPolicy;
  surfaceWhen?: string;
  paused?: boolean;
};

export type AutomationPatch = {
  prompt?: string;
  schedule?: string;
  timezone?: string;
  policy?: ExecutionPolicy;
  /** An empty sentence makes the schedule loud again; anything else is what it surfaces for. */
  surfaceWhen?: string;
  paused?: boolean;
};

function isPolicy(value: unknown): value is ExecutionPolicy {
  return value === "confirm" || value === "plan" || value === "allow-edits" || value === "autonomous" || value === "bypass";
}

function isText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isTimestamp(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isAutomation(value: unknown): value is Automation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isText(record.id, 256)
    && isText(record.taskId, 256)
    && isText(record.prompt, MAX_AUTOMATION_PROMPT)
    && isText(record.schedule, MAX_AUTOMATION_SCHEDULE)
    && (record.timezone === undefined || isText(record.timezone, MAX_AUTOMATION_TIMEZONE))
    && (record.policy === undefined || isPolicy(record.policy))
    && (record.surfaceWhen === undefined || isText(record.surfaceWhen, MAX_SURFACE_WHEN))
    && typeof record.paused === "boolean"
    && isTimestamp(record.createdAt)
    && isTimestamp(record.updatedAt)
    && isTimestamp(record.runCount)
    && (record.lastRunAt === undefined || isTimestamp(record.lastRunAt))
    && (record.lastStatus === undefined || isRunStatus(record.lastStatus))
    && (record.lastStatusAt === undefined || isTimestamp(record.lastStatusAt))
    && (record.consecutiveDeclines === undefined || isTimestamp(record.consecutiveDeclines))
    && (record.overrunCount === undefined || isTimestamp(record.overrunCount));
}

function isRunStatus(value: unknown): value is AutomationRunStatus {
  return value === "succeeded" || value === "failed" || value === "cancelled" || value === "skipped" || value === "missed";
}

export function isAutomationDraft(value: unknown): value is AutomationDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return isText(draft.taskId, 256)
    && isText(draft.prompt, MAX_AUTOMATION_PROMPT)
    && isText(draft.schedule, MAX_AUTOMATION_SCHEDULE)
    && (draft.timezone === undefined || isText(draft.timezone, MAX_AUTOMATION_TIMEZONE))
    && (draft.policy === undefined || isPolicy(draft.policy))
    /** Absent keeps whatever the schedule already surfaces for; empty is what takes the quiet off. */
    && (draft.surfaceWhen === undefined || isText(draft.surfaceWhen, MAX_SURFACE_WHEN))
    && (draft.paused === undefined || typeof draft.paused === "boolean");
}

export function isAutomationPatch(value: unknown): value is AutomationPatch {
  if (!value || typeof value !== "object") return false;
  const patch = value as Record<string, unknown>;
  return (patch.prompt === undefined || isText(patch.prompt, MAX_AUTOMATION_PROMPT))
    && (patch.schedule === undefined || isText(patch.schedule, MAX_AUTOMATION_SCHEDULE))
    && (patch.timezone === undefined || isText(patch.timezone, MAX_AUTOMATION_TIMEZONE))
    && (patch.policy === undefined || isPolicy(patch.policy))
    && (patch.surfaceWhen === undefined || patch.surfaceWhen === "" || isText(patch.surfaceWhen, MAX_SURFACE_WHEN))
    && (patch.paused === undefined || typeof patch.paused === "boolean");
}

/** A tick that never ran leaves the counters alone so "last run" stays truthful. */
export function automationAfterRun(automation: Automation, status: AutomationRunStatus, at: number): Automation {
  if (status === "missed") return { ...automation, lastStatus: status, lastStatusAt: at, updatedAt: at };
  if (status === "skipped") return { ...automation, consecutiveDeclines: declineCount(automation) + 1, lastStatus: status, lastStatusAt: at, updatedAt: at };
  const { consecutiveDeclines: _ran, ...ran } = automation;
  return { ...ran, runCount: automation.runCount + 1, lastRunAt: at, lastStatus: status, lastStatusAt: at, updatedAt: at };
}

export function declineCount(automation: { consecutiveDeclines?: number }) {
  return automation.consecutiveDeclines ?? 0;
}

/** How many declines in a row it takes before the schedule's silence is itself worth surfacing. */
export const DECLINES_BEFORE_SURFACING = 3;

/**
 * What kind of tick this is. Only a cron tick of a quiet schedule may settle unseen, never a run the
 * user asked for and never a one-shot. `unattended` is the wider fact: a cron tick has nobody to
 * answer for it, so its run may answer its own approvals.
 */
export type TickKind = { quiet: boolean; unattended: boolean };

/**
 * Whether this tick may settle unseen. Only a cron tick of a schedule that says what it surfaces for:
 * a run the user asked for is watched by construction, and a one-shot deletes itself when it runs, so
 * a quiet one would disappear having said nothing at all.
 */
export function quietTick(automation: Pick<Automation, "schedule" | "surfaceWhen">, manual: boolean) {
  return !manual && automation.surfaceWhen !== undefined && !isOneShotSchedule(automation.schedule);
}

export function didRun(status: AutomationRunStatus) {
  return status !== "skipped" && status !== "missed";
}

/** A one-shot automation is an ISO 8601 timestamp rather than a cron expression. */
export function isOneShotSchedule(schedule: string) {
  return !Number.isNaN(Date.parse(schedule)) && schedule.includes("-");
}

export function scheduleFieldCount(schedule: string) {
  return schedule.trim().split(/\s+/).length;
}
