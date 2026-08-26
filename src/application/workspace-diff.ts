import type { DiffSummaryResult } from "../contracts/ipc.js";
import { fileFingerprint, foldedForSize, rangeKey, UNCOMMITTED, type DiffFileSummary, type DiffRange } from "../domain/diff.js";
import type { WorkspaceState } from "./workspace-state.js";

/**
 * One thread's review of its own checkout: what it is comparing, which files it has folded away, and
 * which it has ticked off. Only the file list is held; a patch is content, so it is read when its
 * file is drawn and never becomes state, the way a page's contents and a shell's scrollback never do.
 */
export type DiffState = {
  range: DiffRange;
  /** The checkout the list was read from, so a thread that moves does not read a stale one. */
  workspaceId: string | null;
  result: DiffSummaryResult | null;
  loading: boolean;
  /** Files folded shut. Everything is open until the user says otherwise, so a review reads top to bottom. */
  collapsed: string[];
  /** Ticked-off paths, each against the counts it had when ticked, so a file that moves un-ticks. */
  viewed: Record<string, string>;
  split: boolean;
  /** Whether lines that only changed their spacing are left out of the review. */
  ignoreWhitespace: boolean;
};

export const EMPTY_DIFF: DiffState = {
  range: UNCOMMITTED,
  workspaceId: null,
  result: null,
  loading: false,
  collapsed: [],
  viewed: {},
  split: true,
  ignoreWhitespace: false,
};

export function diffFor(state: Pick<WorkspaceState, "diffs">, owner: string): DiffState {
  return state.diffs[owner] ?? EMPTY_DIFF;
}

export function withDiff(state: WorkspaceState, owner: string, patch: Partial<DiffState>): WorkspaceState {
  return { ...state, diffs: { ...state.diffs, [owner]: { ...diffFor(state, owner), ...patch } } };
}

/**
 * Whether a fresh list counts the same files a different way, which is what the whitespace toggle
 * does. Nothing changed under the user, so what they had read and folded is still read and folded.
 */
export function recounted(previous: DiffSummaryResult | null, result: DiffSummaryResult) {
  return previous?.status === "available"
    && result.status === "available"
    && previous.ignoreWhitespace !== result.ignoreWhitespace;
}

/**
 * The ticks that survive a fresh list: a file whose counts moved has changed since it was read, so
 * it comes back unread rather than staying ticked against work the user has not seen. A recount is
 * the exception, and its ticks are stamped again with the counts the file is now listed at.
 */
export function retainedViews(viewed: Record<string, string>, result: DiffSummaryResult, previous: DiffSummaryResult | null = null) {
  if (result.status !== "available") return viewed;
  const fingerprints = new Map(result.files.map((file) => [file.path, fileFingerprint(file)]));
  const before = previous?.status === "available" && recounted(previous, result)
    ? new Map(previous.files.map((file) => [file.path, fileFingerprint(file)]))
    : null;
  const kept = Object.entries(viewed)
    .filter(([path, mark]) => fingerprints.has(path) && (fingerprints.get(path) === mark || before?.get(path) === mark));
  return Object.fromEntries(kept.map(([path]) => [path, fingerprints.get(path)!]));
}

/**
 * The folds a fresh list lands with. A file the user has already decided about keeps their decision;
 * a file that is new, or that changed under them, folds when it is too large to draw. That is how a
 * checkout which blows up under an open review folds itself away instead of taking the window with it.
 */
export function foldedOnLoad(diff: DiffState, files: DiffFileSummary[], result: DiffSummaryResult): string[] {
  const before = diff.result?.status === "available"
    ? new Map(diff.result.files.map((file) => [file.path, fileFingerprint(file)]))
    : new Map<string, string>();
  const counted = recounted(diff.result, result);
  const oversized = foldedForSize(files);
  const held = new Set(diff.collapsed);
  const known = (file: DiffFileSummary) => counted ? before.has(file.path) : before.get(file.path) === fileFingerprint(file);
  return files
    .filter((file) => known(file) ? held.has(file.path) : oversized.has(file.path))
    .map((file) => file.path);
}

/** Whether a landed list still answers what its dock is asking, which a slow read may not. */
export function diffMatches(diff: DiffState, workspaceId: string, range: DiffRange) {
  return diff.workspaceId === workspaceId && rangeKey(diff.range) === rangeKey(range);
}
