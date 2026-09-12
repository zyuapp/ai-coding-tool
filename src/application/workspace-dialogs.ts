import type { Project } from "../domain/project.js";
import { threadWorkspaceId, worktreeClaimants, worktreeFor } from "./thread-location.js";
import type { WorkspaceState } from "./workspace-state.js";

/** The folder editor as the dialog draws it: the folder being edited, and how the last save went. */
export type ProjectEditorView = { project: Project; checkouts: number; saving: boolean; error: string | null };

export function projectEditorView(state: WorkspaceState): ProjectEditorView | null {
  const edit = state.projectEdit;
  const project = edit && state.projects.find((item) => item.id === edit.projectId);
  if (!edit || !project) return null;
  const checkouts = state.worktrees.filter((worktree) => worktree.projectId === project.id).length;
  return { project, checkouts, saving: edit.saving, error: edit.error };
}

/** The pending move as the confirmation draws it: where it goes, and what the thread is holding. */
export type WorktreeMoveView = {
  worktree: boolean;
  /** Uncommitted files in the checkout the thread is leaving, which the move commits first. */
  changes: number;
  /** Threads left in the worktree once this one goes, so the text can say whether it stays. */
  others: number;
};

export function worktreeMoveView(state: WorkspaceState): WorktreeMoveView | null {
  const move = state.worktreeMove;
  const thread = move && state.threads.find((item) => item.id === move.taskId);
  if (!move || !thread) return null;
  const workspaceId = threadWorkspaceId(state, thread);
  const environment = workspaceId ? state.environments[workspaceId] : undefined;
  const worktree = worktreeFor(state, thread);
  return {
    worktree: move.worktree,
    changes: environment?.status === "available" ? environment.files.length : 0,
    others: worktree ? Math.max(worktreeClaimants(state, worktree.id).length - 1, 0) : 0,
  };
}

