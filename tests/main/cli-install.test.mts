import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  assert.deepEqual(await installer.install(), { state: "installed", path: configuration.installPath, onPath: true, current: true });
  assert.equal(await readFile(configuration.installPath, "utf8"), configuration.script);
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
  assert.deepEqual(await installer.install(), { state: "installed", path: configuration.installPath, onPath: true, current: true });
  assert.equal((await lstat(configuration.installPath)).isFile(), true);
  assert.equal(await readFile(protectedFile, "utf8"), "user data");
});

test("Linux CLI status tells settings when the user-local bin folder is not on PATH", async () => {
  const { configuration, installer } = await linuxInstaller("/usr/bin:/bin");
  assert.deepEqual(await installer.install(), { state: "installed", path: configuration.installPath, onPath: false, current: true });
});

test("unsupported platforms report status and refuse changes", async () => {
  const installer = createCliInstaller(null, "win32");
  assert.deepEqual(await installer.status(), { state: "unsupported", path: "/usr/local/bin/aic" });
  await assert.rejects(installer.install(), /macOS or Linux/);
  await assert.rejects(installer.uninstall(), /macOS or Linux/);
  assert.equal((await installer.refresh()).state, "unsupported");
});

for (const platform of ["linux", "darwin"]) {
  test.skipIf(process.getuid?.() === 0)(`${platform} refresh silently preserves a stale launcher when its directory is protected`, async () => {
    const { configuration } = await linuxInstaller();
    const installer = createCliInstaller(configuration, platform);
    await installer.install();
    const stale = "#!/bin/sh\n# aic-cli v1\n";
    await writeFile(configuration.installPath, stale);
    const directory = path.dirname(configuration.installPath);
    await chmod(directory, 0o555);
    try {
      const before = await installer.status();
      assert.equal(before.current, false);
      assert.deepEqual(await installer.refresh(), before);
      assert.equal(await readFile(configuration.installPath, "utf8"), stale);
    } finally {
      await chmod(directory, 0o755);
    }
    assert.equal((await installer.install()).current, true, "Settings can still explicitly update the launcher");
  });

  test(`${platform} refresh repairs a launcher after the installed app moves, without rewriting a current one`, async () => {
    const { configuration } = await linuxInstaller();
    const old = cliConfiguration(platform, os.homedir(), "/old/app");
    const next = cliConfiguration(platform, os.homedir(), "/new/app");
    assert.ok(old && next);
    const previous = createCliInstaller({ ...old, installPath: configuration.installPath }, platform);
    const updated = createCliInstaller({ ...next, installPath: configuration.installPath }, platform);
    await previous.install();
    assert.equal((await updated.status()).current, false);
    assert.equal((await updated.refresh()).current, true);
    assert.equal(await readFile(configuration.installPath, "utf8"), next.script);
    const before = await stat(configuration.installPath);
    await updated.refresh();
    const after = await stat(configuration.installPath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });

  test(`${platform} refresh leaves absent, unrelated, and symlinked commands alone`, async () => {
    const { configuration } = await linuxInstaller();
    const installer = createCliInstaller(configuration, platform);
    assert.equal((await installer.refresh()).state, "missing");
    await assert.rejects(lstat(configuration.installPath), { code: "ENOENT" });
    await mkdir(path.dirname(configuration.installPath), { recursive: true });
    await writeFile(configuration.installPath, "another command");
    assert.equal((await installer.refresh()).state, "conflict");
    assert.equal(await readFile(configuration.installPath, "utf8"), "another command");
    await rm(configuration.installPath);
    const other = `${configuration.installPath}-other`;
    await writeFile(other, "# aic-cli v1\n");
    await symlink(other, configuration.installPath);
    assert.equal((await installer.refresh()).state, "conflict");
    assert.equal((await lstat(configuration.installPath)).isSymbolicLink(), true);
    assert.equal(await readFile(other, "utf8"), "# aic-cli v1\n");
    await installer.uninstall();
    assert.equal((await installer.refresh()).state, "missing");
  });
}

test.skipIf(process.platform !== "darwin")("elevated CLI command uses exact embedded bytes and replaces destination symlinks", async () => {
  const { cliInstallCommand } = await import("../../src/main/cli-install.ts");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { configuration } = await linuxInstaller();
  const root = path.dirname(path.dirname(configuration.installPath));
  const victim = path.join(root, "victim");
  await mkdir(victim, { recursive: true });
  await writeFile(path.join(victim, "aic"), "preserve");
  const target = { ...configuration, installPath: path.join(root, "aic ' $(false)"), script: "#!/bin/sh\nprintf '%s' 'literal `$HOME` $(false)'\n" };
  await symlink(victim, target.installPath);
  await promisify(execFile)("/bin/sh", ["-c", cliInstallCommand(target)]);
  assert.equal(await readFile(target.installPath, "utf8"), target.script);
  assert.equal((await lstat(target.installPath)).isSymbolicLink(), false);
  assert.equal(await readFile(path.join(victim, "aic"), "utf8"), "preserve");
  assert.equal((await stat(target.installPath)).mode & 0o777, 0o755);
});
