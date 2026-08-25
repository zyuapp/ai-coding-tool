import type { DiffSummaryResult } from "../contracts/ipc.js";
import { fileFingerprint, rangeKey, UNCOMMITTED, type DiffRange } from "../domain/diff.js";
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
};

export const EMPTY_DIFF: DiffState = {
  range: UNCOMMITTED,
  workspaceId: null,
  result: null,
  loading: false,
  collapsed: [],
  viewed: {},
  split: true,
};

export function diffFor(state: Pick<WorkspaceState, "diffs">, owner: string): DiffState {
  return state.diffs[owner] ?? EMPTY_DIFF;
}

export function withDiff(state: WorkspaceState, owner: string, patch: Partial<DiffState>): WorkspaceState {
  return { ...state, diffs: { ...state.diffs, [owner]: { ...diffFor(state, owner), ...patch } } };
}

/**
 * The ticks that survive a fresh list: a file whose counts moved has changed since it was read, so
 * it comes back unread rather than staying ticked against work the user has not seen.
 */
export function retainedViews(viewed: Record<string, string>, result: DiffSummaryResult) {
  if (result.status !== "available") return viewed;
  const fingerprints = new Map(result.files.map((file) => [file.path, fileFingerprint(file)]));
  return Object.fromEntries(Object.entries(viewed).filter(([path, mark]) => fingerprints.get(path) === mark));
}

/** Whether a landed list still answers what its dock is asking, which a slow read may not. */
export function diffMatches(diff: DiffState, workspaceId: string, range: DiffRange) {
  return diff.workspaceId === workspaceId && rangeKey(diff.range) === rangeKey(range);
}
