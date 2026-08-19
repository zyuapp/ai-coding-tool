import { randomBytes } from "node:crypto";
import { access, cp, mkdir, readdir, stat } from "node:fs/promises";
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
  pruneWorktrees,
  repositoryRoot,
  shortCommit,
  snapshotCommit,
  trackedDiff,
  untrackedPaths,
  updateRef,
} from "./git.mjs";
import type { WorkspaceService } from "./workspace-service.mjs";
import { snapshotMessage, worktreeDirectoryName, worktreeIdFromDirectoryName, worktreeRef, type Worktree, type WorktreeRelease } from "../../domain/worktree.js";

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

/** What a reconcile compares the worktrees root against: the checkouts threads still claim. */
export type ReconcileRequest = {
  claimed: string[];
  /** The project checkouts a stale worktree registration could still be recorded in. */
  repositories: string[];
};

export type ReleaseWorktreeRequest = {
  worktreeId: string;
  root: string;
  /** The thread handing the checkout back, or null when nothing claims it any more. */
  taskId: string | null;
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
   * Commits everything left in the worktree so a thread never loses work by walking away from it,
   * then gives the directory back. A worktree still detached has no branch holding its commit, so a
   * ref under `refs/claudex` keeps it reachable; once the thread has made a branch, the branch does
   * that job. The snapshot has to land before the directory goes, so a failure there keeps both.
   */
  async release(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshot> {
    const snapshot = await this.snapshot(request);
    await this.delete(request.root);
    return snapshot;
  }

  /** Throws the directory away along with anything uncommitted in it. Branches are never touched. */
  async delete(root: string) {
    const repository = await parentRepository(root);
    if (repository) await removeWorktree(repository, root);
    await this.workspaces.forgetWorktree(root);
  }

  /**
   * Reaps every checkout under the worktrees root that no thread claims, which is what a worktree
   * outliving its thread looks like from here: a crash between making one and recording it, a
   * thread deleted while it held one, or a release that never finished. Whatever such a checkout
   * still holds is committed and kept reachable first, exactly as returning to local would.
   */
  async reconcile(request: ReconcileRequest): Promise<{ reaped: string[] }> {
    const claimed = new Set(request.claimed.map((root) => path.resolve(root)));
    const reaped: string[] = [];
    for (const entry of await readdir(this.worktreesRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const root = path.join(this.worktreesRoot, entry.name);
      if (claimed.has(root)) continue;
      /** One directory that cannot be read is not a reason to leave every other one behind. */
      try {
        await this.release({
          worktreeId: worktreeIdFromDirectoryName(entry.name),
          root,
          taskId: null,
          title: entry.name,
          release: "evicted",
        });
        reaped.push(root);
      } catch (error) {
        console.error(`Could not reap the worktree at ${root}:`, error);
      }
    }
    /** A registration outlives its directory whenever one is removed from outside the app. */
    for (const record of await this.workspaces.listWorktrees()) {
      if (!(await directoryExists(record.root))) await this.workspaces.forgetWorktree(record.root);
    }
    for (const repository of request.repositories) await pruneWorktrees(repository);
    return { reaped };
  }

  /** A directory that is already gone has nothing to commit, and says so rather than failing. */
  private async snapshot(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshot> {
    if (!(await directoryExists(request.root))) return { commit: null, shortCommit: null, ref: null };
    const ref = (await isDetached(request.root)) ? worktreeRef(request.worktreeId) : null;
    const commit = await snapshotCommit(request.root, snapshotMessage(request.title, request.taskId, request.release, ref));
    if (!commit) return { commit: null, shortCommit: null, ref: null };
    if (ref) await updateRef(request.root, ref, commit);
    return { commit, shortCommit: await shortCommit(request.root, commit), ref };
  }
}

async function directoryExists(root: string) {
  return stat(root).then((entry) => entry.isDirectory(), () => false);
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
