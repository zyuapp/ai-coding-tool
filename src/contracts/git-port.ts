import type { DiffRange } from "../domain/diff.js";
import type { PullRequestAnswer } from "../domain/pull-request.js";
import type { ManagedWorktree } from "../domain/worktree.js";
import type { BranchesResult } from "./git.js";
import type { ChangedFilesResult, CreatedWorktree, CreateWorktreeRequest, DiffPatchResult, DiffSummaryResult, ReleaseWorktreeRequest, WorkspaceId, WorktreeSnapshotResult } from "./ipc.js";

type GitRuntime = {
  changedFiles(workspaceId: WorkspaceId): Promise<ChangedFilesResult>;
  /** The files a comparison touches, with their counts. Cheap enough to read whenever a run ends. */
  diffSummary(workspaceId: WorkspaceId, range: DiffRange, ignoreWhitespace?: boolean): Promise<DiffSummaryResult>;
  /** One file's patch, read only once that file is drawn. A rename needs both of its paths. */
  diffPatch(workspaceId: WorkspaceId, range: DiffRange, path: string, previousPath?: string, ignoreWhitespace?: boolean): Promise<DiffPatchResult>;
  /** What the checkout has to say about its pull request, including that `gh` is not installed. */
  pullRequest(workspaceId: WorkspaceId): Promise<PullRequestAnswer>;
  /** Moves a project checkout onto a branch. Never forced, so uncommitted work stops it. */
  checkoutBranch(workspaceId: WorkspaceId, branch: string): Promise<void>;
  /** Makes a branch at the checkout's own HEAD, without moving onto it. */
  createBranch(workspaceId: WorkspaceId, branch: string): Promise<void>;
  /** Makes the thread's own checkout, detached at whatever the project has checked out right now. */
  createWorktree(request: CreateWorktreeRequest): Promise<CreatedWorktree>;
  /** Reads the worktree directories under roots owned by this app without changing them. */
  listManagedWorktrees(): Promise<ManagedWorktree[]>;
  /** Shows one app-owned worktree in the platform's file manager. */
  revealWorktree(root: string): Promise<void>;
  /** Force-commits what the worktree still holds so the thread can leave it without losing work. */
  releaseWorktree(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshotResult>;
};

/** Checkouts, and what Git and GitHub say about them. */
export type GitPort = {
  runtime: GitRuntime;
  windowCalls: Pick<GitRuntime, "diffPatch"> & {
    /** The local branches a thread can start from, newest first. */
    branches(workspaceId: WorkspaceId): Promise<BranchesResult>;
    /** Which of these hashes are commits the checkout's repository holds. */
    commits(workspaceId: WorkspaceId, hashes: string[]): Promise<string[]>;
  };
};
