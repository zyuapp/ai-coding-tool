import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { compareVersions, isOlderThan, readVersion } from "../../../src/domain/engine-version.ts";
import { engineBinaryPath, installCommand, installedEngine } from "../../../src/main/agent/engine-binary.mts";

/** A stand-in command that prints a version, so no real engine is spawned. */
async function fakeEngine(command: string, version: string) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "engine-path-"));
  const executable = path.join(folder, command);
  await writeFile(executable, `#!/bin/sh\necho "${command}-cli ${version}"\n`);
  await chmod(executable, 0o755);
  return { folder, executable };
}

async function onPath<T>(folder: string, read: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  try {
    process.env.PATH = folder;
    return await read();
  } finally {
    process.env.PATH = original;
  }
}

test("a version is the first dotted number a command printed, whatever it wrapped it in", () => {
  assert.equal(readVersion("codex-cli 0.150.1"), "0.150.1");
  assert.equal(readVersion("2.1.250 (Claude Code)"), "2.1.250");
  assert.equal(readVersion("no numbers here"), null);
});

test("versions compare part by part, and a missing part counts as zero", () => {
  assert.ok(compareVersions("0.150.1", "0.149.0") > 0);
  assert.ok(compareVersions("0.9.0", "0.10.0") < 0, "parts are numbers, not text");
  assert.equal(compareVersions("2.1", "2.1.0"), 0);
  assert.ok(isOlderThan("0.147.0", "0.150.1"));
  assert.ok(!isOlderThan("0.150.1", "0.150.1"), "the baseline itself is not old");
  assert.ok(isOlderThan(null, "0.150.1"), "a command that would not say counts as old");
});

test("an engine is the command on the user's path, read for its version", async () => {
  const { folder, executable } = await fakeEngine("codex", "0.150.1");
  const found = await onPath(folder, () => installedEngine("codex"));
  assert.equal(found?.path, executable);
  assert.equal(found?.version, "0.150.1");
  assert.equal(found?.upgrade, "npm install -g @openai/codex@latest", "an install from nowhere known upgrades the way the engine documents");
});

test("an engine that is nowhere on the path is absent, and the app can say how to install it", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "engine-empty-"));
  assert.equal(await onPath(empty, async () => engineBinaryPath("claude")), undefined);
  assert.equal(await onPath(empty, () => installedEngine("claude")), undefined);
  assert.equal(installCommand("codex"), "brew install --cask codex");
  assert.equal(installCommand("claude"), "curl -fsSL https://claude.ai/install.sh | bash");
});

test("the upgrade command follows the launcher to the real file, so a cask upgrades through Homebrew", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-brew-"));
  const cask = path.join(root, "Caskroom", "codex", "0.150.1");
  await mkdir(cask, { recursive: true });
  const real = path.join(cask, "codex");
  await writeFile(real, "#!/bin/sh\necho 'codex-cli 0.150.1'\n");
  await chmod(real, 0o755);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await symlink(real, path.join(bin, "codex"));

  const found = await onPath(bin, () => installedEngine("codex"));
  assert.equal(found?.upgrade, "brew update && brew upgrade --cask codex");
});
