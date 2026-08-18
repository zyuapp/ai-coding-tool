import type { ExecutionPolicy } from "./run.js";

export const MAX_AUTOMATION_PROMPT = 100_000;
export const MAX_AUTOMATION_SCHEDULE = 200;
export const MAX_AUTOMATION_TIMEZONE = 100;

/** `missed` is not a run: it marks a one-shot whose moment passed without one. */
export type AutomationRunStatus = "succeeded" | "failed" | "cancelled" | "skipped" | "missed";

/** A task's recurring prompt. One per task: re-creating replaces the previous one. */
export type Automation = {
  id: string;
  taskId: string;
  prompt: string;
  /** A five-field cron expression, or an ISO 8601 timestamp for a single run. */
  schedule: string;
  timezone?: string;
  /** Overrides the task's policy for scheduled runs; unattended runs usually need `autonomous`. */
  policy?: ExecutionPolicy;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  lastRunAt?: number;
  lastStatus?: AutomationRunStatus;
};

/** What the renderer renders: the record plus the firing time only the scheduler can compute. */
export type AutomationView = Automation & { nextRunAt: number | null };

export type AutomationDraft = {
  taskId: string;
  prompt: string;
  schedule: string;
  timezone?: string;
  policy?: ExecutionPolicy;
  paused?: boolean;
};

export type AutomationPatch = {
  prompt?: string;
  schedule?: string;
  timezone?: string;
  policy?: ExecutionPolicy;
  paused?: boolean;
};

function isPolicy(value: unknown): value is ExecutionPolicy {
  return value === "confirm" || value === "plan" || value === "allow-edits" || value === "autonomous";
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
    && typeof record.paused === "boolean"
    && isTimestamp(record.createdAt)
    && isTimestamp(record.updatedAt)
    && isTimestamp(record.runCount)
    && (record.lastRunAt === undefined || isTimestamp(record.lastRunAt))
    && (record.lastStatus === undefined || isRunStatus(record.lastStatus));
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
    && (draft.paused === undefined || typeof draft.paused === "boolean");
}

export function isAutomationPatch(value: unknown): value is AutomationPatch {
  if (!value || typeof value !== "object") return false;
  const patch = value as Record<string, unknown>;
  return (patch.prompt === undefined || isText(patch.prompt, MAX_AUTOMATION_PROMPT))
    && (patch.schedule === undefined || isText(patch.schedule, MAX_AUTOMATION_SCHEDULE))
    && (patch.timezone === undefined || isText(patch.timezone, MAX_AUTOMATION_TIMEZONE))
    && (patch.policy === undefined || isPolicy(patch.policy))
    && (patch.paused === undefined || typeof patch.paused === "boolean");
}

/** A tick that never ran leaves the counters alone so "last run" stays truthful. */
export function automationAfterRun(automation: Automation, status: AutomationRunStatus, at: number): Automation {
  if (status === "skipped" || status === "missed") return { ...automation, lastStatus: status, updatedAt: at };
  return { ...automation, runCount: automation.runCount + 1, lastRunAt: at, lastStatus: status, updatedAt: at };
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
