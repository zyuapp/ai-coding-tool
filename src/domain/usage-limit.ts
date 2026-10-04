import type { AgentEngine } from "./agent-engine.js";
import type { Annotation, AttachedFile, PastedText } from "./conversation.js";
import type { MessageOrigin } from "./message-origin.js";
import type { Thread } from "./thread.js";

/**
 * The account ran out of its plan's allowance and gets it back at `resetsAt`. A session limit lifts
 * within hours; any longer one can be days away, so it waits for the user instead of resuming.
 */
export type UsageLimit = {
  resetsAt: number;
  window: "session" | "weekly";
};

/** A message written to a paused thread, kept until the thread resumes with it. */
export type HeldMessage = {
  id: string;
  text: string;
  prompt: string;
  attachments: string[];
  annotations?: Annotation[];
  pastes?: PastedText[];
  files?: AttachedFile[];
  origin?: MessageOrigin;
  /** The origin's label, for builds that read only this. */
  detail?: string;
};

/** A thread waiting out its account's usage limit. Persisted, so a restart keeps its place in line. */
export type LimitPause = UsageLimit & {
  pausedAt: number;
  /** When the user last wrote to it while it waited, which puts it at the front of the line. */
  nudgedAt?: number;
  /** A dynamic workflow was cut short with the run, so resuming picks it up rather than starting over. */
  workflow?: true;
  /** What was written to it while it waited, so a restart does not lose it. */
  held?: HeldMessage[];
};

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function isUsageLimit(value: unknown): value is UsageLimit {
  if (!value || typeof value !== "object") return false;
  const limit = value as Record<string, unknown>;
  return finitePositive(limit.resetsAt) && (limit.window === "session" || limit.window === "weekly");
}

export function isLimitPause(value: unknown): value is LimitPause {
  if (!isUsageLimit(value)) return false;
  const pause = value as Record<string, unknown>;
  return finitePositive(pause.pausedAt)
    && (pause.nudgedAt === undefined || finitePositive(pause.nudgedAt))
    && (pause.workflow === undefined || pause.workflow === true)
    && (pause.held === undefined || Array.isArray(pause.held));
}

export function withoutLimitPause(thread: Thread): Thread {
  if (!thread.limitPause) return thread;
  const { limitPause: _lifted, ...rest } = thread;
  return rest;
}

/** Whether the thread resumes on its own once its limit lifts. A weekly limit waits for the user. */
export function resumesOnItsOwn(pause: LimitPause) {
  return pause.window === "session";
}

/**
 * The order an engine's paused threads resume in: the one the user wrote to last first, then the order
 * they paused in, with a reviewer ahead of the rest so the thread waiting on its verdict has one to
 * read, and a dynamic workflow last since it restarts many agents at once.
 */
function lineOrder(left: Thread, right: Thread) {
  const a = left.limitPause!, b = right.limitPause!;
  if ((a.nudgedAt === undefined) !== (b.nudgedAt === undefined)) return a.nudgedAt === undefined ? 1 : -1;
  if (a.nudgedAt !== undefined && b.nudgedAt !== undefined && a.nudgedAt !== b.nudgedAt) return b.nudgedAt - a.nudgedAt;
  if ((left.role === "reviewer") !== (right.role === "reviewer")) return left.role === "reviewer" ? -1 : 1;
  if (Boolean(a.workflow) !== Boolean(b.workflow)) return a.workflow ? 1 : -1;
  return a.pausedAt - b.pausedAt;
}

const lines = new WeakMap<Thread[], Map<AgentEngine, Thread[]>>();

/** Every engine's line of threads that resume on their own, first to go first. */
export function limitLines(threads: Thread[]): Map<AgentEngine, Thread[]> {
  const cached = lines.get(threads);
  if (cached) return cached;
  const byEngine = new Map<AgentEngine, Thread[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== undefined || !thread.limitPause || !resumesOnItsOwn(thread.limitPause)) continue;
    byEngine.set(thread.engine, [...byEngine.get(thread.engine) ?? [], thread]);
  }
  for (const line of byEngine.values()) line.sort(lineOrder);
  lines.set(threads, byEngine);
  return byEngine;
}

const positions = new WeakMap<Thread[], Map<string, number>>();

/** Where each paused thread stands in its engine's line, counting from 1. */
export function linePositions(threads: Thread[]): Map<string, number> {
  const cached = positions.get(threads);
  if (cached) return cached;
  const places = new Map<string, number>();
  for (const line of limitLines(threads).values()) line.forEach((thread, index) => places.set(thread.id, index + 1));
  positions.set(threads, places);
  return places;
}

/**
 * A limit is the account's, so every thread of the engine waiting on an earlier reset waits for this
 * one too. A weekly limit reached by one of them holds them all.
 */
export function withEngineLimit(threads: Thread[], engine: AgentEngine, limit: UsageLimit): Thread[] {
  let changed = false;
  const next = threads.map((thread) => {
    const pause = thread.limitPause;
    if (thread.engine !== engine || !pause || pause.resetsAt >= limit.resetsAt) return thread;
    changed = true;
    return { ...thread, limitPause: { ...pause, resetsAt: limit.resetsAt, window: limit.window === "weekly" ? "weekly" as const : pause.window } };
  });
  return changed ? next : threads;
}

const WORKFLOW_NOTE = "A dynamic workflow was cut short when the usage limit hit: resume it with the Workflow tool's resumeFromRunId, using the run ID its launch returned, so finished agents are not run again.";

/** What a resumed thread is told: the message written to it while it waited, or to carry on. */
export function resumePrompt(pause: LimitPause, written?: string) {
  const prompt = written ?? "The usage limit that paused this thread has reset. Continue where you left off.";
  return pause.workflow ? `${prompt}\n\n${WORKFLOW_NOTE}` : prompt;
}

/** When a limit lifts, as a time today or a day and time further out. */
export function liftTime(resetsAt: number, now: number) {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
}

function ordinal(position: number) {
  const tens = position % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][position % 10] ?? "th";
  return `${position}${suffix}`;
}

/** What a paused thread's row says about it: when it goes, and behind how many others. */
export function pauseSummary(pause: LimitPause, position: number | null, now: number) {
  if (!resumesOnItsOwn(pause)) return now < pause.resetsAt ? `Weekly limit · resets ${liftTime(pause.resetsAt, now)}` : "Weekly limit reset";
  const place = position !== null && position > 1 ? ` · ${ordinal(position)}` : "";
  return now < pause.resetsAt ? `Resumes ${liftTime(pause.resetsAt, now)}${place}` : `Resuming${place}`;
}
