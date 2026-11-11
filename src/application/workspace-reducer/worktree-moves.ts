import type { TaskCommand } from "../../contracts/commands.js";
import { createConversationMessage, createFailureMessage } from "../../domain/conversation.js";
import { originFields } from "../../domain/message-origin.js";
import type { RunStatus } from "../../domain/run.js";
import type { Thread } from "../../domain/thread.js";
import { worktreeName, type Worktree, type WorktreeDestination } from "../../domain/worktree.js";
import { leavingThreadIds, projectFor, threadWorkspaceId, threadWorkspaceRoot, worktreeById } from "../thread-location.js";
import { isWorking } from "../thread-activity.js";
import type { QueuedMessage, WorkspaceState } from "../workspace-state.js";
import { diffReread } from "./diff-reads.js";
import { drained, queuedFor } from "./run-queue.js";
import { queuedIn, runsOf } from "./run-edits.js";
import { coordinatorAskRefusal, WORKTREE_CREATING_ERROR, WORKTREE_MISSING_ERROR, WORKTREE_PROJECT_ERROR, WORKTREE_RELEASING_ERROR, WORKTREE_RUNNING_ERROR } from "./errors.js";
import { now, targetId } from "./shared.js";
import { afterward, andThen, inTurn, type Step } from "./slice.js";
import { relocatedIn, saidIn, threadsOf } from "./thread-edits.js";
import { creatingWorktree, moveAfterRunIn, worktreesOf } from "./worktree-claims.js";

/**
 * A location change preserves the transcript and forks its continuation on the next run. The menu
 * closes when the thread moved is the one on screen and the user asked for the move.
 */
export function relocated(state: WorkspaceState, thread: Thread, destination: Worktree | undefined, asked: boolean): Step {
  const label = destination ? worktreeName(destination) : "Local";
  const note = createConversationMessage("system", `Moved to ${label}. Existing file changes stay in the previous checkout.`, destination?.root ?? projectFor(state, thread)?.root);
  const moving: Step = { edits: [relocatedIn(threadsOf(state), thread.id, destination?.id, note, now)], ...(asked && state.currentId === thread.id ? { closesMenu: true as const } : {}) };
  return andThen(state, moving, (next) => {
    const reread = diffReread(next, thread.id);
    const workspaceId = threadWorkspaceId(next, next.threads.find((item) => item.id === thread.id));
    return workspaceId ? { ...reread, effects: [...reread.effects ?? [], { type: "refresh-environment", workspaceId, taskId: thread.id, followUp: true }] } : reread;
  });
}

/** The checkout a move lands in: undefined for the project's own, null when the thread is already there, or why it cannot go. */
function arrival(state: WorkspaceState, thread: Thread, projectId: string, destination: Exclude<WorktreeDestination, { kind: "new" }>): Worktree | undefined | null | string {
  if (destination.kind === "local") return thread.worktreeId ? undefined : null;
  const worktree = worktreeById(state, destination.id);
  if (!worktree) return WORKTREE_MISSING_ERROR;
  if (worktree.projectId !== projectId) return "Choose a worktree in this thread's project.";
  if (worktree.id === thread.worktreeId) return null;
  if (state.deletingWorktrees.includes(worktree.root) || state.threads.some((item) => item.worktreeId === worktree.id && state.releasingWorktrees.includes(item.id))) {
    return WORKTREE_RELEASING_ERROR;
  }
  if (state.managedWorktrees !== null) {
    const managed = state.managedWorktrees.find((item) => item.root === worktree.root);
    if (!managed?.repository) return WORKTREE_MISSING_ERROR;
  }
  return worktree;
}

/** A checkout made from where the thread stands; the thread moves in once it lands, as `worktree.created` says. */
function toNewWorktree(state: WorkspaceState, thread: Thread, projectId: string, then?: string): Step {
  return { ...creatingWorktree(state, thread.id), effects: [{ type: "create-worktree", taskId: thread.id, projectRoot: threadWorkspaceRoot(state, thread)!, move: true, name: thread.title, projectId, ...(then ? { then } : {}) }] };
}

/** What a thread that moved itself said it goes on with, first in line in the checkout it moved to. */
export function followUpQueued(state: WorkspaceState, taskId: string, then: string | undefined): Step {
  const thread = state.threads.find((item) => item.id === taskId);
  if (!then || !thread) return {};
  const followUp: QueuedMessage = {
    id: crypto.randomUUID(),
    text: then,
    prompt: `You moved to this checkout, as you asked. Go on with what you said you would do next:\n\n${then}`,
    attachments: [],
    ...originFields({ kind: "thread", threadId: thread.id, title: thread.title }),
  };
  return { edits: [queuedIn(runsOf(state), taskId, [followUp, ...queuedFor(state, taskId)])] };
}

