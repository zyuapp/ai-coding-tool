import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { adoptUserDataFolder } from "../src/main/user-data.ts";

const NAME = "AI Coding Tool";

async function appData() {
  return mkdtemp(path.join(os.tmpdir(), "aicodingtool-user-data-"));
}

async function seedLegacy(root: string, registry?: unknown) {
  const legacy = path.join(root, "Threadline");
  await mkdir(path.join(legacy, "attachments"), { recursive: true });
  await writeFile(path.join(legacy, "tasks.v3.sqlite"), "store");
  if (registry) await writeFile(path.join(legacy, "workspaces.v1.json"), JSON.stringify(registry, null, 2));
  return legacy;
}

test("the folder the app first shipped with is moved onto the name the app has now", async () => {
  const root = await appData();
  const legacy = await seedLegacy(root);

  const adopted = adoptUserDataFolder(root, NAME);

  assert.equal(adopted, path.join(root, NAME));
  assert.equal(existsSync(legacy), false);
  assert.equal(await readFile(path.join(adopted, "tasks.v3.sqlite"), "utf8"), "store");
  assert.equal(existsSync(path.join(adopted, "attachments")), true);
});

test("workspace roots inside the folder are repointed, and the ones outside it are left alone", async () => {
  const root = await appData();
  const legacy = await seedLegacy(root, {
    version: 1,
    workspaces: [
      { id: "a", kind: "projectless", root: path.join(root, "Threadline", "projectless") },
      { id: "b", kind: "worktree", root: path.join(root, "Threadline", "worktrees", "wt1") },
      { id: "c", kind: "project", root: "/Users/someone/workspace/thing" },
      { id: "d", kind: "project", root: `${legacyLookalike(root)}` },
    ],
  });

  const adopted = adoptUserDataFolder(root, NAME);
  const registry = JSON.parse(await readFile(path.join(adopted, "workspaces.v1.json"), "utf8")) as { workspaces: { root: string }[] };

  assert.deepEqual(registry.workspaces.map((workspace) => workspace.root), [
    path.join(adopted, "projectless"),
    path.join(adopted, "worktrees", "wt1"),
    "/Users/someone/workspace/thing",
    legacyLookalike(root),
  ]);
  assert.equal(existsSync(legacy), false);
});

test("a folder that already holds data keeps it, and the first one is left where it is", async (t) => {
  const root = await appData();
  const legacy = await seedLegacy(root);
  const occupied = path.join(root, NAME);
  await mkdir(occupied, { recursive: true });
  await writeFile(path.join(occupied, "tasks.v3.sqlite"), "newer store");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  t.onTestFinished(() => logged.mockRestore());

  assert.equal(adoptUserDataFolder(root, NAME), legacy);
  assert.equal(logged.mock.calls.length, 1);
  assert.equal(logged.mock.calls[0]?.[0], "Could not move the app data folder off its first name:");
  assert.match(String(logged.mock.calls[0]?.[1]), /already holds 1 file\(s\)/);
  assert.equal(existsSync(path.join(legacy, "tasks.v3.sqlite")), true);
  assert.equal(await readFile(path.join(occupied, "tasks.v3.sqlite"), "utf8"), "newer store");
});

test("an empty folder under the app's name is moved onto, since it holds nothing to lose", async () => {
  const root = await appData();
  await seedLegacy(root);
  await mkdir(path.join(root, NAME), { recursive: true });

  const adopted = adoptUserDataFolder(root, NAME);

  assert.equal(adopted, path.join(root, NAME));
  assert.equal(await readFile(path.join(adopted, "tasks.v3.sqlite"), "utf8"), "store");
});

test("a folder holding only the single-instance lock is moved onto, since the lock is remade", async () => {
  const root = await appData();
  await seedLegacy(root);
  const occupied = path.join(root, NAME);
  await mkdir(occupied, { recursive: true });
  for (const name of ["SingletonCookie", "SingletonSocket", ".DS_Store"]) await writeFile(path.join(occupied, name), "");
  await symlink("host-1234", path.join(occupied, "SingletonLock"));

  const adopted = adoptUserDataFolder(root, NAME);

  assert.equal(adopted, occupied);
  assert.equal(await readFile(path.join(adopted, "tasks.v3.sqlite"), "utf8"), "store");
  assert.equal(existsSync(path.join(adopted, "SingletonLock")), false);
});

test("a launch with no folder from the first name moves nothing", async () => {
  const root = await appData();

  const adopted = adoptUserDataFolder(root, NAME);

  assert.equal(adopted, path.join(root, NAME));
  assert.equal(existsSync(adopted), false);
});

/** A sibling whose path starts with the old folder's, which the move must not rewrite. */
function legacyLookalike(root: string) {
  return path.join(root, "Threadline-notes");
}
