/** The comparison a dock holds, and the reads that keep it pointed at the right checkout. */
import { environmentFor, subjectWorkspaceId } from "./environment.js";
import { docksOf, editDiff } from "./dock-tabs.js";
import { followUps } from "./shared.js";
import { applied, inTurn, type Step } from "./slice.js";
import type { WorkspaceTransition } from "./types.js";
import { threadWorkspaceId } from "../thread-location.js";
import { DIFF_PANEL, diffFor, dockSubject, type DiffState, type WorkspaceState } from "../workspace-state.js";
import { DEFAULT_BRANCH_RANGE, modeForRange, type DiffRange } from "../../domain/diff.js";

/**
 * What a review opens on. The session panel counts from where HEAD left the origin default branch, so
 * a review reached from that row starts on the same comparison and reports the same totals. Without
 * an origin to measure from the Branch mode compares the working tree from HEAD.
 */
export function initialRange(state: WorkspaceState, owner: string, diff: DiffState): DiffRange {
  if (diff.mode !== "branch" || diff.workspaceId !== null || diff.result !== null) return diff.range;
  return defaultBranchRange(state, owner);
}

export function defaultBranchRange(state: WorkspaceState, owner: string): Extract<DiffRange, { kind: "branches" }> {
  const counted = environmentFor(state, subjectWorkspaceId(state, owner));
  const baseline = counted?.status === "available" ? counted.baseline : null;
  return baseline ? { kind: "branches", base: baseline, compare: null } : DEFAULT_BRANCH_RANGE;
}

/**
 * Asks for a comparison, and records in the same breath which checkout was asked. The two have to move
 * together: a reply is only accepted when it names the checkout and comparison the dock is holding, so
 * an effect issued without writing that down is an answer the reducer would throw away.
 */
export function diffReadFrom(state: WorkspaceState, owner: string, workspaceId: string | undefined, range: DiffRange, patch: Partial<DiffState> = {}): Step {
  const previous = diffFor(state, owner);
  const sameWorkspace = previous.workspaceId === workspaceId;
  patch = {
    ...patch,
    mode: modeForRange(range),
    branchRange: range.kind === "branches" ? range : sameWorkspace ? previous.branchRange : undefined,
  };
  if (!workspaceId) return { edits: [editDiff(docksOf(state), owner, { ...patch, range, workspaceId: null, result: null, loading: false })] };
  /** The read takes the whitespace setting the review lands with, which is the one it already had. */
  const ignoreWhitespace = patch.ignoreWhitespace ?? diffFor(state, owner).ignoreWhitespace;
  return {
    edits: [editDiff(docksOf(state), owner, { ...patch, range, workspaceId, loading: true })],
    effects: [{ type: "read-diff", owner, workspaceId, range, ignoreWhitespace }],
  };
}

/** {@link diffReadFrom}, on the whole state. */
export function readDiffFrom(state: WorkspaceState, owner: string, workspaceId: string | undefined, range: DiffRange, patch: Partial<DiffState> = {}): WorkspaceTransition {
  return applied(state, diffReadFrom(state, owner, workspaceId, range, patch));
}

/** The same, for the checkout the dock's review is about. */
export function diffRead(state: WorkspaceState, owner: string, range: DiffRange, patch: Partial<DiffState> = {}): Step {
  const workspaceId = range.kind === "commit" ? diffFor(state, owner).workspaceId ?? subjectWorkspaceId(state, owner) : subjectWorkspaceId(state, owner);
  return diffReadFrom(state, owner, workspaceId, range, patch);
}

/**
 * A thread whose checkout changed is reviewing the wrong one until it reads again. Nothing to do for a
 * thread with no review open, which is most of them. The read is a follow-up of whatever moved it.
 */
export function diffReread(state: WorkspaceState, taskId: string): Step {
  const diff = state.diffs[taskId];
  if (!diff) return {};
  const subject = dockSubject(state, taskId, DIFF_PANEL) ?? taskId;
  const workspaceId = threadWorkspaceId(state, state.threads.find((thread) => thread.id === subject));
  if (diff.workspaceId === workspaceId) return {};
  const read = diffReadFrom(state, taskId, workspaceId, diff.range, { result: null, collapsed: [], viewed: {} });
  return { ...read, effects: followUps(read.effects ?? []) };
}

/** {@link diffReread}, on the whole state. */
export function rereadDiff(state: WorkspaceState, taskId: string): WorkspaceTransition {
  return applied(state, diffReread(state, taskId));
}

/** Every review of a thread's checkout, as follow-ups: its own dock's, and a coordinator's that has its tab as the subject. */
export function reviewsReread(state: WorkspaceState, taskId: string, workspaceId: string): Step {
  const owners = Object.entries(state.diffs).filter(([owner]) => (dockSubject(state, owner, DIFF_PANEL) ?? owner) === taskId);
  const read = inTurn(state, {}, owners.map(([owner, diff]) => (next: WorkspaceState) => diffReadFrom(next, owner, workspaceId, diff.range)));
  return { ...read, effects: followUps(read.effects ?? []) };
}

/** {@link reviewsReread}, on the whole state. */
export function rereadReviewsOf(state: WorkspaceState, taskId: string, workspaceId: string): WorkspaceTransition {
  return applied(state, reviewsReread(state, taskId, workspaceId));
}
