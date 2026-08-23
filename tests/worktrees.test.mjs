import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { WorktreeService } from "../dist/main/main/workspace/worktrees.mjs";
import { checkoutBranch, createBranch, isDetached, listBranches, listWorktrees } from "../dist/main/main/workspace/git.mjs";

const execFileAsync = promisify(execFile);

/**
 * Every fixture lives under a fresh temporary directory and is removed afterwards, so a test never
 * reaches a real project, a real worktree root, or the developer's own git configuration.
 */
const scratch = [];

async function temporaryDirectory(prefix) {
  /** Resolved, because git reports real paths and macOS hands out a symlinked temporary root. */
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), `aicodingtool-${prefix}-`)));
  scratch.push(directory);
  return directory;
}

test.after(async () => {
  for (const directory of scratch) await rm(directory, { recursive: true, force: true });
});

async function git(root, ...args) {
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
  const records = new Map();
  const forgottenBatches = [];
  return {
    records,
    forgottenBatches,
    registerWorktree: async (root) => {
      const workspace = { id: `workspace-${++sequence}`, kind: "worktree", root };
      records.set(root, workspace);
      return { status: "available", workspace };
    },
    listWorktrees: async () => [...records.values()],
    forgetWorktree: async (root) => { records.delete(root); },
    forgetWorktrees: async (roots) => {
      forgottenBatches.push([...roots]);
      for (const root of roots) records.delete(root);
    },
  };
}

async function service(registry = workspaces()) {
  const worktreesRoot = await temporaryDirectory("worktrees");
  return Object.assign(new WorktreeService({ worktreesRoot, workspaces: registry }), { worktreesRoot, registry });
}

async function exists(target) {
  return stat(target).then(() => true, () => false);
}

test.describe("worktrees", { concurrency: true }, () => {
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
  assert.equal(worktrees.registry.records.size, 0, "and no workspace record");
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
  assert.equal(worktrees.registry.records.size, 0);
});

test("release and delete refuse a directory outside the worktrees root", async () => {
  const root = await repository();
  const worktrees = await service();

  await assert.rejects(worktrees.delete(root), /Not an AI Coding Tool worktree/);
  await assert.rejects(
    worktrees.release({ worktreeId: "x", root, taskId: null, title: "elsewhere", release: "evicted" }),
    /Not an AI Coding Tool worktree/,
  );
  assert.equal(await exists(path.join(root, "tracked.txt")), true, "the refused directory is untouched");
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
  assert.equal(worktrees.registry.records.size, 0, "the thread is free of it either way");
});

test("a reconcile reaps the checkouts no thread claims and keeps the ones that are claimed", async () => {
  const root = await repository();
  const worktrees = await service();
  const claimed = await worktrees.create({ projectRoot: root, carryChanges: false });
  const abandoned = await worktrees.create({ projectRoot: root, carryChanges: false });
  await writeFile(path.join(abandoned.root, "tracked.txt"), "work nobody claims\n");

  const { reaped } = await worktrees.reconcile({ claimed: [claimed.root], repositories: [root] });

  assert.deepEqual(reaped, [abandoned.root]);
  assert.equal(await exists(claimed.root), true, "a checkout its thread still claims is left alone");
  assert.equal(await exists(abandoned.root), false);
  assert.deepEqual(await listWorktrees(root), [root, claimed.root]);
  const preserved = (await git(root, "show", `refs/aicodingtool/${abandoned.id}:tracked.txt`)).stdout;
  assert.equal(preserved, "work nobody claims\n", "what it held is committed before it goes");
});

test("a reconcile forgets registrations whose directory was removed from outside", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await rm(worktree.root, { recursive: true, force: true });

  await worktrees.reconcile({ claimed: [worktree.root], repositories: [root] });

  assert.equal(worktrees.registry.records.size, 0, "the registry never outgrows the disk");
  assert.deepEqual(await listWorktrees(root), [root], "and neither does git's own list");
});

test("a reconcile reaps a checkout whose repository is gone", async () => {
  const root = await repository();
  const worktrees = await service();
  const worktree = await worktrees.create({ projectRoot: root, carryChanges: false });
  await rm(root, { recursive: true, force: true });

  const { reaped } = await worktrees.reconcile({ claimed: [], repositories: [] });

  assert.deepEqual(reaped, [worktree.root]);
  assert.equal(await exists(worktree.root), false, "a checkout git cannot read does not linger forever");
});

