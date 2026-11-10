import type { ChangedFilesResult } from "../../contracts/ipc.js";
import type { PullRequestRead } from "../../domain/pull-request.js";

/** What Git and the forge last said about each checkout. Session-only. */
export type GitState = {
  /**
   * What Git last said about each checkout, keyed by checkout. A checkout is what a branch and a set
   * of changes belong to, so a scan of one never overwrites another, and a thread returned to shows
   * what was last read while a new scan runs. Session-only, and never persisted.
   */
  environments: Record<string, ChangedFilesResult>;
  /** The pull request last read, for the checkout and branch it was read for. Session-only. */
  pullRequest: PullRequestRead | null;
  /** The pull request of each checkout the open coordinator's threads work in, keyed by checkout. Session-only. */
  memberPullRequests: Record<string, PullRequestRead>;
};

export function initialGitState(): GitState {
  return { environments: {}, pullRequest: null, memberPullRequests: {} };
}
