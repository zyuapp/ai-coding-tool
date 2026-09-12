/** What Git last said about a checkout, and which checkout the app is asking about. */
import { sameStrings } from "./shared.js";
import type { WorkspaceEffect } from "./types.js";
import { threadWorkspaceId } from "../thread-location.js";
import type { WorkspaceState } from "../workspace-state.js";
import type { ChangedFilesResult } from "../../contracts/ipc.js";

export function sameChangedFiles(left: ChangedFilesResult | null, right: ChangedFilesResult) {
  if (!left || left.status !== right.status) return false;
  if (left.status === "available" && right.status === "available") {
    return left.branch === right.branch
      && left.baseline === right.baseline
      && left.additions === right.additions
      && left.deletions === right.deletions
      && sameStrings(left.files, right.files);
  }
  if (left.status === "unavailable" && right.status === "unavailable") return left.reason === right.reason;
  if (left.status === "unknown" && right.status === "unknown") return left.workspaceId === right.workspaceId;
  if (left.status === "error" && right.status === "error") return left.message === right.message;
  return false;
}

/** The checkout the thread in front works in: what Git is read from, for its diff as for its status. */
export function currentWorkspaceId(state: WorkspaceState) {
  const currentThread = state.threads.find((thread) => thread.id === state.currentId);
  if (currentThread) return threadWorkspaceId(state, currentThread);
  return state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.workspaceId : undefined;
}

/**
 * Asks Git about the checkout the thread in front works in. It names the run its answer follows, so a
 * reply about work a newer run has already moved past is not written onto the thread.
 */
export function refreshEnvironment(state: WorkspaceState): WorkspaceEffect[] {
  const workspaceId = currentWorkspaceId(state);
  if (!workspaceId) return [];
  const taskId = state.threads.find((thread) => thread.id === state.currentId)?.id;
  const runId = taskId ? state.lastRunIds[taskId] : undefined;
  return [{ type: "refresh-environment", workspaceId, ...(taskId ? { taskId } : {}), ...(runId ? { runId } : {}) }];
}

/** What Git last said about a checkout, or null while none of it has been read yet. */
export function environmentFor(state: WorkspaceState, workspaceId: string | undefined) {
  return (workspaceId ? state.environments[workspaceId] : undefined) ?? null;
}

/** Forgets one checkout's answer, so a directory that is gone leaves nothing behind it. */
export function withoutEnvironment(environments: WorkspaceState["environments"], workspaceId: string) {
  if (!(workspaceId in environments)) return environments;
  const { [workspaceId]: _gone, ...rest } = environments;
  return rest;
}

/**
 * The answers worth keeping: one per checkout the app still has, plus the one just read. A checkout
 * the user deleted outside the app is forgotten here rather than kept for the rest of the session.
 */
export function retainedEnvironments(state: WorkspaceState, workspaceId: string, result: ChangedFilesResult) {
  const live = new Set([
    workspaceId,
    ...state.projects.map((project) => project.workspaceId),
    ...state.worktrees.map((worktree) => worktree.workspaceId),
  ]);
  const kept: WorkspaceState["environments"] = { [workspaceId]: result };
  for (const [id, answer] of Object.entries(state.environments)) if (id !== workspaceId && live.has(id)) kept[id] = answer;
  return kept;
}
