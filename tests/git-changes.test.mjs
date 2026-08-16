import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { changedFiles, summarizeNumstat } from "../dist/main/main/workspace/git-changes.mjs";
import { UnknownWorkspaceError } from "../dist/main/main/workspace/workspace-service.mjs";

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadline-git-"));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@example.com");
  await git(root, "config", "user.name", "Threadline Tests");
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  await git(root, "add", "tracked.txt");
  await git(root, "commit", "-m", "initial");
  return root;
}

function workspaces(root) {
  return { resolve: async () => ({ status: "available", workspace: { id: "fixture", kind: "project", root } }) };
}

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
  assert.equal(result.status, "available");
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
  const outside = await mkdtemp(path.join(os.tmpdir(), "threadline-outside-"));
  t.after(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });
  await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");
  await writeFile(path.join(root, "no-final-newline.txt"), "one\ntwo");
  await writeFile(path.join(root, "final-newline.txt"), "one\ntwo\n");
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "large.txt"), Buffer.alloc(5_000_001, 65));
  await writeFile(path.join(outside, "secret.txt"), "must\nnot\ncount\n");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "outside-link.txt"));

  const result = await changedFiles("fixture", workspaces(root));

  assert.equal(result.status, "available");
  assert.equal(result.branch, "main");
  assert.equal(result.additions, 5);
  assert.equal(result.deletions, 0);
  assert.deepEqual(new Set(result.files), new Set([" M tracked.txt", "?? binary.bin", "?? final-newline.txt", "?? large.txt", "?? no-final-newline.txt", "?? outside-link.txt"]));
});

test("changed files reports detached HEAD and non-Git failures", async (t) => {
  const root = await repository();
  const nonGit = await mkdtemp(path.join(os.tmpdir(), "threadline-not-git-"));
  t.after(async () => { await Promise.all([rm(root, { recursive: true, force: true }), rm(nonGit, { recursive: true, force: true })]); });
  const { stdout } = await git(root, "rev-parse", "--short", "HEAD");
  await git(root, "checkout", "--detach");

  const detached = await changedFiles("fixture", workspaces(root));
  const failed = await changedFiles("fixture", workspaces(nonGit));

  assert.equal(detached.status, "available");
  assert.equal(detached.branch, `detached@${stdout.trim()}`);
  assert.equal(failed.status, "error");
  assert.match(failed.message, /not a git repository/i);
});
