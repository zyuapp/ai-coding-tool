import type { TaskCommand } from "../../contracts/commands.js";
import { createConversationMessage, createFailureMessage } from "../../domain/conversation.js";
import { isCoordinator } from "../../domain/coordination.js";
import { originFields } from "../../domain/message-origin.js";
import type { RunStatus } from "../../domain/run.js";
import type { Thread } from "../../domain/thread.js";
import { worktreeName, type Worktree, type WorktreeDestination } from "../../domain/worktree.js";
import { leavingThreadIds, projectFor, threadWorkspaceId, threadWorkspaceRoot, worktreeById } from "../thread-location.js";
import { updateThread } from "../thread-run-state.js";
import { isWorking } from "../thread-activity.js";
import type { QueuedMessage, WorkspaceState } from "../workspace-state.js";
import { rereadDiff } from "./diff-reads.js";
import { drainQueue, queuedFor, withQueued } from "./run-queue.js";
import { WORKTREE_COORDINATOR_ERROR, WORKTREE_CREATING_ERROR, WORKTREE_MISSING_ERROR, WORKTREE_PROJECT_ERROR, WORKTREE_RELEASING_ERROR, WORKTREE_RUNNING_ERROR } from "./errors.js";
import { now, settled, targetId, rejected } from "./shared.js";
import { withCreatingWorktree } from "./worktree-claims.js";
import type { WorkspaceTransition } from "./types.js";

