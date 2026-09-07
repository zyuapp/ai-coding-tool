import type { WorktreeStatus } from "../../domain/worktree.js";
import { git } from "./git.mjs";

/** A rename occupies two NUL-delimited records but represents one changed file. */
export function countChangedFiles(output: string) {
  const records = output.split("\0");
  let count = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    count++;
    if (/[RC]/.test(record.slice(0, 2))) index++;
  }
  return count;
}

async function comparison(root: string): Promise<WorktreeStatus["comparison"]> {
  const remoteHead = await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], undefined, 5_000).catch(() => null);
  const candidates = new Set([remoteHead?.trim(), "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]);
  for (const ref of candidates) {
    if (!ref) continue;
    const commit = await git(root, ["rev-parse", "--verify", `${ref}^{commit}`], undefined, 5_000).catch(() => null);
    if (!commit) continue;
    const output = await git(root, ["rev-list", "--count", "HEAD", "--not", commit.trim(), "--"], undefined, 5_000).catch(() => null);
    if (output === null || !/^\d+$/.test(output.trim())) return null;
    return { branch: ref.replace(/^refs\/(heads|remotes)\//, ""), ahead: Number(output.trim()) };
  }
  return null;
}

export async function readWorktreeStatus(root: string): Promise<WorktreeStatus> {
  const [changedFiles, compared] = await Promise.all([
    git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], undefined, 5_000)
      .then(countChangedFiles, () => null),
    comparison(root),
  ]);
  return { changedFiles, comparison: compared };
}
