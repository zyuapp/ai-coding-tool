/**
 * Where each of one computer's threads stands: working, blocked on the user, paused at a usage limit,
 * or idle, and the lists its threads are drawn from. This computer's state and every paired
 * computer's state are read through the same functions, each answer derived once per state.
 */
import { withWatchedThreads } from "../domain/automation.js";
import type { Thread } from "../domain/thread.js";
import { resumesOnItsOwn } from "../domain/usage-limit.js";
import { unreadView } from "./thread-attention.js";
import { leavingThreadIds } from "./thread-location.js";
import { sideChatIds, type WorkspaceState } from "./workspace-state.js";

/** What a thread is waiting on before it can work: a checkout being made or removed, or a run finding one. */
export type ThreadWait = "worktree" | "worktree-release" | "run";

/** One thread's state, most urgent first: a thread waiting on the user's approval is also working. */
export type ThreadStatus = "blocked" | "paused" | "working" | "idle";

export type ThreadActivity = {
  /**
   * Threads with work going or about to go without the user: a run, a send resolving or queued, a
   * checkout being made or removed under it, a workflow or subagent still working, and a usage-limit
   * pause that lifts on its own. A weekly pause waits for the user, so it is paused but not working.
   */
  working: Set<string>;
  /** Threads stopped on a question only the user can answer. */
  blocked: Set<string>;
  /** Threads waiting out a usage limit, which a row shows in place of working. */
  paused: Set<string>;
  /** What the activity list ranks under Running: the working threads, and those a live watch holds between its ticks. */
  ranked: Set<string>;
};

export type ThreadLists = {
  /** Every thread with a row of its own, so not a side chat. */
  listedThreads: Thread[];
  /** The listed threads not filed away. */
  visibleThreads: Thread[];
  /** Filed away, most recent first. */
  archivedThreads: Thread[];
  worktreeThreadIds: Set<string>;
  /** Threads holding a side chat with an unseen mark. */
  sideChatAttention: Set<string>;
  /** Visible threads carrying an unseen mark, their side chats' included. */
  unreadCount: number;
};

const activities = new WeakMap<WorkspaceState, ThreadActivity>();

/**
 * The one answer the sidebar, thread tools, scheduler, and coordinators all read, derived once per
 * state. Anything the thread will carry on with unattended is working; a pause shows in place of it.
 */
export function threadActivity(state: WorkspaceState): ThreadActivity {
  let activity = activities.get(state);
  if (!activity) {
    activity = deriveActivity(state);
    activities.set(state, activity);
  }
  return activity;
}

function deriveActivity(state: WorkspaceState): ThreadActivity {
  const working = new Set(Object.keys(state.activeRuns));
  const blocked = new Set<string>();
  for (const run of Object.values(state.activeRuns)) if (run.status === "awaiting-approval") blocked.add(run.taskId);
  for (const pending of Object.values(state.pendingRuns)) if (pending.taskId) working.add(pending.taskId);
  for (const taskId of state.creatingWorktrees) working.add(taskId);
  /** A checkout on its way out is ground about to move, so every thread standing on it waits. */
  for (const taskId of leavingThreadIds(state)) working.add(taskId);
  /** A workflow outlives the run that started it. Background shells and monitors only keep a session alive. */
  for (const [taskId, workflows] of Object.entries(state.workflows)) if (workflows.some((workflow) => workflow.status === "running")) working.add(taskId);
  for (const [taskId, subagents] of Object.entries(state.subagents)) if (subagents.some((subagent) => subagent.status === "working")) working.add(taskId);
  const paused = new Set<string>();
  for (const thread of state.threads) {
    if (!thread.limitPause) continue;
    paused.add(thread.id);
    if (resumesOnItsOwn(thread.limitPause)) working.add(thread.id);
  }
  /** A paused thread's queue is what it holds for the user's return, not work of its own. */
  for (const [taskId, queued] of Object.entries(state.queuedMessages)) if (queued.length && !paused.has(taskId)) working.add(taskId);
  return { working, blocked, paused, ranked: withWatchedThreads(working, state.automations) };
}

export function isWorking(state: WorkspaceState, taskId: string): boolean {
  return threadActivity(state).working.has(taskId);
}

export function threadStatus(state: WorkspaceState, taskId: string): ThreadStatus {
  const { blocked, paused, working } = threadActivity(state);
  return blocked.has(taskId) ? "blocked" : paused.has(taskId) ? "paused" : working.has(taskId) ? "working" : "idle";
}

/** What a thread, or the draft typing under `draftKey`, is waiting on before its run can go. */
export function waitingOn(state: WorkspaceState, taskId: string | undefined, draftKey: string): ThreadWait | null {
  if (taskId && state.creatingWorktrees.includes(taskId)) return "worktree";
  if (taskId && leavingThreadIds(state).has(taskId)) return "worktree-release";
  const resolving = Object.values(state.pendingRuns).find((pending) => (taskId !== undefined && pending.taskId === taskId) || pending.draftKey === draftKey);
  if (!resolving) return null;
  return resolving.creatingWorktree ? "worktree" : "run";
}

/** Lists read only threads and side chats, so a state that keeps both keeps its lists too. */
const lists = new WeakMap<Thread[], { sideChats: WorkspaceState["sideChats"]; lists: ThreadLists }>();

export function threadLists(state: Pick<WorkspaceState, "threads" | "sideChats">): ThreadLists {
  const held = lists.get(state.threads);
  if (held?.sideChats === state.sideChats) return held.lists;
  const derived = deriveLists(state);
  lists.set(state.threads, { sideChats: state.sideChats, lists: derived });
  return derived;
}

function deriveLists(state: Pick<WorkspaceState, "threads" | "sideChats">): ThreadLists {
  const forked = sideChatIds(state);
  const listedThreads = state.sideChats.length ? state.threads.filter((thread) => !forked.has(thread.id)) : state.threads;
  const visibleThreads: Thread[] = [];
  const archivedThreads: Thread[] = [];
  const worktreeThreadIds = new Set<string>();
  for (const thread of listedThreads) {
    if (thread.archivedAt === undefined) visibleThreads.push(thread);
    else archivedThreads.push(thread);
    if (thread.worktreeId) worktreeThreadIds.add(thread.id);
  }
  archivedThreads.sort((left, right) => right.archivedAt! - left.archivedAt!);
  return { listedThreads, visibleThreads, archivedThreads, worktreeThreadIds, ...unreadView(state, visibleThreads) };
}
