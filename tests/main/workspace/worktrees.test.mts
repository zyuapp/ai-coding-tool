import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, afterAll, describe } from "vitest";
import { promisify } from "node:util";
import { WorktreeService } from "../../../src/main/workspace/worktrees.mts";
import { checkoutBranch, createBranch, isDetached, listBranches, listWorktrees } from "../../../src/main/workspace/git.mts";
import type { WorkspaceRecord } from "../../../src/domain/workspace.ts";

const execFileAsync = promisify(execFile);

/**
 * Every fixture lives under a fresh temporary directory and is removed afterwards, so a test never
 * reaches a real project, a real worktree root, or the developer's own git configuration.
 */
const scratch: string[] = [];

async function temporaryDirectory(prefix: string) {
  /** Resolved, because git reports real paths and macOS hands out a symlinked temporary root. */
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `aicodingtool-${prefix}-`)));
  scratch.push(directory);
  return directory;
}

afterAll(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

async function git(root: string, ...args: string[]) {
  return execFileAsync("git", args, { cwd: root });
}

async function repository() {
  const root = await temporaryDirectory("repo");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "tests@example.com");
  await git(root, "config", "user.name", "AI Coding Tool Tests");
  await git(root, "config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  await writeFile(path.join(root, ".gitignore"), "secrets/\n.env\n*.log\n");
  await git(root, "add", "-A");
  await git(root, "commit", "-m", "initial");
  return root;
}

/** A registry stand-in, recording what the service registers and forgets. */
function workspaces() {
  let sequence = 0;
  const records = new Map<string, WorkspaceRecord>();
  return {
    records,
    registerWorktree: async (root: string) => {
      const workspace = { id: `workspace-${++sequence}`, kind: "worktree" as const, root };
      records.set(root, workspace);
      return { status: "available" as const, workspace };
    },
    forgetWorktree: async (root: string) => { records.delete(root); },
  };
}

async function service(registry = workspaces()) {
  const worktreesRoot = await temporaryDirectory("worktrees");
  return Object.assign(new WorktreeService({ worktreesRoot, workspaces: registry }), { testRoot: worktreesRoot, testRegistry: registry });
}

async function exists(target: string) {
  return stat(target).then(() => true, () => false);
}

describe("creating a worktree", { concurrent: true }, () => {

test("a worktree starts detached at whatever the project has checked out", async () => {
  const root = await repository();
  const head = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  const worktrees = await service();

  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });

  assert.equal(worktree.baseCommit, head);
  assert.equal(await isDetached(worktree.root), true);
  assert.equal(await exists(path.join(worktree.root, "tracked.txt")), true);
  assert.ok(worktree.workspaceId);
  assert.deepEqual(await listWorktrees(root), [root, worktree.root]);
});

test("a worktree follows the branch the project is on, not the default one", async () => {
  const root = await repository();
  await git(root, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(root, "tracked.txt"), "two\n");
  await git(root, "commit", "-qam", "feature work");
  const featureHead = (await git(root, "rev-parse", "HEAD")).stdout.trim();
  const worktrees = await service();

  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });

  assert.equal(worktree.baseCommit, featureHead);
  assert.equal(await readFile(path.join(worktree.root, "tracked.txt"), "utf8"), "two\n");
});

test("worktreeinclude copies the ignored files it names and nothing else", async () => {
  const root = await repository();
  await writeFile(path.join(root, ".env"), "TOKEN=abc\n");
  await writeFile(path.join(root, "debug.log"), "noise\n");
  await mkdir(path.join(root, "secrets"), { recursive: true });
  await writeFile(path.join(root, "secrets", "key.pem"), "private\n");
  await writeFile(path.join(root, ".worktreeinclude"), ".env\nsecrets/\n");
  const worktrees = await service();

  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });

  assert.equal(await readFile(path.join(worktree.root, ".env"), "utf8"), "TOKEN=abc\n");
  assert.equal(await readFile(path.join(worktree.root, "secrets", "key.pem"), "utf8"), "private\n");
  assert.equal(await exists(path.join(worktree.root, "debug.log")), false, "an ignored file the patterns do not name stays behind");
});

test("worktreeinclude never duplicates a tracked file", async () => {
  const root = await repository();
  await writeFile(path.join(root, ".worktreeinclude"), "tracked.txt\n");
  const worktrees = await service();

  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });

  assert.equal(await readFile(path.join(worktree.root, "tracked.txt"), "utf8"), "one\n", "the checkout's own copy is untouched");
});

