import type { AgentEngine, AgentModel } from "./agent-engine.js";
import type { ConversationMessage } from "./conversation.js";
import type { AutomationFinding } from "./finding.js";
import type { AgentEffort, Continuation, ExecutionPolicy } from "./run.js";
import type { CoordinationNote, CoordinationReport, CoordinatorMemory, Decision, HeldLead, ThreadBrief, ThreadModelChoice, ThreadProposal } from "./coordination.js";
import type { ThreadRole } from "./thread-role.js";
import type { ChangeSnapshot, ContextUsage, ContinuationStatus, ThreadOutcome, ThreadUsage } from "./thread-run.js";
import type { LimitPause } from "./usage-limit.js";
import type { PullRequestLink } from "./pull-request.js";

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

/** The canonical conversation aggregate. Persisted property names stay unchanged for compatibility. */
export type Thread = {
  id: string;
  title: string;
  /** Set once the user names the thread themselves, so a suggested title never replaces it. */
  titleByUser?: boolean;
  /** The part this thread plays beside the others, when the user has given it one. */
  role?: ThreadRole;
  /** The coordinator this thread works under. It only counts while that thread is a live coordinator. */
  parentId?: string;
  /**
   * The coordinator on a paired computer this thread works under, as that computer named it when it
   * started the thread here, with the suggestion it is when the user allowed it there. A coordinator
   * of its own here outranks it.
   */
  remoteLead?: HeldLead;
  /** What the coordinator asked of this thread when it started it. */
  brief?: ThreadBrief;
  /** Where this thread last said its work stands. */
  report?: CoordinationReport;
  /**
   * Under a coordinator: when its work was settled, by the user or by its own pull request merging,
   * which files it away under Resolved until a message starts it again.
   */
  resolvedAt?: number;
  /** Choices this thread has put to the user, answered or not. */
  decisions?: Decision[];
  /** On a coordinator: what its threads have done that it has yet to be told. */
  coordinationNotes?: CoordinationNote[];
  /** On a coordinator: what the threads it starts run on unless it names another. */
  threadModel?: ThreadModelChoice;
  /** On a coordinator: its purpose and the notes it keeps, which it and every thread it starts read. */
  memory?: CoordinatorMemory;
  /** On a coordinator: threads it suggested that wait for the user to start or dismiss them. */
  proposals?: ThreadProposal[];
  /** On a coordinator: set while the user wants no desktop notice from it or its threads. */
  muted?: true;
  /**
   * On a coordinator: for each of its threads on a paired computer, the newest moment on that
   * computer's clock whose news it has taken, so news from while the link was down is caught up.
   */
  remoteHeard?: Record<string, number>;
  /**
   * On a coordinator: each of its threads that a paired computer last said was working, with that
   * computer's id and the thread's title, so a computer silent since this app started is not taken
   * for their work ending, and the coordinator can still name them.
   */
  remoteWorking?: Record<string, HeardWork>;
  /**
   * On a coordinator: each of its threads on a paired computer whose work Stop all stopped there, until
   * it hears that turn end, which it hears quietly, after a restart here too, unless the turn finished
   * or failed on its own, and the turn the agent opens there to answer stopped session work, however it
   * ends. A thread that carries on with a run of its own first, or is no longer under it, is no longer
   * the stop's.
   */
  remoteStops?: Record<string, RemoteStop>;
  /**
   * On a coordinator: each start of a thread on a paired computer, by the suggestion it is, that Stop
   * all caught on its way there, after a restart here too. Whenever it lands it is stopped there, even
   * once the coordinator is filed away or its role taken off, and its turn ending is heard quietly. One
   * that computer refused, or that is no longer under it, is let go.
   */
  caughtStarts?: Record<string, CaughtStart>;
  projectId?: string;
  executionPolicy: ExecutionPolicy;
  engine: AgentEngine;
  /** One the engine offers; the engine's default when absent. */
  model?: AgentModel;
  effort?: AgentEffort;
  /** Codex only. Absent means standard speed. */
  fastMode?: boolean;
  contextUsage?: ContextUsage;
  /** What this thread's runs have spent, which unlike its context only ever grows. */
  usage?: ThreadUsage;
  messages: ConversationMessage[];
  /** Present while the persisted conversation has yet to be loaded. */
  historySummary?: {
    messageCount: number;
    attachmentCount: number;
    firstMessageAt?: number;
    lastAudibleAt?: number;
  };
  continuation?: Continuation;
  continuationStatus: ContinuationStatus;
  lastChangeSnapshot: ChangeSnapshot;
  /** Sidebar position. Only the user moves it; run activity never does. */
  sortIndex?: number;
  /** The verdict of the newest settled run, until a dismissal or the next run supersedes it. */
  outcome?: ThreadOutcome;
  /** Set while the user has yet to see that verdict. It marks the thread, the verdict ranks it. */
  outcomeUnread?: true;
  /** Temporarily files this thread under Threads, preserving everything that needs attention. */
  snoozedUntil?: number;
  /** Set while the thread waits out its account's usage limit. */
  limitPause?: LimitPause;
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
   * How that run ended, until the next one begins. Its verdict says the same until the user files it
   * away; this stays, since filing a thread away changes nothing it did.
   */
  runEndedAs?: ThreadOutcome;
  /**
   * Set while a run is going on this thread. No run outlives the app, so a thread saved with it was
   * cut off when the app quit, and is restored as having been stopped there.
   */
  runOpen?: true;
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
  /** The pull request this thread's work was last seen on. */
  pullRequest?: PullRequestLink;
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

export function threadCreatedAt(thread: Thread): number {
  return thread.createdAt ?? thread.historySummary?.firstMessageAt ?? thread.messages[0]?.at ?? thread.updatedAt;
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
