/** The comparison a dock holds, and the reads that keep it pointed at the right checkout. */
import { environmentFor, subjectWorkspaceId } from "./environment.js";
import { followUps, settled } from "./shared.js";
import type { WorkspaceTransition } from "./types.js";
import { checkoutPullRequest, pullRequestBase } from "../pull-request-view.js";
import { threadWorkspaceId } from "../thread-location.js";
import { DIFF_PANEL, diffFor, dockSubject, withDiff, type DiffState, type WorkspaceState } from "../workspace-state.js";
import { DEFAULT_BRANCH_RANGE, modeForRange, rangeKey, type DiffRange } from "../../domain/diff.js";

/**
 * What a review opens on. A branch with an open pull request is read the way its reviewers read it,
 * from the branch it merges into. Otherwise the session panel counts from where HEAD left the origin
 * default branch, so a review reached from that row starts on the same comparison and reports the
 * same totals. Without an origin to measure from the Branch mode compares the working tree from HEAD.
 */
export function initialRange(state: WorkspaceState, owner: string, diff: DiffState): DiffRange {
  if (diff.mode !== "branch" || diff.workspaceId !== null || diff.result !== null) return diff.range;
  return defaultBranchRange(state, owner);
}

export function defaultBranchRange(state: WorkspaceState, owner: string): Extract<DiffRange, { kind: "branches" }> {
  const workspaceId = subjectWorkspaceId(state, owner);
  const reviewed = pullRequestBase(checkoutPullRequest(state, workspaceId));
  if (reviewed) return { kind: "branches", base: reviewed, compare: null };
  const counted = environmentFor(state, workspaceId);
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

/** The same, for the checkout the dock's review is about. */
export function readDiff(state: WorkspaceState, owner: string, range: DiffRange, patch: Partial<DiffState> = {}): WorkspaceTransition {
  const workspaceId = range.kind === "commit" ? diffFor(state, owner).workspaceId ?? subjectWorkspaceId(state, owner) : subjectWorkspaceId(state, owner);
  return readDiffFrom(state, owner, workspaceId, range, patch);
}

/**
 * A thread whose checkout changed is reviewing the wrong one until it reads again. Nothing to do for a
 * thread with no review open, which is most of them. The read is a follow-up of whatever moved it.
 */
export function rereadDiff(state: WorkspaceState, taskId: string): WorkspaceTransition {
  const diff = state.diffs[taskId];
  if (!diff) return settled(state);
  const subject = dockSubject(state, taskId, DIFF_PANEL) ?? taskId;
  const workspaceId = threadWorkspaceId(state, state.threads.find((thread) => thread.id === subject));
  if (diff.workspaceId === workspaceId) return settled(state);
  const read = readDiffFrom(state, taskId, workspaceId, diff.range, { result: null, collapsed: [], viewed: {} });
  return { ...read, effects: followUps(read.effects) };
}

/** Every review of a thread's checkout, as follow-ups: its own dock's, and a coordinator's that has its tab as the subject. */
export function rereadReviewsOf(state: WorkspaceState, taskId: string, workspaceId: string): WorkspaceTransition {
  let next = state;
  const effects: WorkspaceTransition["effects"] = [];
  for (const [owner, diff] of Object.entries(state.diffs)) {
    if ((dockSubject(state, owner, DIFF_PANEL) ?? owner) !== taskId) continue;
    const read = readDiffFrom(next, owner, workspaceId, diff.range);
    next = read.state;
    effects.push(...read.effects);
  }
  return settled(next, followUps(effects));
}

/**
 * Moves the reviews of a checkout still on the comparison they opened with to the one it opens with
 * now, which is what a pull request found, retargeted or closed under an open review changes. A
 * comparison the user picked is theirs and is left alone.
 */
export function retargetReviews(before: WorkspaceState, after: WorkspaceState, workspaceId: string): WorkspaceTransition {
  let next = after;
  const effects: WorkspaceTransition["effects"] = [];
  for (const [owner, diff] of Object.entries(after.diffs)) {
    if (diff.mode !== "branch" || diff.workspaceId !== workspaceId || subjectWorkspaceId(after, owner) !== workspaceId) continue;
    if (rangeKey(diff.range) !== rangeKey(defaultBranchRange(before, owner))) continue;
    const range = defaultBranchRange(after, owner);
    if (rangeKey(range) === rangeKey(diff.range)) continue;
    const read = readDiffFrom(next, owner, workspaceId, range, { result: null, collapsed: [], viewed: {} });
    next = read.state;
    effects.push(...read.effects);
  }
  return settled(next, followUps(effects));
}
