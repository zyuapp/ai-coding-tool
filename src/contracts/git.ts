export type { CommitHistoryRequest, CommitHistoryResult } from "../domain/commit-history.js";

export type BranchesResult =
  /** `branches` are local and can be moved onto; `remotes` can only be compared against. */
  | { status: "available"; branches: string[]; remotes: string[]; current: string | null }
  | { status: "error"; message: string };
