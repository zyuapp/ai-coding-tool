import { randomBytes } from "node:crypto";
import { access, cp, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  addWorktree,
  applyPatch,
  git,
  headCommit,
  headIsUnreachable,
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

/** What this service makes: the checkout on disk, without the project link only workspace state has. */
export type CreatedWorktree = Omit<Worktree, "projectId">;

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

export type WorktreeServiceOptions = {
  worktreesRoot: string;
  /** Roots the app used before, still its own: reconciled and reaped, but never created in again. */
  legacyRoots?: string[];
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
  /** Every root the app owns checkouts in, newest first. Only the first one is created in. */
  private readonly ownedRoots: string[];
  private readonly workspaces: WorkspaceService;

  constructor(options: WorktreeServiceOptions) {
    this.worktreesRoot = options.worktreesRoot;
    this.ownedRoots = [...new Set([options.worktreesRoot, ...options.legacyRoots ?? []])];
    this.workspaces = options.workspaces;
  }

  /**
   * A worktree detached at whatever the project checkout has checked out right now, carrying the
   * gitignored files `.worktreeinclude` names across. No branch is created; the thread makes one
   * itself if it wants one.
   */
  async create(request: CreateWorktreeRequest): Promise<CreatedWorktree> {
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
   * then gives the directory back. A worktree still detached has no branch holding its commits —
   * the snapshot's or the thread's own — so a ref under `refs/claudex` keeps them reachable; once
   * the thread has made a branch, the branch does that job. The snapshot has to land before the
   * directory goes, so a failure there keeps both.
   */
  async release(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshot> {
    await this.assertOwned(request.root);
    const snapshot = await this.snapshot(request);
    await this.delete(request.root);
    return snapshot;
  }

  /**
   * Throws the directory away along with anything uncommitted in it. Branches are never touched.
   * Git cannot remove a checkout whose repository is gone, so the directory itself always goes.
   */
  async delete(root: string) {
    await this.assertOwned(root);
    const canonical = await canonicalPath(root);
    const repository = await parentRepository(root);
    if (repository) await removeWorktree(repository, root);
    await rm(root, { recursive: true, force: true });
    await this.workspaces.forgetWorktree(canonical);
  }

  /**
   * Reaps every checkout under a root the app owns that no thread claims, which is what a worktree
   * outliving its thread looks like from here: a crash between making one and recording it, a
   * thread deleted while it held one, or a release that never finished. Whatever such a checkout
   * still holds is committed and kept reachable first, exactly as returning to local would.
   */
  async reconcile(request: ReconcileRequest): Promise<{ reaped: string[] }> {
    /** Claimed roots come from the registry realpath'd; the disk is read literally. Compare like with like. */
    const claimed = new Set(await Promise.all(request.claimed.map(canonicalPath)));
    const reaped: string[] = [];
    for (const base of this.ownedRoots) {
      for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue;
        const root = path.join(base, entry.name);
        if (claimed.has(await canonicalPath(root))) continue;
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
    }
    /** A registration outlives its directory whenever one is removed from outside the app. */
    for (const record of await this.workspaces.listWorktrees()) {
      if (!(await directoryExists(record.root))) await this.workspaces.forgetWorktree(record.root);
    }
    for (const repository of request.repositories) await pruneWorktrees(repository);
    return { reaped };
  }

  /**
   * A directory that is already gone, or whose repository is, has nothing to commit and nowhere to
   * keep it, and says so rather than failing. A detached checkout keeps its `refs/claudex` ref even
   * with nothing left to commit: commits the thread made itself have no branch holding them either.
   */
  private async snapshot(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshot> {
    if (!(await directoryExists(request.root))) return { commit: null, shortCommit: null, ref: null };
    if (!(await parentRepository(request.root))) return { commit: null, shortCommit: null, ref: null };
    const ref = (await isDetached(request.root)) ? worktreeRef(request.worktreeId) : null;
    const commit = await snapshotCommit(request.root, snapshotMessage(request.title, request.taskId, request.release, ref));
    const kept = commit ?? (ref && (await headIsUnreachable(request.root)) ? await headCommit(request.root) : null);
    if (!kept) return { commit: null, shortCommit: null, ref: null };
    if (ref) await updateRef(request.root, ref, kept);
    return { commit, shortCommit: commit ? await shortCommit(request.root, commit) : null, ref };
  }

  /** Everything here acts only inside a root the app owns; any other path is refused outright. */
  private async assertOwned(root: string) {
    const roots = [
      ...await Promise.all(this.ownedRoots.map((owned) => canonicalPath(owned))),
      ...this.ownedRoots.map((owned) => path.resolve(owned)),
    ];
    const candidates = [await canonicalPath(root), path.resolve(root)];
    const owned = roots.some((base) => candidates.some((candidate) => candidate.startsWith(`${base}${path.sep}`)));
    if (!owned) throw new Error(`Not an AI Coding Tool worktree: ${root}`);
  }
}

/** Resolved through symlinks while the path exists, so the registry, git and the disk agree on it. */
async function canonicalPath(target: string) {
  return realpath(target).catch(() => path.resolve(target));
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
    /** The includes are conveniences, not the thread's work; one that will not copy is not fatal. */
    await cp(from, to, { recursive: true, force: true, preserveTimestamps: true }).catch((error) => {
      console.error(`Could not copy ${relative} into the worktree:`, error);
    });
  }
}

/** Uncommitted work, copied across: tracked edits as a patch, untracked files and symlinks verbatim. */
async function carryChanges(repository: string, worktreePath: string) {
  const patch = await trackedDiff(repository);
  if (patch.trim()) await applyPatch(worktreePath, patch);
  for (const relative of await untrackedPaths(repository)) {
    const from = path.join(repository, relative);
    const to = path.join(worktreePath, relative);
    /** A path deleted while this runs is gone from the checkout too, so there is nothing to carry. */
    const metadata = await lstat(from).catch(() => null);
    if (!metadata || (!metadata.isFile() && !metadata.isSymbolicLink())) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { force: true, preserveTimestamps: true, verbatimSymlinks: true });
  }
}
