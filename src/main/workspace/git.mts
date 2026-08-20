import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;
/** Checkout-scale work — populating or removing a worktree, committing a whole tree — takes as long as the tree is big. */
const LONG_TIMEOUT_MS = 600_000;
/** A worktree checkout can carry a large binary patch, so the pipe has to be bigger than the default. */
const MAX_BUFFER = 64 * 1024 * 1024;

export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;

  constructor(args: string[], message: string, exitCode: number | null = null) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
  }
}

/** Every git invocation in the app goes through here: no shell, one error shape, a bounded timeout. */
export async function git(cwd: string, args: string[], input?: string, timeoutMs = TIMEOUT_MS) {
  try {
    const child = execFileAsync("git", args, { cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: "buffer" });
    if (input !== undefined) {
      /** Git may exit before reading all of stdin; that failure is git's exit code, not a stream error. */
      child.child.stdin?.once("error", () => {});
      child.child.stdin?.end(input);
    }
    const { stdout } = await child;
    return stdout.toString("utf8");
  } catch (error) {
    const details = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (details.code === "ENOENT") throw new GitError(args, "Git is not installed or is not on the PATH.");
    const stderr = details.stderr ? details.stderr.toString().trim() : "";
    const exitCode = typeof details.code === "number" ? details.code : null;
    throw new GitError(args, stderr || details.message || `git ${args[0]} failed`, exitCode);
  }
}

async function tryGit(cwd: string, args: string[], timeoutMs?: number) {
  try {
    return await git(cwd, args, undefined, timeoutMs);
  } catch {
    return null;
  }
}

/** Refuses a caller-supplied name git would read as an option instead of a ref. */
function refArgument(name: string) {
  if (name.startsWith("-")) throw new GitError([name], `Invalid ref name: ${name}`);
  return name;
}

export async function headCommit(root: string, ref = "HEAD") {
  return (await git(root, ["rev-parse", refArgument(ref)])).trim();
}

export async function shortCommit(root: string, commit: string) {
  return (await git(root, ["rev-parse", "--short", commit])).trim();
}

/** True while the checkout has no branch, which is how a worktree starts and often stays. */
export async function isDetached(root: string) {
  return (await tryGit(root, ["symbolic-ref", "--quiet", "HEAD"])) === null;
}

export async function isDirty(root: string) {
  return (await git(root, ["status", "--porcelain", "-z"])).length > 0;
}

export async function repositoryRoot(root: string) {
  return (await git(root, ["rev-parse", "--show-toplevel"])).trim();
}

export async function addWorktree(repositoryPath: string, worktreePath: string, commit: string) {
  await git(repositoryPath, ["worktree", "add", "--detach", worktreePath, commit], undefined, LONG_TIMEOUT_MS);
}

export async function removeWorktree(repositoryPath: string, worktreePath: string) {
  await tryGit(repositoryPath, ["worktree", "remove", "--force", worktreePath], LONG_TIMEOUT_MS);
  await tryGit(repositoryPath, ["worktree", "prune"]);
}

/** Drops registrations whose directory is gone, which is what a checkout removed from outside leaves. */
export async function pruneWorktrees(repositoryPath: string) {
  await tryGit(repositoryPath, ["worktree", "prune"]);
}

export async function listWorktrees(repositoryPath: string) {
  const output = await git(repositoryPath, ["worktree", "list", "--porcelain"]);
  return output.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
}

/** Local branches, newest first, with the one the checkout is on. A detached head reports none. */
export async function listBranches(root: string) {
  const output = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]);
  const branches = output.split("\n").map((line) => line.trim()).filter(Boolean);
  const current = (await tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || null;
  return { branches, current };
}

/** Makes `branch` at the checkout's HEAD. Git refuses a name the repository already has. */
export async function createBranch(root: string, branch: string) {
  await git(root, ["branch", refArgument(branch)]);
}

/**
 * Moves the checkout onto `branch`. Never forced: Git refuses when the switch would overwrite
 * uncommitted work, and that refusal is the answer rather than something to override.
 */
export async function checkoutBranch(root: string, branch: string) {
  await git(root, ["checkout", refArgument(branch)]);
}

export async function updateRef(root: string, ref: string, commit: string) {
  await git(root, ["update-ref", ref, commit]);
}

/**
 * Commits everything in the checkout, hooks skipped: this runs when a thread is letting go of a
 * worktree, so a hook that rejects the snapshot would throw the work away instead of saving it.
 * Returns null when there was nothing to commit.
 */
export async function snapshotCommit(root: string, message: string) {
  if (!(await isDirty(root))) return null;
  await git(root, ["add", "-A"], undefined, LONG_TIMEOUT_MS);
  /** A machine with no git identity still gets its snapshot; the app signs it instead. */
  const identity = (await tryGit(root, ["var", "GIT_AUTHOR_IDENT"]))
    ? []
    : ["-c", "user.name=Claudex", "-c", "user.email=claudex@localhost"];
  await git(root, [...identity, "commit", "--no-verify", "-m", message], undefined, LONG_TIMEOUT_MS);
  return headCommit(root);
}

/** True when no branch, remote or tag holds `HEAD`, so removing the checkout would orphan its commits. */
export async function headIsUnreachable(root: string) {
  const output = await git(root, ["rev-list", "-n", "1", "HEAD", "--not", "--branches", "--remotes", "--tags"]);
  return output.trim().length > 0;
}

/** Ignored files present in the checkout. `--directory` collapses `node_modules/` into one entry. */
export async function ignoredPaths(root: string) {
  const output = await git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  return output.split("\0").filter(Boolean);
}

export async function untrackedPaths(root: string) {
  const output = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return output.split("\0").filter(Boolean);
}

/**
 * Which of `candidates` match the patterns in `patternFile`, decided by Git's own ignore matcher so
 * `.worktreeinclude` follows `.gitignore` syntax exactly — globs, anchoring, directory patterns and
 * `!` negation included. The patterns are read in an empty scratch repository, so only they apply.
 */
export async function matchIgnorePatterns(patternFile: string, candidates: string[]) {
  if (!candidates.length) return [];
  const scratch = await mkdtemp(path.join(os.tmpdir(), "claudex-match-"));
  try {
    await git(scratch, ["init", "-q", "."]);
    const output = await git(
      scratch,
      ["-c", `core.excludesFile=${patternFile}`, "check-ignore", "--no-index", "--stdin", "-z"],
      `${candidates.join("\0")}\0`,
    );
    return output.split("\0").filter(Boolean);
  } catch (error) {
    /** `check-ignore` exits 1 when no candidate matches, which is an answer rather than a failure. */
    if (error instanceof GitError && error.exitCode === 1) return [];
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The uncommitted work in a checkout, as a patch that applies onto the same commit elsewhere. */
export async function trackedDiff(root: string) {
  return git(root, ["diff", "--binary", "HEAD", "--"], undefined, LONG_TIMEOUT_MS);
}

export async function applyPatch(root: string, patch: string) {
  await git(root, ["apply", "--whitespace=nowarn", "-"], patch, LONG_TIMEOUT_MS);
}
