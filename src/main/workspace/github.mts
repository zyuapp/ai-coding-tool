import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pullRequestFromCommit, pullRequestFromList, type PullRequestRef } from "../../domain/pull-request.js";

const execFileAsync = promisify(execFile);

/** Room for one round trip to GitHub. Nothing waits on this, so a slower network simply has no answer. */
const TIMEOUT_MS = 5_000;

async function read(command: string, args: string[], cwd: string) {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, timeout: TIMEOUT_MS, encoding: "utf8" });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readJson(args: string[], cwd: string) {
  const output = await read("gh", args, cwd);
  if (output === null) return null;
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return null;
  }
}

/**
 * How long one answer stands in for the next asker. Threads that share a checkout ask about the same
 * branch, and a panel remounts whenever it is reopened, so without this each of those spawns its own
 * `gh`. Well under the poll interval, so a deliberate refresh still reaches GitHub.
 */
const CACHE_MS = 10_000;

type Cached = { at: number; ref: PullRequestRef | null };

const answers = new Map<string, Cached>();
const asking = new Map<string, Promise<PullRequestRef | null>>();

/** Keyed by what was asked, never by the checkout alone, so moving to another branch never reads the old answer. */
async function remembered(key: string, ask: () => Promise<PullRequestRef | null>) {
  const now = Date.now();
  for (const [known, cached] of answers) if (now - cached.at >= CACHE_MS) answers.delete(known);

  const cached = answers.get(key);
  if (cached) return cached.ref;

  const pending = asking.get(key) ?? ask().finally(() => asking.delete(key));
  asking.set(key, pending);
  const ref = await pending;
  answers.set(key, { at: Date.now(), ref });
  return ref;
}

/**
 * The pull request the checkout's work belongs to. A branch is asked about by name, so commits it
 * has not pushed yet still find it; a worktree is detached and has no name to give, so its commit is
 * asked about instead and only a pushed one is ever recognised.
 *
 * Null covers every way there might not be an answer — no pull request, no `gh`, no authentication,
 * no remote, a slow network. Nothing downstream tells those apart, so nothing here does either.
 */
export async function pullRequestFor(root: string): Promise<PullRequestRef | null> {
  const branch = await read("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (branch) {
    const fields = "number,title,url,state,isDraft";
    return await remembered(`${root}\0${branch}`, async () =>
      pullRequestFromList(await readJson(["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", fields], root)));
  }
  const commit = await read("git", ["rev-parse", "HEAD"], root);
  if (!commit) return null;
  return await remembered(`${root}\0${commit}`, async () =>
    pullRequestFromCommit(await readJson(["api", `repos/{owner}/{repo}/commits/${commit}/pulls`], root)));
}
