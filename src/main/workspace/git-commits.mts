import { COMMIT_PAGE_SIZE, isCommitHistoryRequest, type CommitHistoryRequest, type CommitHistoryResult, type CommitSummary } from "../../domain/commit-history.js";
import { git, GitError } from "./git.mjs";

const FORMAT = "%H%x00%s%x00%an%x00%cI";

function summaries(output: string): CommitSummary[] {
  const fields = output.split("\0");
  const commits: CommitSummary[] = [];
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const sha = fields[index].trim();
    if (!/^[a-f\d]{40}$/i.test(sha)) continue;
    commits.push({ sha, subject: fields[index + 1].slice(0, 500), author: fields[index + 2].slice(0, 200), committedAt: fields[index + 3].trim() });
  }
  return commits;
}

async function currentHead(root: string) {
  try {
    return (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim();
  } catch (error) {
    if (!(error instanceof GitError) || error.exitCode !== 1) throw error;
    /** An unborn branch has no history; a folder that is not a repository has an error. */
    await git(root, ["rev-parse", "--git-dir"]);
    return null;
  }
}

/** A hash search stays inside this checkout's history, just as browsing the list does. */
async function matchingHash(root: string, head: string, query: string) {
  if (!/^[a-f\d]{7,40}$/i.test(query)) return null;
  try {
    const sha = (await git(root, ["rev-parse", "--verify", "--quiet", `${query}^{commit}`])).trim();
    if (!sha.toLowerCase().startsWith(query.toLowerCase())) return null;
    await git(root, ["merge-base", "--is-ancestor", sha, head]);
    return sha;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    return null;
  }
}

/** Git searches the history; only a bounded page of metadata crosses into the renderer. */
export async function commitHistory(root: string, request: CommitHistoryRequest): Promise<CommitHistoryResult> {
  if (!isCommitHistoryRequest(request)) return { status: "error", message: "Invalid commit search." };
  try {
    const head = request.head ?? await currentHead(root);
    if (!head) return { status: "available", commits: [], head: null, offset: 0, hasMore: false };
    const query = request.query.trim();
    const hash = query ? await matchingHash(root, head, query) : null;
    const args = ["log", "--no-show-signature", "--no-decorate", "-z", `--format=${FORMAT}`];
    if (hash) {
      const commits = request.offset === 0 ? summaries(await git(root, [...args, "--max-count=1", hash, "--"])) : [];
      return { status: "available", commits, head, offset: request.offset, hasMore: false };
    }
    const output = await git(root, [
      ...args, `--max-count=${COMMIT_PAGE_SIZE + 1}`, `--skip=${request.offset}`,
      ...(query ? ["--fixed-strings", "--regexp-ignore-case", `--grep=${query}`] : []), head, "--",
    ]);
    const commits = summaries(output);
    return { status: "available", commits: commits.slice(0, COMMIT_PAGE_SIZE), head, offset: request.offset, hasMore: commits.length > COMMIT_PAGE_SIZE };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
