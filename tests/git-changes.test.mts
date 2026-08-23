import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, describe } from "vitest";
import { promisify } from "node:util";
import { changedFiles, summarizeNumstat } from "../src/main/workspace/git-changes.mts";
import { UnknownWorkspaceError } from "../src/main/workspace/workspace-service.mts";
import type { WorkspaceResolution } from "../src/domain/workspace.ts";

const execFileAsync = promisify(execFile);

async function git(root: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-git-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@example.com");
  await git(root, "config", "user.name", "AI Coding Tool Tests");
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
  return root;
}

function workspaces(root: string) {
  return { resolve: async (): Promise<WorkspaceResolution> => ({ status: "available", workspace: { id: "fixture", kind: "project", root } }) };
}

function assertAvailable<T extends { status: string }>(result: T): asserts result is Extract<T, { status: "available" }> {
  assert.equal(result.status, "available");
}

describe("Git changes", { concurrent: true }, () => {
test("changed files distinguishes unknown workspaces", async () => {
  const result = await changedFiles("missing", { resolve: async () => { throw new UnknownWorkspaceError("missing"); } });
  assert.deepEqual(result, { status: "unknown", workspaceId: "missing" });
});

test("changed files distinguishes workspace resolution failures", async () => {
  const result = await changedFiles("broken", { resolve: async () => { throw new Error("registry unavailable"); } });
  assert.deepEqual(result, { status: "error", message: "registry unavailable" });
});

test("changed files distinguishes unavailable workspaces", async () => {
  const result = await changedFiles("gone", { resolve: async () => ({ status: "unavailable", workspace: { id: "gone", kind: "project", root: "/tmp/gone" }, reason: "missing" }) });
  assert.deepEqual(result, { status: "unavailable", reason: "missing" });
});

test("changed files returns an available file list through the Git adapter", async () => {
  const result = await changedFiles("current", { resolve: async () => ({ status: "available", workspace: { id: "current", kind: "project", root: process.cwd() } }) });
  assertAvailable(result);
  assert.ok(Array.isArray(result.files));
  assert.equal(typeof result.additions, "number");
  assert.equal(typeof result.deletions, "number");
  assert.ok(result.branch === null || typeof result.branch === "string");
});

test("numstat totals ignore binary files and renamed path records", () => {
  const output = ["12\t3\tsrc/a.ts", "-\t-\timage.png", "4\t1\t", "old.ts", "new.ts", ""].join("\0");
  assert.deepEqual(summarizeNumstat(output), { additions: 16, deletions: 4 });
});

test("changed files reports exact Git summary including safe untracked line counts", async (t) => {
  const root = await repository();
  const outside = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-outside-"));
  t.onTestFinished(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");
  await writeFile(path.join(root, "no-final-newline.txt"), "one\ntwo");
  await writeFile(path.join(root, "final-newline.txt"), "one\ntwo\n");
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "large.txt"), Buffer.alloc(5_000_001, 65));
  await writeFile(path.join(outside, "secret.txt"), "must\nnot\ncount\n");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "outside-link.txt"));

  const result = await changedFiles("fixture", workspaces(root));

  assertAvailable(result);
  assert.equal(result.branch, "main");
  assert.equal(result.baseline, null);
  assert.equal(result.additions, 5);
  assert.equal(result.deletions, 0);
  assert.deepEqual(new Set(result.files), new Set([" M tracked.txt", "?? binary.bin", "?? final-newline.txt", "?? large.txt", "?? no-final-newline.txt", "?? outside-link.txt"]));
});

test("untracked line counting keeps every file beyond one worker pool", async (t) => {
  const root = await repository();
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const files = Array.from({ length: 24 }, (_item, index) => `fresh-${String(index).padStart(2, "0")}.txt`);
  await Promise.all(files.map((file, index) => writeFile(path.join(root, file), "line\n".repeat(index + 1))));

  const result = await changedFiles("fixture", workspaces(root));

  assertAvailable(result);
  assert.equal(result.additions, 300);
  assert.equal(result.deletions, 0);
  assert.deepEqual(result.files, files.map((file) => `?? ${file}`));
});

test("changed files counts committed work against the origin default branch", async (t) => {
  const root = await repository();
  const origin = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-origin-"));
  t.onTestFinished(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(origin, { recursive: true, force: true })]); });
  await git(origin, "init", "--bare", "-b", "main");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "origin", "main");
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");
  await git(root, "commit", "-am", "committed by the thread");
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(root, "untracked.txt"), "four\n");

  const result = await changedFiles("fixture", workspaces(root));

  assertAvailable(result);
  assert.equal(result.baseline, "origin/main");
  assert.equal(result.additions, 3);
  assert.equal(result.deletions, 0);
});

test("comparison bases are cached within one repository and never shared across roots", async (t) => {
  const root = await repository();
  const other = await repository();
  const origin = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-origin-"));
  t.onTestFinished(async () => { await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(other, { recursive: true, force: true }),
    rm(origin, { recursive: true, force: true }),
  ]); });
  await git(origin, "init", "--bare", "-b", "main");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "origin", "main");

  const first = await changedFiles("fixture", workspaces(root));
  await git(root, "update-ref", "-d", "refs/remotes/origin/main");
  const cached = await changedFiles("fixture", workspaces(root));
  const unrelated = await changedFiles("fixture", workspaces(other));

  assertAvailable(first);
  assert.equal(first.baseline, "origin/main");
  assertAvailable(cached);
  assert.equal(cached.baseline, "origin/main", "the cached commit outlives a ref disappearing between polls");
  assertAvailable(unrelated);
  assert.equal(unrelated.baseline, null, "another root does not inherit the first repository's base");
});

test("a cached comparison base follows a new HEAD", async (t) => {
  const root = await repository();
  const origin = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-origin-"));
  t.onTestFinished(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(origin, { recursive: true, force: true })]); });
  await git(origin, "init", "--bare", "-b", "main");
  await git(root, "remote", "add", "origin", origin);
  await git(root, "push", "origin", "main");
  const initial = await changedFiles("fixture", workspaces(root));
  assertAvailable(initial);
  assert.equal(initial.baseline, "origin/main");

  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");
  await git(root, "commit", "-am", "advance main");
  await git(root, "push", "origin", "main");
  await git(root, "checkout", "-b", "feature");
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\nthree\n");
  await git(root, "commit", "-am", "feature work");

  const result = await changedFiles("fixture", workspaces(root));
  assertAvailable(result);
  assert.equal(result.branch, "feature");
  assert.equal(result.baseline, "origin/main");
  assert.equal(result.additions, 1, "the new branch is compared with its own merge base");
});

test("changed files reports detached HEAD and non-Git failures", async (t) => {
  const root = await repository();
  const nonGit = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-not-git-"));
  t.onTestFinished(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(nonGit, { recursive: true, force: true })]); });
  const { stdout } = await git(root, "rev-parse", "--short", "HEAD");
  await git(root, "checkout", "--detach");

  const detached = await changedFiles("fixture", workspaces(root));
  const failed = await changedFiles("fixture", workspaces(nonGit));

  assertAvailable(detached);
  assert.equal(detached.branch, `detached@${stdout.trim()}`);
  assert.equal(failed.status, "error");
  assert.match(failed.message, /not a git repository/i);
});
});
