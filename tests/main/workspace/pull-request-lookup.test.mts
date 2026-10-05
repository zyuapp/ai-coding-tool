import { temporaryDirectory } from "../../support/temporary-directory.mts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, symlink, writeFile } from "node:fs/promises";
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

/** A `gh` that answers every question with the one pull request it is given, beside the real `git`. */
async function pathWithGh(answer: unknown) {
  const bin = await pathWithoutGh();
  const gh = path.join(bin, "gh");
  /** Only `git` is on the path, so the answer is written with a builtin rather than `cat`. */
  await writeFile(gh, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(answer)}'\n`);
  await chmod(gh, 0o755);
  return bin;
}

test("an open pull request says where the checkout keeps its base and how many commits GitHub has not been sent", async () => {
  const root = await repository("https://github.com/o/r.git");
  await git(root, "update-ref", "refs/remotes/origin/release", "HEAD");
  await git(root, "checkout", "-b", "topic");
  await writeFile(path.join(root, "tracked.txt"), "two\n");
  await git(root, "commit", "-am", "pushed");
  const head = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(root, "tracked.txt"), "three\n");
  await git(root, "commit", "-am", "not pushed");
  const bin = await pathWithGh([{ number: 4, title: "Topic", url: "https://github.com/o/r/pull/4", state: "OPEN", isDraft: false, baseRefName: "release", headRefOid: head }]);
  const started = process.env.PATH;
  try {
    process.env.PATH = bin;
    const answer = await pullRequestFor(root);
    assert.equal(answer.status, "found");
    assert.deepEqual(answer.status === "found" ? answer.review : null, { baseRef: "origin/release", unpushed: 1 });
  } finally {
    process.env.PATH = started;
  }
});

test("a pull request whose base and head the checkout has never seen says nothing about either", async () => {
  const root = await repository("https://github.com/o/r.git");
  await git(root, "checkout", "-b", "elsewhere");
  const bin = await pathWithGh([{ number: 5, title: "Elsewhere", url: "https://github.com/o/r/pull/5", state: "OPEN", isDraft: false, baseRefName: "develop", headRefOid: "c".repeat(40) }]);
  const started = process.env.PATH;
  try {
    process.env.PATH = bin;
    const answer = await pullRequestFor(root);
    assert.equal(answer.status, "found");
    assert.equal(answer.status === "found" ? answer.review : null, undefined);
  } finally {
    process.env.PATH = started;
  }
});