test("worktreeinclude honours negation the way gitignore does", async () => {
  const root = await repository();
  await writeFile(path.join(root, ".env"), "TOKEN=abc\n");
  await writeFile(path.join(root, "keep.log"), "keep\n");
  await writeFile(path.join(root, "drop.log"), "drop\n");
  await writeFile(path.join(root, ".worktreeinclude"), "*.log\n!drop.log\n");
  const worktrees = await service();

  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });

  assert.equal(await exists(path.join(worktree.root, "keep.log")), true);
  assert.equal(await exists(path.join(worktree.root, "drop.log")), false);
  assert.equal(await exists(path.join(worktree.root, ".env")), false, "only the named patterns are copied");
});

test("a moving thread carries its uncommitted work and leaves the checkout alone", async () => {
  const root = await repository();
  await writeFile(path.join(root, "tracked.txt"), "edited\n");
  await writeFile(path.join(root, "fresh.txt"), "new file\n");
  const worktrees = await service();

  const worktree = await worktrees.create({ projectRoot: root, carryChanges: true });

  assert.equal(await readFile(path.join(worktree.root, "tracked.txt"), "utf8"), "edited\n");
  assert.equal(await readFile(path.join(worktree.root, "fresh.txt"), "utf8"), "new file\n");
  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "edited\n", "the project checkout keeps its own copy");
  assert.equal(await exists(path.join(root, "fresh.txt")), true);
});

test("a new thread's worktree starts clean even when the checkout is dirty", async () => {
  const root = await repository();
  await writeFile(path.join(root, "tracked.txt"), "edited\n");
  const worktrees = await service();

  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });

  assert.equal(await readFile(path.join(worktree.root, "tracked.txt"), "utf8"), "one\n");
});

test("a moving thread carries untracked symlinks as symlinks", async () => {
  const root = await repository();
  await symlink("tracked.txt", path.join(root, "link.txt"));
  const worktrees = await service();

  const worktree = await worktrees.create({ projectRoot: root, carryChanges: true });

  assert.equal(await readlink(path.join(worktree.root, "link.txt")), "tracked.txt");
});

test("worktrees of the same project stay independent", async () => {
  const root = await repository();
  const worktrees = await service();

  const first = await worktrees.create({ projectRoot: root, carryChanges: false });
  const second = await worktrees.create({ projectRoot: root, carryChanges: false });
  await writeFile(path.join(first.root, "tracked.txt"), "first\n");

  assert.notEqual(first.root, second.root);
  assert.equal(await readFile(path.join(second.root, "tracked.txt"), "utf8"), "one\n");
  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "one\n");
});

test("branch names git would read as options are refused", async () => {
  const root = await repository();

  await assert.rejects(createBranch(root, "--force"), /Invalid ref name/);
  await assert.rejects(checkoutBranch(root, "-b"), /Invalid ref name/);
});
});

describe("releasing a worktree", { concurrent: true }, () => {

test("releasing a detached worktree commits its work and keeps it reachable by ref", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await writeFile(path.join(worktree.root, "tracked.txt"), "worktree work\n");
  await writeFile(path.join(worktree.root, "added.txt"), "also new\n");

  const snapshot = await worktrees.release({
    worktreeId: worktree.id,
    root: worktree.root,
    taskId: "thread-1",
    title: "Rename dock tabs",
    release: "returned-to-local",
  });

  assert.ok(snapshot.commit);
  assert.equal(snapshot.ref, `refs/aicodingtool/${worktree.id}`);
  const message = (await git(root, "log", "-1", "--format=%B", snapshot.commit)).stdout;
  assert.match(message, /^aicodingtool: snapshot "Rename dock tabs"/);
  assert.match(message, /Thread thread-1 · returned to local/);

  /** The commit outlives the directory, which is the whole point of the ref. */
  assert.equal(await exists(worktree.root), false, "a released worktree leaves no directory behind");
  assert.deepEqual(await listWorktrees(root), [root], "and no registration either");
  assert.equal(worktrees.testRegistry.records.size, 0, "and no workspace record");
  const preserved = (await git(root, "show", "--format=%H", "-s", snapshot.ref)).stdout.trim();
  assert.equal(preserved, snapshot.commit);
  const files = (await git(root, "show", "--name-only", "--format=", snapshot.commit)).stdout;
  assert.match(files, /tracked.txt/);
  assert.match(files, /added.txt/);
});

test("releasing a clean worktree commits nothing", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });

  const snapshot = await worktrees.release({
    worktreeId: worktree.id,
    root: worktree.root,
    taskId: "thread-2",
    title: "Nothing to save",
    release: "returned-to-local",
  });

  assert.deepEqual(snapshot, { commit: null, shortCommit: null, ref: null });
});

