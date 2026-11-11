/** A thread's claim on a checkout: while one is being made, while it is let go, and once it is gone. */
import { withoutEnvironment } from "./environment.js";
import { now } from "./shared.js";
import type { WorkspaceEffect } from "./types.js";
import { afterward, type Step } from "./slice.js";
import type { WorktreesState } from "../state/worktrees.js";
import { updateThread } from "../thread-run-state.js";
import { worktreeClaimants, worktreeFor } from "../thread-location.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { createConversationMessage } from "../../domain/conversation.js";
import type { Thread } from "../../domain/thread.js";
import type { Worktree } from "../../domain/worktree.js";

/** The checkouts as one input leaves them. Only the functions here make one, so another feature changes them through these. */
class WorktreesChange {
  private declare readonly owned: never;
  constructor(readonly view: WorktreesState) {}
}

export type WorktreesEdit = WorktreesChange;

export function worktreesOf(state: WorktreesState): WorktreesEdit {
  const {
    worktrees, managedWorktrees, worktreeSettings, worktreeMenuSearch, worktreeManagementLoading, worktreeManagementError,
    worktreeManagementNotice, creatingWorktrees, releasingWorktrees, deletingWorktrees, movesAfterRun, worktreeMove,
  } = state;
  return new WorktreesChange({
    worktrees, managedWorktrees, worktreeSettings, worktreeMenuSearch, worktreeManagementLoading, worktreeManagementError,
    worktreeManagementNotice, creatingWorktrees, releasingWorktrees, deletingWorktrees, movesAfterRun, worktreeMove,
  });
}

/**
 * A checkout takes minutes to make, and until it lands the thread is neither where it was nor where
 * it is going. Marking it here is what keeps a second ask from making a second, orphaned checkout.
 */
export function withCreatingWorktree(state: WorkspaceState, taskId: string): WorkspaceState {
  return afterward(state, creatingWorktree(state, taskId));
}

/** {@link withCreatingWorktree}, as the edits it makes. */
export function creatingWorktree(state: WorkspaceState, taskId: string): Step {
  const { view } = worktreesOf(state);
  return { edits: [new WorktreesChange({ ...view, creatingWorktrees: [...view.creatingWorktrees, taskId] })], clearsError: true };
}

export function withoutCreatingWorktree(state: WorkspaceState, taskId: string): WorkspaceState {
  return afterward(state, { edits: [createdIn(worktreesOf(state), taskId)] });
}

/** A thread whose checkout is no longer being made, whether it landed or not. */
export function createdIn(edit: WorktreesEdit, taskId: string): WorktreesEdit {
  if (!edit.view.creatingWorktrees.includes(taskId)) return edit;
  return new WorktreesChange({ ...edit.view, creatingWorktrees: edit.view.creatingWorktrees.filter((item) => item !== taskId) });
}

/**
 * Snapshotting a checkout and taking the directory away is as slow as making one, and the thread is
 * still standing in it meanwhile. Marking it here is what says so and what refuses a second ask.
 */
export function withReleasingWorktree(state: WorkspaceState, taskIds: string[]): WorkspaceState {
  const added = taskIds.filter((taskId) => !state.releasingWorktrees.includes(taskId));
  if (!added.length) return state;
  return { ...state, releasingWorktrees: [...state.releasingWorktrees, ...added] };
}

export function withoutReleasingWorktree(state: WorkspaceState, taskIds: string[]): WorkspaceState {
  const going = new Set(taskIds);
  if (!state.releasingWorktrees.some((taskId) => going.has(taskId))) return state;
  return { ...state, releasingWorktrees: state.releasingWorktrees.filter((taskId) => !going.has(taskId)) };
}

/**
 * One thread walks out of a checkout the others keep. It is local again and says so in its own
 * timeline; the directory and every other claim on it are untouched.
 */
export function leaveWorktree(state: WorkspaceState, taskId: string, note: ReturnType<typeof createConversationMessage>): WorkspaceState {
  return updateThread(state, taskId, ({ worktreeId: _left, worktreeEnteredAt: _forked, ...thread }) => ({
    ...thread,
    messages: [...thread.messages, note],
    updatedAt: now(),
  }));
}

/**
 * The checkout itself is gone, so every thread that claimed it is local again and hears why, and a
 * draft pointed at it goes back to the project. The record goes with the directory: nothing is left
 * pointing at a folder that is not there.
 */
export function dropWorktree(state: WorkspaceState, worktreeId: string, note: () => ReturnType<typeof createConversationMessage>): WorkspaceState {
  const gone = state.worktrees.find((worktree) => worktree.id === worktreeId);
  const claimants = new Set(worktreeClaimants(state, worktreeId).map((thread) => thread.id));
  return {
    ...state,
    releasingWorktrees: state.releasingWorktrees.filter((taskId) => !claimants.has(taskId)),
    worktrees: state.worktrees.filter((worktree) => worktree.id !== worktreeId),
    ...(gone ? { environments: withoutEnvironment(state.environments, gone.workspaceId) } : {}),
    ...(state.draftWorktreeId === worktreeId ? { draftWorktreeId: null } : {}),
    threads: state.threads.map((thread) => {
      if (thread.worktreeId !== worktreeId) return thread;
      const { worktreeId: _gone, worktreeEnteredAt: _forked, ...local } = thread;
      if (thread.continuation) local.inheritedContinuation = true;
      return { ...local, messages: [...thread.messages, note()], updatedAt: now() };
    }),
  };
}

/** Hands back a checkout only when every linked thread explicitly leaves it. */
export function releaseWorktrees(state: WorkspaceState, leaving: Thread[]): Extract<WorkspaceEffect, { type: "release-worktree" }>[] {
  const going = new Set(leaving.map((thread) => thread.id));
  const released = new Set<string>();
  return leaving.flatMap((thread) => {
    const worktree = worktreeFor(state, thread);
    if (!worktree || released.has(worktree.id)) return [];
    if (worktreeClaimants(state, worktree.id).some((claimant) => !going.has(claimant.id))) return [];
    released.add(worktree.id);
    return [{ type: "release-worktree" as const, taskId: thread.id, worktreeId: worktree.id, root: worktree.root, title: thread.title }];
  });
}

/** Records a checkout a run just made, and marks the one the run happens in as touched. */
export function withUsedWorktree(state: WorkspaceState, created: Worktree | undefined, worktreeId: string | undefined): WorkspaceState {
  return afterward(state, { edits: [usedWorktreeIn(worktreesOf(state), created, worktreeId)] });
}

/** {@link withUsedWorktree}, on the checkouts an input is changing. */
export function usedWorktreeIn(edit: WorktreesEdit, created: Worktree | undefined, worktreeId: string | undefined): WorktreesEdit {
  if (!worktreeId) return edit;
  const { worktrees } = edit.view;
  const known = created && !worktrees.some((item) => item.id === created.id) ? [...worktrees, created] : worktrees;
  return new WorktreesChange({ ...edit.view, worktrees: known.map((item) => item.id === worktreeId ? { ...item, lastUsedAt: now() } : item) });
}
