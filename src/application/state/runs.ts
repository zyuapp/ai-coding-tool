import type { Annotation, AttachedFile, PastedText } from "../../domain/conversation.js";
import type { AgentEngine, AgentModel } from "../../domain/agent-engine.js";
import type { ActiveGoal } from "../../domain/goal.js";
import { isUsersOwn, type MessageOrigin } from "../../domain/message-origin.js";
import type { ReviewTarget } from "../../domain/review.js";
import type { AgentEffort, BackgroundProcess, ExecutionPolicy, Subagent } from "../../domain/run.js";
import type { ThreadRole } from "../../domain/thread-role.js";
import type { HeldMessage } from "../../domain/usage-limit.js";
import type { Workflow } from "../../domain/workflow.js";
import type { CoordinationSend } from "../coordination-messages.js";
import type { QuietSession } from "../outstanding-stops.js";
import type { ActiveRun, ApprovalView, StreamingTail, ThreadRunStatus } from "../thread-run-state.js";

/**
 * A run the user or the scheduler asked for that is still resolving its workspace. It lives in state
 * rather than in a closure so the reducer can re-check the thread when resolution lands.
 */
export type PendingRun = Pick<HeldMessage, "usersOwn"> & {
  id: string;
  runId: string;
  origin: "composer" | "automation";
  /** `resume` picks a thread back up, with no message of the user's, after its usage limit lifts or an update restarts the app. */
  operation?: { type: "compact" } | { type: "review"; target: ReviewTarget } | { type: "resume"; after: "limit" | "update" | "memory" };
  taskId?: string;
  projectId?: string;
  /** The checkout the run was told to happen in, for a thread that does not exist yet to claim. */
  worktreeId?: string;
  /** Agent choices carried atomically by a new thread request instead of changing the shared draft. `engine` is set with `model`. */
  model?: AgentModel;
  engine?: AgentEngine;
  effort?: AgentEffort;
  role?: ThreadRole;
  coordination?: CoordinationSend;
  /** Composer only: which draft to clear once the run starts, and its text as sent. */
  draftKey?: string;
  draftText?: string;
  /** What the user typed, before attachments are appended. Titles a brand new thread that `title` does not name. */
  text: string;
  title?: string;
  prompt: string;
  attachments: string[];
  annotations?: Annotation[];
  pastes?: PastedText[];
  files?: AttachedFile[];
  /** Who the message the run starts with comes from, when not the user. */
  messageOrigin?: MessageOrigin;
  /** The decision the message answers, so it opens again if the run never starts. */
  answers?: string;
  policy?: ExecutionPolicy;
  automationId?: string;
  /** Automation only: this tick may settle without surfacing if it earns the silence. */
  quiet?: true;
  /** Automation only: a cron tick has nobody to answer its approvals, so the run may answer its own. */
  unattended?: true;
  /** Queued messages this run is draining, cleared only once the run actually starts. */
  queuedIds?: string[];
  /** Set when the checkout this run needs is being made on the way, which is the slow part of resolving. */
  creatingWorktree?: boolean;
  /** Resumes a thread after its usage limit lifted; the next in line waits until this one has answered once. */
  warming?: true;
};

/**
 * Something the user typed while a run was going. It waits for the run to finish, unless it is
 * steered into that run first.
 */
export type QueuedMessage = HeldMessage & {
  /** Locks the message while steering is in flight; a rejection restores its controls. */
  steering?: boolean;
};

/** What each thread's live run reports. Runs and their outcomes are keyed by thread, so threads progress independently. */
export type RunFeedsState = {
  activeRuns: Record<string, ActiveRun>;
  runStatuses: Record<string, ThreadRunStatus>;
  approvals: Record<string, ApprovalView>;
  streamingTails: Record<string, StreamingTail>;
  /**
   * What each thread's session has running in the background. The agent process (re)starts with none and
   * says so, so this is never persisted, and it outlives the run that started the work.
   */
  backgroundProcesses: Record<string, BackgroundProcess[]>;
  /** What each thread has driven as a dynamic workflow. A workflow left running outlives the run that started it. */
  workflows: Record<string, Workflow[]>;
  /**
   * The helper agents each thread has delegated to. A live feed rather than thread content, so a report
   * arriving every few milliseconds never rewrites the thread it belongs to.
   */
  subagents: Record<string, Subagent[]>;
  /** Each thread's native goal, as its session reports it. Goals live only as long as this app session. */
  goals: Record<string, ActiveGoal>;
};

/** Runs on their way, the messages waiting for them, and what each live one reports. */
export type RunsState = RunFeedsState & {
  /**
   * Runs resolving their checkout, the coordinators' suggestions they start, and the runs and threads'
   * session work a Stop all caught, whose ending their coordinator hears without being woken.
   * Session-only, so a restart leaves none starting.
   */
  pendingRuns: Record<string, PendingRun>; startingProposals: string[]; quietStops: string[]; quietSessions: QuietSession[];
  queuedMessages: Record<string, QueuedMessage[]>;
  /** Latest run per thread, so a reply from a superseded run can be dropped. */
  lastRunIds: Record<string, string>;
};

export function initialRunsState(): RunsState {
  return {
    activeRuns: {},
    runStatuses: {},
    approvals: {},
    streamingTails: {},
    backgroundProcesses: {},
    workflows: {},
    subagents: {},
    goals: {},
    pendingRuns: {}, startingProposals: [], quietStops: [], quietSessions: [],
    queuedMessages: {},
    lastRunIds: {},
  };
}

/** A workflow by id, wherever it is kept: a dock follows one workflow, not one thread's list. */
export function workflowById(state: Pick<RunFeedsState, "workflows">, id: string | null): Workflow | undefined {
  if (!id) return undefined;
  for (const workflows of Object.values(state.workflows)) {
    const found = workflows.find((workflow) => workflow.id === id);
    if (found) return found;
  }
  return undefined;
}

export const QUEUED_NOT_YOURS = "Only a message you wrote can be edited.";
export const QUEUED_SENT = "That message has already been sent.";

/**
 * The queued message the user may take back into the composer to rewrite, or why not: a steered one
 * is already on its way to the agent, and only the user's own messages are theirs to rewrite.
 */
export function editableQueued(queued: readonly QueuedMessage[], messageId: string): { message: QueuedMessage } | { refusal: string } {
  const message = queued.find((item) => item.id === messageId);
  if (!message || message.steering) return { refusal: QUEUED_SENT };
  return isUsersOwn(message) ? { message } : { refusal: QUEUED_NOT_YOURS };
}

/** Whether a queued message is already on its way into a run that is starting, which takes it out of the queue once it does. */
export function drainingQueued(state: Pick<RunsState, "pendingRuns">, taskId: string, messageId: string): boolean {
  return Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId && pending.queuedIds?.includes(messageId));
}

/** A queued message as a composer shows it: `starting` once a run is taking it, past editing or dropping. */
export type QueuedMessageView = QueuedMessage & { starting?: true };

/** A thread's queue as shown: the stored list itself unless a starting run is taking from it. */
export function queuedView(state: Pick<RunsState, "pendingRuns" | "queuedMessages">, taskId: string): QueuedMessageView[] | undefined {
  const queued = state.queuedMessages[taskId];
  if (!queued?.some((message) => drainingQueued(state, taskId, message.id))) return queued;
  return queued.map((message) => drainingQueued(state, taskId, message.id) ? { ...message, starting: true as const } : message);
}
