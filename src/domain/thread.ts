import type { AgentEngine, AgentModel } from "./agent-engine.js";
import type { ConversationMessage } from "./conversation.js";
import type { AutomationFinding } from "./finding.js";
import type { AgentEffort, Continuation, ExecutionPolicy } from "./run.js";
import type { ChangeSnapshot, ContextUsage, ContinuationStatus, ThreadOutcome } from "./thread-run.js";

/** The canonical conversation aggregate. Persisted property names stay unchanged for compatibility. */
export type Thread = {
  id: string;
  title: string;
  /** Set once the user names the thread themselves, so a suggested title never replaces it. */
  titleByUser?: boolean;
  projectId?: string;
  executionPolicy: ExecutionPolicy;
  engine: AgentEngine;
  /** One the engine offers; the engine's default when absent. */
  model?: AgentModel;
  effort?: AgentEffort;
  contextUsage?: ContextUsage;
  messages: ConversationMessage[];
  continuation?: Continuation;
  continuationStatus: ContinuationStatus;
  lastChangeSnapshot: ChangeSnapshot;
  /** Sidebar position. Only the user moves it; run activity never does. */
  sortIndex?: number;
  /** The verdict of the newest settled run, until a dismissal or the next run supersedes it. */
  outcome?: ThreadOutcome;
  /** Set while the user has yet to see that verdict. It marks the thread, the verdict ranks it. */
  outcomeUnread?: true;
  /** What runs on this thread found, newest last. Cleared by a dismissal, never by the next run. */
  findings?: AutomationFinding[];
  /**
   * Keys of findings the user has filed away. A dismissal means the issue is handled, so the same one
   * is held back while the runs keep reporting it, and only surfaces again once a run stops finding it.
   */
  handledIssues?: string[];
  /** When a run on this thread last found something. A dismissal files the findings away, not this. */
  lastFindingAt?: number;
  /** What the last scheduled run to say it found nothing looked at, which is a silent schedule's proof of life. */
  lastChecked?: { at: number; note: string };
  /** When this thread's newest run settled. A turn the run left unfinished ends there. */
  runEndedAt?: number;
  /**
   * The checkout this thread's runs happen in, named by id because other threads may work in the
   * same one. Absent while the thread runs in the project itself.
   */
  worktreeId?: string;
  /**
   * When this thread's session forked into that checkout, set by its own first run there. Threads
   * sharing a checkout fork independently, so a thread that has yet to run in one has no fork.
   */
  worktreeEnteredAt?: number;
  /**
   * Set on a thread copied from another, which inherits that thread's session. Its runs fork that
   * session instead of continuing it until one reports a session of its own, which clears this, so
   * a run that dies before it names a session never leaves the two threads writing to one.
   */
  inheritedContinuation?: true;
  /** Absent on threads written before they were timestamped; {@link threadCreatedAt} fills those in. */
  createdAt?: number;
  updatedAt: number;
  archivedAt?: number;
};

const TITLE_LIMIT = 52;

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

export function threadCreatedAt(thread: Thread): number {
  return thread.createdAt ?? thread.messages[0]?.at ?? thread.updatedAt;
}

/**
 * When the thread last did something. `updatedAt` moves on any write, so it cannot answer this.
 * A tick that surfaced nothing withdrew the messages it wrote and put `runEndedAt` back, so it counts
 * for nothing here: four such schedules must not reshuffle the list two hundred times a day.
 */
export function threadActivityAt(thread: Thread): number {
  return Math.max(threadCreatedAt(thread), lastAudibleAt(thread), thread.runEndedAt ?? 0);
}

function lastAudibleAt(thread: Thread): number {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (!message.withdrawn) return message.at;
  }
  return 0;
}