/** A location change preserves the transcript and forks its continuation on the next run. */
export function relocateThread(state: WorkspaceState, thread: Thread, destination: Worktree | undefined): WorkspaceTransition {
  const label = destination ? worktreeName(destination) : "Local";
  const note = createConversationMessage("system", `Moved to ${label}. Existing file changes stay in the previous checkout.`, destination?.root ?? projectFor(state, thread)?.root);
  const next = updateThread(state, thread.id, ({ worktreeId: _previous, worktreeEnteredAt: _entered, ...item }) => {
    const moved: Thread = { ...item, messages: [...item.messages, note], lastChangeSnapshot: { files: [], capturedAt: now() }, updatedAt: now() };
    if (destination) moved.worktreeId = destination.id;
    if (item.continuation) moved.inheritedContinuation = true;
    return moved;
  });
  if (next.currentId === thread.id) next.openMenu = null;
  const result = rereadDiff(next, thread.id);
  const workspaceId = threadWorkspaceId(result.state, result.state.threads.find((item) => item.id === thread.id));
  if (workspaceId) result.effects.push({ type: "refresh-environment", workspaceId, taskId: thread.id, followUp: true });
  return result;
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
function moveToNewWorktree(state: WorkspaceState, thread: Thread, projectId: string, then?: string): WorkspaceTransition {
  return settled(withCreatingWorktree(state, thread.id), [{ type: "create-worktree", taskId: thread.id, projectRoot: threadWorkspaceRoot(state, thread)!, move: true, name: thread.title, projectId, ...(then ? { then } : {}) }]);
}

/** What a thread that moved itself said it goes on with, first in line in the checkout it moved to. */
export function withFollowUp(state: WorkspaceState, taskId: string, then: string | undefined): WorkspaceState {
  const thread = state.threads.find((item) => item.id === taskId);
  if (!then || !thread) return state;
  const followUp: QueuedMessage = {
    id: crypto.randomUUID(),
    text: then,
    prompt: `You moved to this checkout, as you asked. Go on with what you said you would do next:\n\n${then}`,
    attachments: [],
    ...originFields({ kind: "thread", threadId: thread.id, title: thread.title }),
  };
  return withQueued(state, taskId, [followUp, ...queuedFor(state, taskId)]);
}

/** A coordinator does no work itself, so no thread moves it into a worktree; the user can still move it from the thread menu. */
function movesCoordinatorAway(thread: Thread, destination: WorktreeDestination) {
  return destination.kind !== "local" && isCoordinator(thread);
}

function withoutMoveAfterRun(state: WorkspaceState, taskId: string): WorkspaceState {
  if (!state.movesAfterRun[taskId]) return state;
  const { [taskId]: _settled, ...movesAfterRun } = state.movesAfterRun;
  return { ...state, movesAfterRun };
}

export function reduceWorktreeMove(state: WorkspaceState, input: Extract<TaskCommand, { type: "task.move-worktree" }>): WorkspaceTransition {
  const taskId = targetId(state, input.taskId);
  const thread = state.threads.find((item) => item.id === taskId);
  const project = projectFor(state, thread);
  if (!thread || !project?.workspaceId) return rejected(state, WORKTREE_PROJECT_ERROR);
  if (state.creatingWorktrees.includes(thread.id)) return rejected(state, WORKTREE_CREATING_ERROR);
  if (leavingThreadIds(state).has(thread.id)) return rejected(state, WORKTREE_RELEASING_ERROR);
  const destination = input.destination;
  /** A thread asked: this one moving itself, or one on another computer that the link names. */
  if ((input.afterRun || input.sender) && movesCoordinatorAway(thread, destination)) return rejected(state, WORKTREE_COORDINATOR_ERROR);
  const target = destination.kind === "new" ? undefined : arrival(state, thread, project.id, destination);
  if (typeof target === "string") return rejected(state, target);
  /** Asking for where the thread already is takes back a move it was waiting to make. */
  if (target === null) return settled(withoutMoveAfterRun(state, thread.id));
  if (isWorking(state, thread.id)) {
    /** Only the run that asked can end before the move; anything else keeping the thread busy refuses it. */
    if (!input.afterRun || !state.activeRuns[thread.id]) return rejected(state, WORKTREE_RUNNING_ERROR);
    return settled({ ...state, actionError: null, movesAfterRun: { ...state.movesAfterRun, [thread.id]: { destination, ...(input.then ? { then: input.then } : {}) } } });
  }
  const staying = withoutMoveAfterRun(state, thread.id);
  if (destination.kind === "new") return moveToNewWorktree(staying, thread, project.id, input.then);
  const moved = relocateThread({ ...staying, actionError: null }, thread, target);
  if (!input.then) return moved;
  const drained = drainQueue(withFollowUp(moved.state, thread.id, input.then), thread.id, "succeeded");
  return { state: drained.state, effects: [...moved.effects, ...drained.effects] };
}

/**
 * A thread that moved itself goes once the run that asked has ended, ahead of anything queued behind
 * that run. Whatever changed meanwhile is checked again, and a move that can no longer happen says so,
 * dropping what the thread said it would go on with there. A run the user stopped still moves, and
 * goes no further.
 */
export function settleMoveAfterRun(state: WorkspaceState, taskId: string, status: RunStatus): WorkspaceTransition {
  const move = state.movesAfterRun[taskId];
  if (!move) return settled(state);
  const { destination } = move;
  const then = status === "cancelled" ? undefined : move.then;
  const rest = withoutMoveAfterRun(state, taskId);
  const thread = rest.threads.find((item) => item.id === taskId);
  const project = projectFor(rest, thread);
  if (!thread || thread.archivedAt !== undefined) return settled(rest);
  const target = !project?.workspaceId ? WORKTREE_PROJECT_ERROR
    : movesCoordinatorAway(thread, destination) ? WORKTREE_COORDINATOR_ERROR
    : leavingThreadIds(rest).has(taskId) ? WORKTREE_RELEASING_ERROR
    : destination.kind === "new" ? undefined
    : arrival(rest, thread, project.id, destination);
  if (target === null) return settled(withFollowUp(rest, taskId, then));
  if (typeof target === "string") {
    const note = createFailureMessage(`Did not move. ${target}`);
    return settled(updateThread(rest, taskId, (item) => ({ ...item, messages: [...item.messages, note], updatedAt: now() })));
  }
  if (destination.kind === "new") return moveToNewWorktree(rest, thread, project!.id, then);
  const moved = relocateThread(rest, thread, target);
  /** Nothing on screen asked for this move, so whatever the user has open stays open. */
  return { ...moved, state: { ...withFollowUp(moved.state, taskId, then), openMenu: rest.openMenu } };
}