test("a reconcile recognises a claimed checkout through a symlinked path", async () => {
  const root = await repository();
  const worktrees = await service();
  const claimed = await worktrees.create({ projectRoot: root, carryChanges: false });
  const link = path.join(await temporaryDirectory("link"), "worktrees");
  await symlink(worktrees.worktreesRoot, link);

  const { reaped } = await worktrees.reconcile({
    claimed: [path.join(link, path.basename(claimed.root))],
    repositories: [root],
  });

  assert.deepEqual(reaped, [], "a live worktree is never evicted over how its path is spelled");
  assert.equal(await exists(claimed.root), true);
});

test("branch names git would read as options are refused", async () => {
  const root = await repository();

  await assert.rejects(createBranch(root, "--force"), /Invalid ref name/);
  await assert.rejects(checkoutBranch(root, "-b"), /Invalid ref name/);
});

test("a checkout under the root the app used before is still reconciled and still owned", async () => {
  const root = await repository();
  const legacyRoot = await temporaryDirectory("legacy-worktrees");
  const registry = workspaces();
  const before = new WorktreeService({ worktreesRoot: legacyRoot, workspaces: registry });
  const claimed = await before.create({ projectRoot: root, carryChanges: false });
  const abandoned = await before.create({ projectRoot: root, carryChanges: false });

  const worktreesRoot = await temporaryDirectory("worktrees");
  const moved = new WorktreeService({ worktreesRoot, legacyRoots: [legacyRoot], workspaces: registry });
  const made = await moved.create({ projectRoot: root, carryChanges: false });
  const { reaped } = await moved.reconcile({ claimed: [claimed.root, made.root], repositories: [root] });

  assert.equal(path.dirname(made.root), worktreesRoot, "new checkouts only ever land in the current root");
  assert.deepEqual(reaped, [abandoned.root], "and the old root is swept the same way the current one is");
  assert.equal(await exists(claimed.root), true, "a checkout its thread still claims is left where it is");
  await moved.delete(claimed.root);
  assert.equal(await exists(claimed.root), false, "a thread can still hand back a checkout made before the move");
});

test("a reconcile leaves a worktrees root that has never been used alone", async () => {
  const root = await repository();
  const worktrees = await service();

  const { reaped } = await worktrees.reconcile({ claimed: [], repositories: [root] });

  assert.deepEqual(reaped, []);
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

test("a reconcile forgets every missing registry root in one batch", async () => {
  const worktreesRoot = await temporaryDirectory("batch-forget-worktrees");
  const missing = [path.join(worktreesRoot, "missing-a"), path.join(worktreesRoot, "missing-b")];
  const registry = workspaces();
  for (const [index, root] of missing.entries()) registry.records.set(root, { id: `workspace-${index}`, kind: "worktree", root });
  const worktrees = new WorktreeService({ worktreesRoot, workspaces: registry, prune: async () => {} });

  const result = await worktrees.reconcile({ claimed: [], repositories: [] });

  assert.deepEqual(result, { reaped: [] });
  assert.deepEqual(registry.forgottenBatches, [missing]);
  assert.equal(registry.records.size, 0);
});

test("a reconcile prunes independent repositories four at a time and waits for every one", async () => {
  const worktreesRoot = await temporaryDirectory("prune-worktrees");
  const repositories = Array.from({ length: 9 }, (_, index) => `/repository-${index}`);
  let active = 0;
  let peak = 0;
  const completed = [];
  const worktrees = new WorktreeService({
    worktreesRoot,
    workspaces: workspaces(),
    prune: async (repository) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed.push(repository);
      active -= 1;
    },
  });

  const result = await worktrees.reconcile({ claimed: [], repositories });

  assert.deepEqual(result, { reaped: [] });
  assert.equal(peak, 4);
  assert.equal(active, 0, "reconcile resolves only after the last prune finishes");
  assert.deepEqual([...completed].sort(), [...repositories].sort());
});

test("a failed prune drains active work and stops scheduling more repositories", async () => {
  const worktreesRoot = await temporaryDirectory("failed-prune-worktrees");
  const repositories = Array.from({ length: 8 }, (_, index) => `/repository-${index}`);
  const failure = new Error("prune failed");
  const started = [];
  let active = 0;
  const worktrees = new WorktreeService({
    worktreesRoot,
    workspaces: workspaces(),
    prune: async (repository) => {
      started.push(repository);
      active += 1;
      try {
        await new Promise((resolve) => setTimeout(resolve, repository === repositories[1] ? 5 : 15));
        if (repository === repositories[1]) throw failure;
      } finally {
        active -= 1;
      }
    },
  });

  await assert.rejects(worktrees.reconcile({ claimed: [], repositories }), (error) => error === failure);

  assert.deepEqual(started, repositories.slice(0, 4));
  assert.equal(active, 0, "the rejection waits for every prune already in flight");
});