test("releasing a clean worktree keeps commits the thread made while detached", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await writeFile(path.join(worktree.root, "tracked.txt"), "committed detached\n");
  await git(worktree.root, "commit", "-qam", "detached work");
  const head = (await git(worktree.root, "rev-parse", "HEAD")).stdout.trim();

  const snapshot = await worktrees.release({
    worktreeId: worktree.id,
    root: worktree.root,
    taskId: "thread-2b",
    title: "Committed but detached",
    release: "returned-to-local",
  });

  assert.equal(snapshot.commit, null, "there was nothing left to commit");
  assert.equal(snapshot.ref, `refs/aicodingtool/${worktree.id}`);
  const preserved = (await git(root, "rev-parse", snapshot.ref)).stdout.trim();
  assert.equal(preserved, head, "the thread's own commits stay reachable after the directory goes");
});

test("a branch the thread made holds the snapshot itself, so no ref is written", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await git(worktree.root, "checkout", "-q", "-b", "thread-work");
  await writeFile(path.join(worktree.root, "tracked.txt"), "on a branch\n");

  const snapshot = await worktrees.release({
    worktreeId: worktree.id,
    root: worktree.root,
    taskId: "thread-3",
    title: "Branched work",
    release: "returned-to-local",
  });

  assert.ok(snapshot.commit);
  assert.equal(snapshot.ref, null);
  const branchHead = (await git(root, "rev-parse", "thread-work")).stdout.trim();
  assert.equal(branchHead, snapshot.commit);
});

test("a snapshot commit survives a hook that rejects commits", async () => {
  const root = await repository();
  const hooks = path.join(root, ".git", "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await writeFile(path.join(worktree.root, "tracked.txt"), "must not be lost\n");

  const snapshot = await worktrees.release({
    worktreeId: worktree.id,
    root: worktree.root,
    taskId: "thread-4",
    title: "Hook says no",
    release: "returned-to-local",
  });

  assert.ok(snapshot.commit, "the snapshot is not a normal commit; a hook must not be able to discard the work");
});

test("releasing a worktree whose directory is already gone still tidies up after it", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await rm(worktree.root, { recursive: true, force: true });

  const snapshot = await worktrees.release({
    worktreeId: worktree.id,
    root: worktree.root,
    taskId: "thread-5",
    title: "Removed from underneath",
    release: "returned-to-local",
  });

  assert.deepEqual(snapshot, { commit: null, shortCommit: null, ref: null }, "there is nothing left to commit");
  assert.equal(worktrees.testRegistry.records.size, 0, "the thread is free of it either way");
});
});

describe("deleting a worktree", { concurrent: true }, () => {

test("deleting a worktree takes its uncommitted work and leaves branches alone", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await git(worktree.root, "checkout", "-q", "-b", "kept-branch");
  await writeFile(path.join(worktree.root, "tracked.txt"), "committed on the branch\n");
  await git(worktree.root, "commit", "-qam", "branch work");
  await writeFile(path.join(worktree.root, "tracked.txt"), "never committed\n");

  await worktrees.delete(worktree.root);

  assert.equal(await exists(worktree.root), false);
  assert.deepEqual(await listWorktrees(root), [root]);
  const branch = (await git(root, "rev-parse", "--verify", "kept-branch")).stdout.trim();
  assert.ok(branch, "a branch the thread created outlives the worktree");
  const kept = (await git(root, "show", "kept-branch:tracked.txt")).stdout;
  assert.equal(kept, "committed on the branch\n");
});

test("a worktree whose repository is gone can still be deleted", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await rm(root, { recursive: true, force: true });

  await worktrees.delete(worktree.root);

  assert.equal(await exists(worktree.root), false, "the directory goes even with no git to remove it");
  assert.equal(worktrees.testRegistry.records.size, 0);
});

test("release and delete refuse a directory outside the worktrees root", async () => {
  const root = await repository();
  const worktrees = await service();

  await assert.rejects(worktrees.delete(root), /Not an AI Coding Tool worktree/);
  await assert.rejects(
    worktrees.release({ worktreeId: "x", root, taskId: null, title: "elsewhere", release: "deleted" }),
    /Not an AI Coding Tool worktree/,
  );
  assert.equal(await exists(path.join(root, "tracked.txt")), true, "the refused directory is untouched");
});
});