/** A move its thread asked to make once its run ends, taken back. */
function moveAfterRunDropped(state: WorkspaceState, taskId: string): Step {
  return state.movesAfterRun[taskId] ? { edits: [moveAfterRunIn(worktreesOf(state), taskId, null)] } : {};
}

export function worktreeMoved(state: WorkspaceState, input: Extract<TaskCommand, { type: "task.move-worktree" }>): Step {
  const taskId = targetId(state, input.taskId);
  const thread = state.threads.find((item) => item.id === taskId);
  const project = projectFor(state, thread);
  if (!thread || !project?.workspaceId) return { refusal: WORKTREE_PROJECT_ERROR };
  if (state.creatingWorktrees.includes(thread.id)) return { refusal: WORKTREE_CREATING_ERROR };
  if (leavingThreadIds(state).has(thread.id)) return { refusal: WORKTREE_RELEASING_ERROR };
  const destination = input.destination;
  /** A thread asked: this one moving itself, or one on another computer that the link names. */
  const refusal = (input.afterRun || input.sender) && coordinatorAskRefusal(thread, input, false);
  if (refusal) return { refusal };
  const target = destination.kind === "new" ? undefined : arrival(state, thread, project.id, destination);
  if (typeof target === "string") return { refusal: target };
  /** Asking for where the thread already is takes back a move it was waiting to make. */
  if (target === null) return moveAfterRunDropped(state, thread.id);
  if (isWorking(state, thread.id)) {
    /** Only the run that asked can end before the move; anything else keeping the thread busy refuses it. */
    if (!input.afterRun || !state.activeRuns[thread.id]) return { refusal: WORKTREE_RUNNING_ERROR };
    return { clearsError: true, edits: [moveAfterRunIn(worktreesOf(state), thread.id, { destination, ...(input.then ? { then: input.then } : {}) })] };
  }
  const staying = moveAfterRunDropped(state, thread.id);
  if (destination.kind === "new") return andThen(state, staying, (next) => toNewWorktree(next, thread, project.id, input.then));
  const moving = andThen(state, { ...staying, clearsError: true }, (next) => relocated(next, thread, target, true));
  if (!input.then) return moving;
  return inTurn(state, moving, [(next) => followUpQueued(next, thread.id, input.then), (next) => drained(next, thread.id, "deliver")]);
}

/**
 * A thread that moved itself goes once the run that asked has ended, ahead of anything queued behind
 * that run. Whatever changed meanwhile is checked again, and a move that can no longer happen says so,
 * dropping what the thread said it would go on with there. A run the user stopped still moves, and
 * goes no further. Nothing on screen asked for this move, so whatever the user has open stays open.
 */
export function moveAfterRunSettled(state: WorkspaceState, taskId: string, status: RunStatus): Step {
  const move = state.movesAfterRun[taskId];
  if (!move) return {};
  const { destination } = move;
  const then = status === "cancelled" ? undefined : move.then;
  const dropping = moveAfterRunDropped(state, taskId);
  const rest = afterward(state, dropping);
  const thread = rest.threads.find((item) => item.id === taskId);
  const project = projectFor(rest, thread);
  if (!thread || thread.archivedAt !== undefined) return dropping;
  const refusal = coordinatorAskRefusal(thread, { type: "task.move-worktree", destination }, false);
  const target = !project?.workspaceId ? WORKTREE_PROJECT_ERROR
    : refusal ? refusal
    : leavingThreadIds(rest).has(taskId) ? WORKTREE_RELEASING_ERROR
    : destination.kind === "new" ? undefined
    : arrival(rest, thread, project.id, destination);
  if (target === null) return andThen(state, dropping, (next) => followUpQueued(next, taskId, then));
  if (typeof target === "string") {
    const note = createFailureMessage(`Did not move. ${target}`);
    return andThen(state, dropping, (next) => ({ edits: [saidIn(threadsOf(next), taskId, note, now())] }));
  }
  if (destination.kind === "new") return andThen(state, dropping, (next) => toNewWorktree(next, thread, project!.id, then));
  return inTurn(state, dropping, [(next) => relocated(next, thread, target, false), (next) => followUpQueued(next, taskId, then)]);
}
