import type { TaskCommand } from "../../contracts/commands.js";
import { createConversationMessage } from "../../domain/conversation.js";
import type { Thread } from "../../domain/thread.js";
import { worktreeName, type Worktree } from "../../domain/worktree.js";
import { leavingThreadIds, projectFor, threadWorkspaceId, threadWorkspaceRoot, worktreeById } from "../thread-location.js";
import { updateThread } from "../thread-run-state.js";
import type { WorkspaceState } from "../workspace-state.js";
import { now, rereadDiff, settled, targetId, threadBusy, withCreatingWorktree, WORKTREE_CREATING_ERROR, WORKTREE_MISSING_ERROR, WORKTREE_PROJECT_ERROR, WORKTREE_RELEASING_ERROR, WORKTREE_RUNNING_ERROR, rejected } from "./shared.js";
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
  if (workspaceId) result.effects.push({ type: "refresh-environment", workspaceId, taskId: thread.id });
  return result;
}

export function reduceWorktreeMove(state: WorkspaceState, input: Extract<TaskCommand, { type: "task.move-worktree" }>): WorkspaceTransition {
  const taskId = targetId(state, input.taskId);
  const thread = state.threads.find((item) => item.id === taskId);
  const project = projectFor(state, thread);
  if (!thread || !project?.workspaceId) return rejected(state, WORKTREE_PROJECT_ERROR);
  if (state.creatingWorktrees.includes(thread.id)) return rejected(state, WORKTREE_CREATING_ERROR);
  if (leavingThreadIds(state).has(thread.id)) return rejected(state, WORKTREE_RELEASING_ERROR);
  if (threadBusy(state, thread.id)) return rejected(state, WORKTREE_RUNNING_ERROR);
  const destination = input.destination;
  if (destination.kind === "new") {
    return settled(withCreatingWorktree(state, thread.id), [{ type: "create-worktree", taskId: thread.id, projectRoot: threadWorkspaceRoot(state, thread)!, move: true, name: thread.title, projectId: project.id }]);
  }
  if (destination.kind === "local") {
    if (!thread.worktreeId) return settled(state);
    return relocateThread({ ...state, actionError: null }, thread, undefined);
  }
  const worktree = worktreeById(state, destination.id);
  if (!worktree) return rejected(state, WORKTREE_MISSING_ERROR);
  if (worktree.projectId !== project.id) return rejected(state, "Choose a worktree in this thread's project.");
  if (worktree.id === thread.worktreeId) return settled(state);
  if (state.deletingWorktrees.includes(worktree.root) || state.threads.some((item) => item.worktreeId === worktree.id && state.releasingWorktrees.includes(item.id))) {
    return rejected(state, WORKTREE_RELEASING_ERROR);
  }
  if (state.managedWorktrees !== null) {
    const managed = state.managedWorktrees.find((item) => item.root === worktree.root);
    if (!managed?.repository) return rejected(state, WORKTREE_MISSING_ERROR);
  }
  return relocateThread({ ...state, actionError: null }, thread, worktree);
}
