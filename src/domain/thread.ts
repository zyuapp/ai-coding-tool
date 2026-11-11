import type { AgentEngine, AgentModel } from "./agent-engine.js";
import type { ConversationMessage } from "./conversation.js";
import type { FindingsThread } from "./finding.js";
import type { AgentEffort, ExecutionPolicy } from "./run.js";
import type { CoordinationThread } from "./coordination.js";
import type { ThreadRole } from "./thread-role.js";
import type { RunThread, ThreadOutcome } from "./thread-run.js";
import type { PullRequestThread } from "./pull-request.js";
import type { WorktreeThread } from "./worktree.js";

/** A thread elsewhere last heard working: the paired computer holding it, and what it was called. */
export type HeardWork = { computer: string; title: string };

/**
 * What Stop all stopped of a thread elsewhere: the paired computer holding it, the run it asked to
 * end, or none for a wait on a usage limit, and when it stopped the thread's session work there, with
 * the run that is the agent's answer to that once it opens.
 */
export type RemoteStop = { computer: string; runId?: string; answer?: { at: number; runId?: string } };

/** A start on a paired computer Stop all caught on its way: the computer it went to, and once it landed, the thread it became there. */
export type CaughtStart = { computer: string; threadId?: string };

/**
 * The canonical conversation aggregate. Persisted property names stay unchanged for compatibility. It is one
 * flat record joined from the fields each feature keeps on it; only that feature patches them.
 */
export type Thread = ThreadCore & CoordinationThread & PullRequestThread & FindingsThread & RunThread & WorktreeThread;

/** What the thread is: its identity, conversation, settings, place in lists, and archive. */
export type ThreadCore = {
  id: string;
  title: string;
  /** Set once the user names the thread themselves, so a suggested title never replaces it. */
  titleByUser?: boolean;
  /** The part this thread plays beside the others, when the user has given it one. */
  role?: ThreadRole;
  projectId?: string;
  executionPolicy: ExecutionPolicy;
  engine: AgentEngine;
  /**
   * One the engine offers. Absent means the engine's default in the catalogue, which an engine that
   * only names its models once asked has none of until it does.
   */
  model?: AgentModel;
  effort?: AgentEffort;
  /** Only on an engine with fast mode. Absent means standard speed. */
  fastMode?: boolean;
  messages: ConversationMessage[];
  /** Present while the persisted conversation has yet to be loaded. */
  historySummary?: {
    messageCount: number;
    attachmentCount: number;
    firstMessageAt?: number;
    lastAudibleAt?: number;
  };
  /** Sidebar position. Only the user moves it; run activity never does. */
  sortIndex?: number;
  /**
   * Where lists ordered by recency place this thread. The reducer moves it when the thread is created,
   * a run starts, and a run ends, never while a run speaks, so a working thread holds its place.
   */
  rankedAt: number;
  /** Temporarily files this thread under Threads, preserving everything that needs attention. */
  snoozedUntil?: number;
  /** Absent on threads written before they were timestamped; {@link threadCreatedAt} fills those in. */
  createdAt?: number;
  updatedAt: number;
  archivedAt?: number;
};

export const TITLE_LIMIT = 52;

/** One length for every thread title, whoever wrote it: the user, the first message, or the model. */
export function clampTitle(text: string) {
  const trimmed = text.trim();
  return trimmed.length > TITLE_LIMIT ? `${trimmed.slice(0, TITLE_LIMIT - 3)}…` : trimmed;
}

const FORK_SUFFIX = /\s*\((?:fork|fork \d+)\)$/;

/**
 * What a copy of a thread is called: the copied thread's own name, numbered past every name already
 * taken. The suffix is stripped before it is added again, so a copy of a copy never stacks them.
 */
export function forkTitle(title: string, taken: Iterable<string>): string {
  const base = title.replace(FORK_SUFFIX, "").trim() || title.trim();
  const names = new Set(taken);
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? " (fork)" : ` (fork ${number})`;
    const room = TITLE_LIMIT - suffix.length;
    const candidate = `${base.length > room ? `${base.slice(0, room - 1)}…` : base}${suffix}`.trim();
    if (!names.has(candidate)) return candidate;
  }
}

export function threadCreatedAt(thread: Omit<Thread, "rankedAt">): number {
  return thread.createdAt ?? thread.historySummary?.firstMessageAt ?? thread.messages[0]?.at ?? thread.updatedAt;
}

/**
 * When the thread last said anything. It moves with every message a run writes, so a list ordered by it
 * reshuffles while threads work: order lists by `rankedAt`. A tick that surfaced nothing withdrew the
 * messages it wrote and put `runEndedAt` back, so it counts for nothing here.
 */
export function threadLastOutputAt(thread: Omit<Thread, "rankedAt">): number {
  return Math.max(threadCreatedAt(thread), lastAudibleAt(thread), thread.runEndedAt ?? 0);
}

function lastAudibleAt(thread: Omit<Thread, "rankedAt">): number {
  if (thread.historySummary) return thread.historySummary.lastAudibleAt ?? 0;
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (!message.withdrawn) return message.at;
  }
  return 0;
}

/**
 * How the thread's newest run ended. One that ended before threads kept this, as on a paired computer
 * on an older build, is read by its verdict.
 */
export function lastRunOutcome(thread: Thread): ThreadOutcome | undefined {
  return thread.runEndedAs ?? thread.outcome;
}
