import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { isPathInside, isWritePathInside, openableFile } from "../../src/main/path-policy.mts";

test("file edits stay inside the selected project", () => {
  assert.equal(isPathInside("/tmp/project", "/tmp/project/file.txt"), true);
  assert.equal(isPathInside("/tmp/project", "/tmp/project"), true);
  assert.equal(isPathInside("/tmp/project", "/tmp/project-copy/file.txt"), false);
  assert.equal(isPathInside("/tmp/project", "/tmp/elsewhere/file.txt"), false);
});

test("canonical write targets stay inside the selected project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-path-policy-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-path-policy-outside-"));
  const inside = path.join(root, "src");
  const outsideFile = path.join(outside, "outside.txt");
  const targetLink = path.join(root, "target-link");
  const parentLink = path.join(root, "parent-link");
  const loopA = path.join(root, "loop-a");
  const loopB = path.join(root, "loop-b");

  await mkdir(inside);
  await writeFile(outsideFile, "outside");
  await symlink(outsideFile, targetLink);
  await symlink(outside, parentLink);
  await symlink(loopB, loopA);
  await symlink(loopA, loopB);

  assert.equal(await isWritePathInside(root, path.join(root, "src", "file.txt")), true);
  assert.equal(await isWritePathInside(root, "src/new-file.txt"), true);
  assert.equal(await isWritePathInside(root, "../outside.txt"), false);
  assert.equal(
    await isWritePathInside(root, path.join(path.dirname(root), `${path.basename(root)}-copy`, "file.txt")),
    false,
  );
  assert.equal(await isWritePathInside(root, path.join(root, "src", "..", "..", "outside.txt")), false);
  assert.equal(await isWritePathInside(root, targetLink), false);
  assert.equal(await isWritePathInside(root, path.join(parentLink, "new.txt")), false);
  assert.equal(await isWritePathInside(root, path.join(loopA, "new.txt")), false);
});

test("a file a message named is looked for in every checkout the thread can reach", async () => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "aicodingtool-file-link-")));
  const project = path.join(home, "repo");
  const worktree = path.join(home, "repo-w1");
  const outside = path.join(home, "notes");

  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(worktree, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(project, "src", "App.tsx"), "project");
  await writeFile(path.join(worktree, "src", "App.tsx"), "worktree");
  await writeFile(path.join(worktree, "only-here.ts"), "worktree");
  await writeFile(path.join(outside, "plan.md"), "outside");

  assert.equal(
    await openableFile([worktree, project], "src/App.tsx"),
    path.join(worktree, "src", "App.tsx"),
    "the checkout the thread works in answers first",
  );
  assert.equal(
    await openableFile([project, worktree], "only-here.ts"),
    path.join(worktree, "only-here.ts"),
    "a file only another checkout of the project has is still found",
  );
  assert.equal(
    await openableFile([worktree, project], path.join(project, "src", "App.tsx")),
    path.join(project, "src", "App.tsx"),
    "a file named in full is that file, not the thread's own copy of it",
  );
  assert.equal(
    await openableFile([worktree], path.join(home, "gone", "src", "App.tsx")),
    path.join(worktree, "src", "App.tsx"),
    "a path under a folder that is not there is looked for in the checkout",
  );
  assert.equal(
    await openableFile([project], path.join(outside, "plan.md")),
    path.join(outside, "plan.md"),
    "a real file outside every checkout still opens",
  );
  assert.equal(
    await openableFile([project], "repo/src/App.tsx"),
    path.join(project, "src", "App.tsx"),
    "a path written from the folder above the checkout is found",
  );

  await assert.rejects(openableFile([project], "src/Missing.tsx"), /could not find src\/Missing.tsx/);
  await assert.rejects(openableFile([project], "src"), /could not find src/, "a folder is not a file to open");
  await assert.rejects(openableFile("/repo", "src/App.tsx"), /Invalid folder/);
  await assert.rejects(openableFile([project], ""), /Invalid file path/);
});
