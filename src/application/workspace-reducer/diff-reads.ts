/** The comparison a dock holds, and the reads that keep it pointed at the right checkout. */
import { currentWorkspaceId, environmentFor } from "./environment.js";
import { settled } from "./shared.js";
import type { WorkspaceTransition } from "./types.js";
import { threadWorkspaceId } from "../thread-location.js";
import { diffFor, withDiff, type DiffState, type WorkspaceState } from "../workspace-state.js";
import { DEFAULT_BRANCH_RANGE, modeForRange, type DiffRange } from "../../domain/diff.js";

/**
 * What a review opens on. The session panel counts from where HEAD left the origin default branch, so
 * a review reached from that row starts on the same comparison and reports the same totals. Without
 * an origin to measure from the Branch mode compares the working tree from HEAD.
 */
export function initialRange(state: WorkspaceState, diff: DiffState): DiffRange {
  if (diff.mode !== "branch" || diff.workspaceId !== null || diff.result !== null) return diff.range;
  return defaultBranchRange(state);
}

export function defaultBranchRange(state: WorkspaceState): Extract<DiffRange, { kind: "branches" }> {
  const counted = environmentFor(state, currentWorkspaceId(state));
  const baseline = counted?.status === "available" ? counted.baseline : null;
  return baseline ? { kind: "branches", base: baseline, compare: null } : DEFAULT_BRANCH_RANGE;
}

/**
 * Asks for a comparison, and records in the same breath which checkout was asked. The two have to move
 * together: a reply is only accepted when it names the checkout and comparison the dock is holding, so
 * an effect issued without writing that down is an answer the reducer would throw away.
 */
export function readDiffFrom(state: WorkspaceState, owner: string, workspaceId: string | undefined, range: DiffRange, patch: Partial<DiffState> = {}): WorkspaceTransition {
  const previous = diffFor(state, owner);
  const sameWorkspace = previous.workspaceId === workspaceId;
  patch = {
    ...patch,
    mode: modeForRange(range),
    branchRange: range.kind === "branches" ? range : sameWorkspace ? previous.branchRange : undefined,
  };
  if (!workspaceId) return settled(withDiff(state, owner, { ...patch, range, workspaceId: null, result: null, loading: false }));
  /** The read takes the whitespace setting the review lands with, which is the one it already had. */
  const ignoreWhitespace = patch.ignoreWhitespace ?? diffFor(state, owner).ignoreWhitespace;
  return settled(
    withDiff(state, owner, { ...patch, range, workspaceId, loading: true }),
    [{ type: "read-diff", owner, workspaceId, range, ignoreWhitespace }],
  );
}

/** The same, for the thread the user is looking at. */
export function readDiff(state: WorkspaceState, owner: string, range: DiffRange, patch: Partial<DiffState> = {}): WorkspaceTransition {
  const workspaceId = range.kind === "commit" ? diffFor(state, owner).workspaceId ?? currentWorkspaceId(state) : currentWorkspaceId(state);
  return readDiffFrom(state, owner, workspaceId, range, patch);
}

/**
 * A thread whose checkout changed is reviewing the wrong one until it reads again. Nothing to do for a
 * thread with no review open, which is most of them.
 */
export function rereadDiff(state: WorkspaceState, taskId: string): WorkspaceTransition {
  const diff = state.diffs[taskId];
  if (!diff) return settled(state);
  const workspaceId = threadWorkspaceId(state, state.threads.find((thread) => thread.id === taskId));
  return diff.workspaceId === workspaceId ? settled(state) : readDiffFrom(state, taskId, workspaceId, diff.range, { result: null, collapsed: [], viewed: {} });
}
