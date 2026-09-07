import { randomBytes } from "node:crypto";
import { access, cp, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  addWorktree,
  applyPatch,
  currentBranch,
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
  unreachableHead,
  untrackedPaths,
  updateRef,
} from "./git.mjs";
import { readWorktreeStatus } from "./worktree-status.mjs";
import type { WorkspaceService } from "./workspace-service.mjs";
import { snapshotMessage, worktreeDirectoryName, worktreeIdFromDirectoryName, worktreeRef, type ManagedWorktree, type Worktree, type WorktreeRelease } from "../../domain/worktree.js";

/** What this service makes: the checkout on disk, without the project link only workspace state has. */
export type CreatedWorktree = Omit<Worktree, "projectId">;

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

export type WorktreeServiceOptions = {
  worktreesRoot: string;
  /** Roots the app used before, still its own: listed and manually removable, but never created in again. */
  legacyRoots?: string[];
  workspaces: Pick<WorkspaceService, "registerWorktree" | "forgetWorktree">;
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
  /** The thread handing the checkout back, or null when nothing claims it any more. */
  taskId: string | null;
  title: string;
  release: WorktreeRelease;
  /** Only forget a missing folder; an existing folder must remain untouched. */
  missingOnly?: boolean;
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
  private readonly workspaces: WorktreeServiceOptions["workspaces"];

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
    const [repository, baseCommit] = await Promise.all([
      repositoryRoot(request.projectRoot),
      headCommit(request.projectRoot, request.branch),
    ]);
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

  /** Reads every directory the app owns without changing it, including roots used by older builds. */
  async list(): Promise<ManagedWorktree[]> {
    const roots = (await Promise.all(this.ownedRoots.map(async (base) =>
      (await readdir(base, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(base, entry.name)),
    ))).flat();
    const worktrees: ManagedWorktree[] = [];
    let cursor = 0;
    const read = async () => {
      while (cursor < roots.length) {
        const root = roots[cursor++];
        const canonical = await canonicalPath(root);
        const repository = await parentRepository(canonical);
        const [branch, status] = await Promise.all([
          repository ? currentBranch(canonical) : null,
          repository ? readWorktreeStatus(canonical) : { changedFiles: null, comparison: null },
        ]);
        worktrees.push({ id: worktreeIdFromDirectoryName(path.basename(canonical)), root: canonical, repository, branch, status });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, roots.length) }, read));
    return [...new Map(worktrees.map((worktree) => [worktree.root, worktree])).values()]
      .sort((left, right) => left.root.localeCompare(right.root));
  }

  /** Resolves a caller-supplied path only after proving it sits under a root the app owns. */
  async ownedPath(root: string) {
    await this.assertOwned(root);
    return canonicalPath(root);
  }

  /**
   * Commits everything left in the worktree so a thread never loses work by walking away from it,
   * then gives the directory back. A worktree still detached has no branch holding its commits —
   * the snapshot's or the thread's own — so a ref under `refs/aicodingtool` keeps them reachable; once
   * the thread has made a branch, the branch does that job. The snapshot has to land before the
   * directory goes, so a failure there keeps both.
   */
  async release(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshot> {
    await this.assertOwned(request.root);
    if (request.missingOnly) {
      const exists = await lstat(request.root).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (exists) throw new Error("This folder exists again. Refresh the worktree list before deleting it.");
      await this.workspaces.forgetWorktree(await canonicalPath(request.root));
      return { commit: null, shortCommit: null, ref: null };
    }
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
   * A directory that is already gone, or whose repository is, has nothing to commit and nowhere to
   * keep it, and says so rather than failing. A detached checkout keeps its `refs/aicodingtool` ref even
   * with nothing left to commit: commits the thread made itself have no branch holding them either.
   */
  private async snapshot(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshot> {
    if (!(await directoryExists(request.root))) return { commit: null, shortCommit: null, ref: null };
    if (!(await parentRepository(request.root))) return { commit: null, shortCommit: null, ref: null };
    const ref = (await isDetached(request.root)) ? worktreeRef(request.worktreeId) : null;
    const commit = await snapshotCommit(request.root, snapshotMessage(request.title, request.taskId, request.release, ref));
    const kept = commit ?? (ref ? await unreachableHead(request.root) : null);
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
