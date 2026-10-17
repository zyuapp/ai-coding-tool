import { temporaryDirectory } from "../../support/temporary-directory.mts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import { pullRequestFor } from "../../../src/main/workspace/github.mts";

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd: root });
}

/** A search path with `git` on it and nothing else, so `gh` is missing however the machine is set up. */
async function pathWithoutGh() {
  const bin = await temporaryDirectory(path.join(os.tmpdir(), "aicodingtool-bin-"));
  const found = (await execFileAsync("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  await symlink(found, path.join(bin, "git"));
  return bin;
}

async function repository(remote: string | null) {
  const root = await temporaryDirectory(path.join(os.tmpdir(), "aicodingtool-pr-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@example.com");
  await git(root, "config", "user.name", "AI Coding Tool Tests");
  await git(root, "config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
  if (remote) await git(root, "remote", "add", "origin", remote);
  return root;
}

test("a checkout on GitHub says so when gh is not installed, rather than saying it has no pull request", async () => {
  const [root, bin] = await Promise.all([repository("https://github.com/o/r.git"), pathWithoutGh()]);
  const started = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.deepEqual(await pullRequestFor(root), { status: "gh-missing" });
  } finally {
    process.env.PATH = started;
  }
});

test("a checkout with nowhere on GitHub to look loses nothing when gh is not installed", async () => {
  const [root, bin] = await Promise.all([repository("git@gitlab.com:o/r.git"), pathWithoutGh()]);
  const started = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.deepEqual(await pullRequestFor(root), { status: "none" });
  } finally {
    process.env.PATH = started;
  }
});

test("a checkout with no remote at all is a checkout with no pull request", async () => {
  const [root, bin] = await Promise.all([repository(null), pathWithoutGh()]);
  const started = process.env.PATH;
  try {
    process.env.PATH = bin;
    assert.deepEqual(await pullRequestFor(root), { status: "none" });
  } finally {
    process.env.PATH = started;
  }
});

/**
 * A search path whose `gh` answers the commit lookup with a pull request in `state`, and the details
 * view with what it still needs, writing down each thing it was asked.
 */
async function pathWithGh(state: "open" | "closed", mergedAt: string | null) {
  const bin = await pathWithoutGh();
  const log = path.join(bin, "asked.log");
  const found = JSON.stringify([{ number: 5, title: "Ship it", html_url: "https://github.com/o/r/pull/5", state, draft: false, merged_at: mergedAt }]);
  const details = JSON.stringify({ mergeable: "CONFLICTING", reviewDecision: "APPROVED", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }] });
  await writeFile(path.join(bin, "gh"), `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1" = api ]; then echo '${found}'; else echo '${details}'; fi\n`);
  await chmod(path.join(bin, "gh"), 0o755);
  return { bin, asked: async () => (await readFile(log, "utf8")).trim().split("\n") };
}

async function detached() {
  const root = await repository("https://github.com/o/r.git");
  await git(root, "checkout", "--detach");
  return root;
}

test("a worktree's open pull request is asked what it still needs, and a merged one is not", async () => {
  const started = process.env.PATH;
  try {
    const [root, gh] = await Promise.all([detached(), pathWithGh("open", null)]);
    process.env.PATH = gh.bin;
    assert.deepEqual(await pullRequestFor(root), {
      status: "found",
      pullRequest: { number: 5, title: "Ship it", url: "https://github.com/o/r/pull/5", state: "open", checks: "failing", review: "approved", conflicts: true },
    });
    const commit = (await git(root, "rev-parse", "HEAD")).stdout.trim();
    assert.deepEqual(await gh.asked(), [`api repos/{owner}/{repo}/commits/${commit}/pulls`, "pr view 5 --json mergeable,reviewDecision,statusCheckRollup"]);

    const [merged, done] = await Promise.all([detached(), pathWithGh("closed", "2026-10-01T00:00:00Z")]);
    process.env.PATH = done.bin;
    assert.equal((await pullRequestFor(merged)).status, "found");
    assert.equal((await done.asked()).some((asked) => asked.startsWith("pr view")), false, "a merged pull request needs nothing more");
  } finally {
    process.env.PATH = started;
  }
});