describe("listing worktrees", { concurrent: true }, () => {

test("the manual list includes current and legacy app-owned worktrees without changing them", async () => {
  const root = await repository();
  const legacyRoot = await temporaryDirectory("legacy-worktrees");
  const registry = workspaces();
  const before = new WorktreeService({ worktreesRoot: legacyRoot, workspaces: registry });
  const legacy = await before.create({ projectRoot: root, carryChanges: false });

  const worktreesRoot = await temporaryDirectory("worktrees");
  const moved = new WorktreeService({ worktreesRoot, legacyRoots: [legacyRoot], workspaces: registry });
  const made = await moved.create({ projectRoot: root, carryChanges: false });
  const listed = await moved.list();

  assert.equal(path.dirname(made.root), worktreesRoot, "new checkouts only ever land in the current root");
  assert.deepEqual(listed.map((worktree) => worktree.root), [legacy.root, made.root].sort());
  assert.equal(listed.every((worktree) => worktree.repository === root && worktree.branch === null), true);
  assert.equal(await exists(legacy.root), true, "listing never removes an old checkout");
  assert.equal(await exists(made.root), true, "listing never removes a current checkout");
  await moved.delete(legacy.root);
  assert.equal(await exists(legacy.root), false, "the old checkout remains manually removable");
});
});

test("branches report the current branch and a detached checkout", async () => {
  const root = await repository();

  assert.equal((await listBranches(root)).current, "main");
  await git(root, "checkout", "-q", "--detach");

  const detached = await listBranches(root);
  assert.equal(detached.current, null);
  assert.ok(detached.branches.includes("main"));
});

test("listing counts renames and untracked files, and compares detached commits without changing Git", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await git(worktree.root, "commit", "--allow-empty", "-m", "detached work");
  await git(worktree.root, "mv", "tracked.txt", "renamed\nfile.txt");
  await mkdir(path.join(worktree.root, "new"));
  await writeFile(path.join(worktree.root, "new", "one.txt"), "one");
  await writeFile(path.join(worktree.root, "new", "two.txt"), "two");
  await writeFile(path.join(worktree.root, ".env"), "ignored");
  const before = (await git(worktree.root, "status", "--porcelain=v1", "-z", "--untracked-files=all")).stdout;
  const [listed] = await worktrees.list();
  assert.equal(listed.branch, null);
  assert.deepEqual(listed.status, { changedFiles: 3, comparison: { branch: "main", ahead: 1 } });
  assert.equal((await git(worktree.root, "status", "--porcelain=v1", "-z", "--untracked-files=all")).stdout, before);
});

test("listing compares with the locally recorded origin default branch and reports included commits", async () => {
  const root = await repository();
  await git(root, "update-ref", "refs/remotes/origin/trunk", "HEAD");
  await git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await git(worktree.root, "checkout", "-b", "feature");
  const [listed] = await worktrees.list();
  assert.equal(listed.branch, "feature");
  assert.deepEqual(listed.status, { changedFiles: 0, comparison: { branch: "origin/trunk", ahead: 0 } });
});

test("listing keeps unknown comparisons and unavailable repositories distinct from clean worktrees", async () => {
  const root = await repository();
  await git(root, "branch", "-m", "trunk");
  const worktrees = await service();
  await worktrees.create({ projectRoot: root, carryChanges: false });
  const orphan = path.join(worktrees.testRoot, "orphan");
  await mkdir(orphan);
  await writeFile(path.join(orphan, "important.txt"), "preserve");
  const listed = await worktrees.list();
  const valid = listed.find((item) => item.repository === root);
  assert.deepEqual(valid?.status, { changedFiles: 0, comparison: null });
  const invalid = listed.find((item) => item.root === orphan);
  assert.equal(invalid?.repository, null);
  assert.deepEqual(invalid?.status, { changedFiles: null, comparison: null });
  assert.equal(await readFile(path.join(orphan, "important.txt"), "utf8"), "preserve");
});

test("forgetting refuses a folder that exists and only drops registration after the folder is gone", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  const request = { worktreeId: worktree.id, root: worktree.root, taskId: null, title: "Missing folder", release: "deleted" as const, missingOnly: true };
  await assert.rejects(worktrees.release(request), /folder exists again/);
  assert.equal(await readFile(path.join(worktree.root, "tracked.txt"), "utf8"), "one\n");
  assert.equal(worktrees.testRegistry.records.has(worktree.root), true);
  await rm(worktree.root, { recursive: true });
  assert.deepEqual(await worktrees.release(request), { commit: null, shortCommit: null, ref: null });
  assert.equal(worktrees.testRegistry.records.has(worktree.root), false);
});

test("a root that cannot be listed fails the scan rather than reporting its folders missing", async () => {
  const root = await temporaryDirectory("not-directory");
  const file = path.join(root, "file");
  await writeFile(file, "not a directory");
  const worktrees = new WorktreeService({ worktreesRoot: file, workspaces: workspaces() });
  await assert.rejects(worktrees.list(), /ENOTDIR/);
});
