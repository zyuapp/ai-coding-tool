import { randomBytes } from "node:crypto";
import { access, cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  addWorktree,
  applyPatch,
  git,
  headCommit,
  ignoredPaths,
  isDetached,
  matchIgnorePatterns,
  removeWorktree,
  repositoryRoot,
  shortCommit,
  snapshotCommit,
  trackedDiff,
  untrackedPaths,
  updateRef,
} from "./git.mjs";
import type { WorkspaceService } from "./workspace-service.mjs";
import { snapshotMessage, worktreeDirectoryName, worktreeRef, type Worktree, type WorktreeRelease } from "../../domain/worktree.js";

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

export type WorktreeServiceOptions = {
  worktreesRoot: string;
  workspaces: WorkspaceService;
};

export type CreateWorktreeRequest = {
  projectRoot: string;
  /** Copies the project checkout's uncommitted work into the new worktree, leaving the original alone. */
  carryChanges: boolean;
  /** Which branch to detach from. The checkout's own HEAD when absent. */
  branch?: string;
};

export type ReleaseWorktreeRequest = {
  worktreeId: string;
  root: string;
  taskId: string;
  title: string;
  release: WorktreeRelease;
};

/** What a released worktree left behind, so the thread can say where its work went. */
export type WorktreeSnapshot = {
  commit: string | null;
  shortCommit: string | null;
  ref: string | null;
};

export class WorktreeService {
  private readonly worktreesRoot: string;
  private readonly workspaces: WorkspaceService;

  constructor(options: WorktreeServiceOptions) {
    this.worktreesRoot = options.worktreesRoot;
    this.workspaces = options.workspaces;
  }

  /**
   * A worktree detached at whatever the project checkout has checked out right now, carrying the
   * gitignored files `.worktreeinclude` names across. No branch is created; the thread makes one
   * itself if it wants one.
   */
  async create(request: CreateWorktreeRequest): Promise<Worktree> {
    const repository = await repositoryRoot(request.projectRoot);
    const baseCommit = await headCommit(repository, request.branch);
    const id = randomBytes(4).toString("hex");
    const root = path.join(this.worktreesRoot, worktreeDirectoryName(repository, id));
    await mkdir(this.worktreesRoot, { recursive: true });
    await addWorktree(repository, root, baseCommit);

    await copyIncludedFiles(repository, root);
    if (request.carryChanges) await carryChanges(repository, root);

    const registration = await this.workspaces.registerWorktree(root);
    const at = Date.now();
    return { id, root: registration.workspace.root, workspaceId: registration.workspace.id, baseCommit, createdAt: at, lastUsedAt: at };
  }

  /**
   * Commits everything left in the worktree so a thread never loses work by walking away from it.
   * A worktree still detached has no branch holding its commit, so a ref under `refs/claudex` keeps
   * it reachable; once the thread has made a branch, the branch does that job.
   */
  async release(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshot> {
    const ref = (await isDetached(request.root)) ? worktreeRef(request.worktreeId) : null;
    const commit = await snapshotCommit(request.root, snapshotMessage(request.title, request.taskId, request.release, ref));
    if (!commit) return { commit: null, shortCommit: null, ref: null };
    if (ref) await updateRef(request.root, ref, commit);
    return { commit, shortCommit: await shortCommit(request.root, commit), ref };
  }

  /** Throws the directory away along with anything uncommitted in it. Branches are never touched. */
  async delete(root: string) {
    const repository = await parentRepository(root);
    if (repository) await removeWorktree(repository, root);
  }
}

/** A worktree's `.git` is a file pointing into the checkout it was linked from. */
async function parentRepository(root: string) {
  try {
    const common = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
    return path.dirname(path.resolve(root, common));
  } catch {
    return null;
  }
}

/**
 * The files `.worktreeinclude` names, copied out of the project checkout. Only paths Git already
 * ignores are eligible, so a pattern can never duplicate a tracked file into the worktree.
 */
async function copyIncludedFiles(repository: string, worktreePath: string) {
  const patterns = path.join(repository, WORKTREE_INCLUDE_FILE);
  try {
    await access(patterns);
  } catch {
    return;
  }
  const included = await matchIgnorePatterns(patterns, await ignoredPaths(repository));
  for (const relative of included) {
    const from = path.join(repository, relative);
    const to = path.join(worktreePath, relative);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, force: true, preserveTimestamps: true }).catch(() => {});
  }
}

/** Uncommitted work, copied across: tracked edits as a patch, untracked files verbatim. */
async function carryChanges(repository: string, worktreePath: string) {
  const patch = await trackedDiff(repository);
  if (patch.trim()) await applyPatch(worktreePath, patch);
  for (const relative of await untrackedPaths(repository)) {
    const from = path.join(repository, relative);
    const to = path.join(worktreePath, relative);
    const metadata = await stat(from).catch(() => null);
    if (!metadata?.isFile()) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { force: true, preserveTimestamps: true }).catch(() => {});
  }
}
