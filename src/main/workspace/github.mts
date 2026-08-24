import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pullRequestFromCommit, pullRequestFromList, type PullRequestAnswer, type PullRequestRef } from "../../domain/pull-request.js";

const execFileAsync = promisify(execFile);

/** Room for one round trip to GitHub. Nothing waits on this, so a slower network simply has no answer. */
const TIMEOUT_MS = 5_000;

const NONE: PullRequestAnswer = { status: "none" };

/** What a command said, and whether it said nothing because it is not installed at all. */
type Output = { text: string | null; missing: boolean };

async function run(command: string, args: string[], cwd: string): Promise<Output> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd, timeout: TIMEOUT_MS, encoding: "utf8" });
    return { text: stdout.trim() || null, missing: false };
  } catch (error) {
    return { text: null, missing: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
}

async function read(command: string, args: string[], cwd: string) {
  return (await run(command, args, cwd)).text;
}

async function readJson(args: string[], cwd: string): Promise<{ value: unknown; missing: boolean }> {
  const { text, missing } = await run("gh", args, cwd);
  if (text === null) return { value: null, missing };
  try {
    return { value: JSON.parse(text) as unknown, missing: false };
  } catch {
    return { value: null, missing: false };
  }
}

/** Only a checkout that has somewhere on GitHub to look loses anything when `gh` is not installed. */
async function onGitHub(root: string) {
  const remotes = await read("git", ["remote", "-v"], root);
  return remotes !== null && remotes.includes("github.com");
}

async function answerFrom(root: string, found: { value: unknown; missing: boolean }, parse: (value: unknown) => PullRequestRef | null): Promise<PullRequestAnswer> {
  if (found.missing) return (await onGitHub(root)) ? { status: "gh-missing" } : NONE;
  const pullRequest = parse(found.value);
  return pullRequest ? { status: "found", pullRequest } : NONE;
}

/**
 * How long one answer stands in for the next asker. Threads that share a checkout ask about the same
 * branch, and a panel remounts whenever it is reopened, so without this each of those spawns its own
 * `gh`. Well under the poll interval, so a deliberate refresh still reaches GitHub.
 */
const CACHE_MS = 10_000;

type Cached = { at: number; answer: PullRequestAnswer };

const answers = new Map<string, Cached>();
const asking = new Map<string, Promise<PullRequestAnswer>>();

/** Keyed by what was asked, never by the checkout alone, so moving to another branch never reads the old answer. */
async function remembered(key: string, ask: () => Promise<PullRequestAnswer>) {
  const now = Date.now();
  for (const [known, cached] of answers) if (now - cached.at >= CACHE_MS) answers.delete(known);

  const cached = answers.get(key);
  if (cached) return cached.answer;

  const pending = asking.get(key) ?? ask().finally(() => asking.delete(key));
  asking.set(key, pending);
  const answer = await pending;
  answers.set(key, { at: Date.now(), answer });
  return answer;
}

/**
 * The pull request the checkout's work belongs to. A branch is asked about by name, so commits it
 * has not pushed yet still find it; a worktree is detached and has no name to give, so its commit is
 * asked about instead and only a pushed one is ever recognised.
 *
 * "None" covers every way there might not be an answer — no pull request, no authentication, no
 * remote, a slow network. A `gh` that is not installed is the one exception: nothing could be asked
 * at all, and a checkout on GitHub is told that rather than told it has no pull request.
 */
export async function pullRequestFor(root: string): Promise<PullRequestAnswer> {
  const branch = await read("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  if (branch) {
    const fields = "number,title,url,state,isDraft";
    return await remembered(`${root}\0${branch}`, async () =>
      answerFrom(root, await readJson(["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", fields], root), pullRequestFromList));
  }
  const commit = await read("git", ["rev-parse", "HEAD"], root);
  if (!commit) return NONE;
  return await remembered(`${root}\0${commit}`, async () =>
    answerFrom(root, await readJson(["api", `repos/{owner}/{repo}/commits/${commit}/pulls`], root), pullRequestFromCommit));
}
