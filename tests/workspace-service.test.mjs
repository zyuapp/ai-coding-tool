import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  UnknownWorkspaceError,
  WorkspaceService,
} from "../dist/main/main/workspace/workspace-service.mjs";

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-workspaces-"));
  return {
    directory,
    registryPath: path.join(directory, "state", "workspaces.json"),
    projectlessRoot: path.join(directory, "scratch"),
  };
}

test("registers canonical projects and reuses their opaque ID", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const project = path.join(directory, "project");
  const alias = path.join(directory, "project-alias");
  await mkdir(project);
  await symlink(project, alias);

  const service = new WorkspaceService({ registryPath, projectlessRoot });
  const first = await service.registerProject(alias);
  const second = await service.registerProject(project);

  assert.equal(first.status, "available");
  assert.equal(second.status, "available");
  assert.equal(first.workspace.id, second.workspace.id);
  assert.equal(first.workspace.root, await realpath(project));
  assert.match(first.workspace.id, /^[0-9a-f-]{36}$/);
});

test("reloads the registry and resolves the same workspace after restart", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const project = path.join(directory, "project");
  await mkdir(project);

  const first = new WorkspaceService({ registryPath, projectlessRoot });
  const registered = await first.registerProject(project);
  const second = new WorkspaceService({ registryPath, projectlessRoot });
  const resolved = await second.resolve(registered.workspace.id);

  assert.deepEqual(resolved, registered);
  assert.match(await readFile(registryPath, "utf8"), new RegExp(registered.workspace.id));
  assert.equal((await readdir(path.dirname(registryPath))).some((entry) => entry.endsWith(".tmp")), false);
});

test("serializes concurrent registrations without losing a workspace", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const firstProject = path.join(directory, "first");
  const secondProject = path.join(directory, "second");
  await Promise.all([mkdir(firstProject), mkdir(secondProject)]);
  const service = new WorkspaceService({ registryPath, projectlessRoot });
  const registered = await Promise.all([service.registerProject(firstProject), service.registerProject(secondProject)]);
  const reloaded = new WorkspaceService({ registryPath, projectlessRoot });
  const resolved = await Promise.all(registered.map(({ workspace }) => reloaded.resolve(workspace.id)));
  assert.deepEqual(resolved, registered);
});

test("forgets several worktrees together while preserving other workspace kinds and the single-root API", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const firstRoot = path.join(directory, "first-worktree");
  const secondRoot = path.join(directory, "second-worktree");
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
  const service = new WorkspaceService({ registryPath, projectlessRoot });
  const project = await service.registerProject(firstRoot);
  const first = await service.registerWorktree(firstRoot);
  const second = await service.registerWorktree(secondRoot);

  await service.forgetWorktrees([first.workspace.root, second.workspace.root, first.workspace.root, path.join(directory, "unknown")]);

  assert.deepEqual(await service.listWorktrees(), []);
  assert.deepEqual(await service.resolve(project.workspace.id), project, "a project at the same root is not a worktree registration");
  const replacement = await service.registerWorktree(secondRoot);
  await service.forgetWorktree(replacement.workspace.root);
  await assert.rejects(() => service.resolve(replacement.workspace.id), UnknownWorkspaceError);
  assert.deepEqual(await new WorkspaceService({ registryPath, projectlessRoot }).listWorktrees(), []);
});

test("rolls back an in-memory registration when persistence fails", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const project = path.join(directory, "project");
  await mkdir(project);
  const service = new WorkspaceService({ registryPath, projectlessRoot });
  await assert.rejects(() => service.resolve("probe"), UnknownWorkspaceError);
  await mkdir(registryPath, { recursive: true });
  await assert.rejects(() => service.registerProject(project));
  await rmdir(registryPath);
  const registered = await service.registerProject(project);
  const reloaded = new WorkspaceService({ registryPath, projectlessRoot });
  assert.deepEqual(await reloaded.resolve(registered.workspace.id), registered);
});

