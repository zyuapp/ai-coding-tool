import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { cliConfiguration } from "../../src/domain/cli.ts";
import { createCliInstaller } from "../../src/main/cli-install.ts";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function linuxInstaller(searchPath?: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), "aicodingtool-cli-"));
  temporary.push(home);
  const configuration = cliConfiguration("linux", home);
  assert.ok(configuration);
  const effectivePath = searchPath ?? `${path.dirname(configuration.installPath)}${path.delimiter}/usr/bin`;
  return { configuration, installer: createCliInstaller(configuration, "linux", () => effectivePath) };
}

test("Linux CLI status, install, conflict detection, and uninstall use a user-writable path", async () => {
  const { configuration, installer } = await linuxInstaller();
  assert.deepEqual(await installer.status(), { state: "missing", path: configuration.installPath, onPath: true });

  assert.deepEqual(await installer.install(), { state: "installed", path: configuration.installPath, onPath: true });
  assert.match(await readFile(configuration.installPath, "utf8"), /exec xdg-open/);
  assert.equal((await stat(configuration.installPath)).mode & 0o777, 0o755);

  await writeFile(configuration.installPath, "#!/bin/sh\necho somebody-else\n", "utf8");
  assert.deepEqual(await installer.status(), { state: "conflict", path: configuration.installPath, onPath: true });
  assert.deepEqual(await installer.uninstall(), { state: "missing", path: configuration.installPath, onPath: true });
});

test("Linux CLI install replaces a symlink itself without writing through it", async () => {
  const { configuration, installer } = await linuxInstaller();
  const protectedFile = path.join(path.dirname(path.dirname(configuration.installPath)), "keep-me");
  await mkdir(path.dirname(configuration.installPath), { recursive: true });
  await writeFile(protectedFile, "user data", "utf8");
  await symlink(protectedFile, configuration.installPath);

  assert.deepEqual(await installer.status(), { state: "conflict", path: configuration.installPath, onPath: true });
  assert.equal((await lstat(configuration.installPath)).isSymbolicLink(), true);
  assert.deepEqual(await installer.install(), { state: "installed", path: configuration.installPath, onPath: true });
  assert.equal((await lstat(configuration.installPath)).isFile(), true);
  assert.equal(await readFile(protectedFile, "utf8"), "user data");
});

test("Linux CLI status tells settings when the user-local bin folder is not on PATH", async () => {
  const { configuration, installer } = await linuxInstaller("/usr/bin:/bin");
  assert.deepEqual(await installer.install(), { state: "installed", path: configuration.installPath, onPath: false });
});

test("unsupported platforms report status and refuse changes", async () => {
  const installer = createCliInstaller(null, "win32");
  assert.deepEqual(await installer.status(), { state: "unsupported", path: "/usr/local/bin/aic" });
  await assert.rejects(installer.install(), /macOS or Linux/);
  await assert.rejects(installer.uninstall(), /macOS or Linux/);
});
