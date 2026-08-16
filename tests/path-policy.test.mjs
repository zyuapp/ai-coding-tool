import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInside, isWritePathInside } from "../dist/main/main/path-policy.mjs";

test("file edits stay inside the selected project", () => {
  assert.equal(isPathInside("/tmp/project", "/tmp/project/file.txt"), true);
  assert.equal(isPathInside("/tmp/project", "/tmp/project"), true);
  assert.equal(isPathInside("/tmp/project", "/tmp/project-copy/file.txt"), false);
  assert.equal(isPathInside("/tmp/project", "/tmp/elsewhere/file.txt"), false);
});

test("canonical write targets stay inside the selected project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadline-path-policy-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "threadline-path-policy-outside-"));
  const inside = path.join(root, "src");
  const outsideFile = path.join(outside, "outside.txt");
  const targetLink = path.join(root, "target-link");
  const parentLink = path.join(root, "parent-link");

  await mkdir(inside);
  await writeFile(outsideFile, "outside");
  await symlink(outsideFile, targetLink);
  await symlink(outside, parentLink);

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
});
