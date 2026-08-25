import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  const bin = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-bin-"));
  const found = (await execFileAsync("/bin/sh", ["-c", "command -v git"])).stdout.trim();
  await symlink(found, path.join(bin, "git"));
  return bin;
}

async function repository(remote: string | null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-pr-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@example.com");
  await git(root, "config", "user.name", "AI Coding Tool Tests");
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