test("preserves a malformed registry and recovers with a new atomic registry", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const project = path.join(directory, "project");
  await mkdir(project);
  await mkdir(path.dirname(registryPath), { recursive: true });
  const malformed = "{not-json";
  await writeFile(registryPath, malformed, "utf8");

  const service = new WorkspaceService({ registryPath, projectlessRoot });
  const registered = await service.registerProject(project);
  const entries = await readdir(path.dirname(registryPath));
  const preserved = entries.filter((entry) => entry.startsWith("workspaces.json.corrupt.") && entry.endsWith(".json"));

  assert.equal(registered.status, "available");
  assert.ok(preserved.length >= 1);
  assert.equal(await readFile(path.join(path.dirname(registryPath), preserved[0]), "utf8"), malformed);
  assert.match(await readFile(registryPath, "utf8"), new RegExp(registered.workspace.id));
});

test("creates and reloads an explicit projectless workspace", async () => {
  const { registryPath, projectlessRoot } = await setup();
  const first = new WorkspaceService({ registryPath, projectlessRoot });
  const registered = await first.getProjectless();
  const second = new WorkspaceService({ registryPath, projectlessRoot });
  const reloaded = await second.getProjectless();

  assert.equal(registered.status, "available");
  assert.equal(registered.workspace.kind, "projectless");
  assert.equal(registered.workspace.root, await realpath(projectlessRoot));
  assert.equal(reloaded.workspace.id, registered.workspace.id);
});

test("rejects unknown IDs and preserves missing roots as unavailable", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const project = path.join(directory, "project");
  await mkdir(project);
  const service = new WorkspaceService({ registryPath, projectlessRoot });
  const registered = await service.registerProject(project);
  await rename(project, `${project}-moved`);

  await assert.rejects(() => service.resolve("unknown-workspace"), UnknownWorkspaceError);
  const missing = await service.resolve(registered.workspace.id);
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.reason, "missing");
  assert.equal(missing.workspace.id, registered.workspace.id);
});

test("detects registered roots replaced by a symlink or regular file", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const linkedProject = path.join(directory, "linked-project");
  const linkedProjectOriginal = path.join(directory, "linked-project-original");
  const replacement = path.join(directory, "replacement");
  const fileProject = path.join(directory, "file-project");
  await Promise.all([mkdir(linkedProject), mkdir(replacement), mkdir(fileProject)]);
  const service = new WorkspaceService({ registryPath, projectlessRoot });
  const linked = await service.registerProject(linkedProject);
  const file = await service.registerProject(fileProject);

  await rename(linkedProject, linkedProjectOriginal);
  await symlink(replacement, linkedProject);
  await rm(fileProject, { recursive: true });
  await writeFile(fileProject, "not a directory");

  const changed = await service.resolve(linked.workspace.id);
  const notDirectory = await service.resolve(file.workspace.id);
  assert.equal(changed.status, "unavailable");
  assert.equal(changed.reason, "changed");
  assert.equal(notDirectory.status, "unavailable");
  assert.equal(notDirectory.reason, "not-directory");
});

test("preserves valid JSON with an invalid registry shape before recovery", async () => {
  const { directory, registryPath, projectlessRoot } = await setup();
  const project = path.join(directory, "project");
  await mkdir(project);
  await mkdir(path.dirname(registryPath), { recursive: true });
  const malformed = JSON.stringify({ version: 1, workspaces: [{ id: "bad", root: "", kind: "project" }] });
  await writeFile(registryPath, malformed);

  const registered = await new WorkspaceService({ registryPath, projectlessRoot }).registerProject(project);
  const entries = await readdir(path.dirname(registryPath));
  const preserved = entries.find((entry) => entry.startsWith("workspaces.json.corrupt."));

  assert.equal(registered.status, "available");
  assert.ok(preserved);
  assert.equal(await readFile(path.join(path.dirname(registryPath), preserved), "utf8"), malformed);
});
