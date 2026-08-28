import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { compareVersions, isOlderThan, readVersion } from "../../../src/domain/engine-version.ts";
import type { EngineReadiness } from "../../../src/domain/agent-engine.ts";
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

test("an answer with every engine in place is kept, and one with an engine missing is read again", async () => {
  const { EngineAccessHost } = await import("../../../src/main/agent/engine-services.mts");
  const answers: EngineReadiness[] = [
    { access: "missing", fix: "brew install --cask codex" },
    { access: "ready", version: "0.150.1" },
    { access: "ready", version: "0.150.1" },
  ];
  let reads = 0;
  let paths = 0;
  const readiness = async () => {
    reads += 1;
    return answers.shift() ?? { access: "ready" };
  };
  const host = new EngineAccessHost(
    { claude: { readiness: async () => ({ access: "ready" }) }, codex: { readiness } },
    async () => { paths += 1; },
  );

  assert.equal((await host.read()).codex?.access, "missing");
  assert.equal(paths, 0, "the first read is the path the app started with");

  assert.equal((await host.read()).codex?.access, "ready", "an engine the user had to fix is read again");
  assert.equal(paths, 1, "and the shell is read again, so a fresh install off the old path is found");

  await host.read();
  assert.equal(reads, 2, "an answer where every engine is in place is kept, since asking runs the commands");
  assert.equal((await host.read(true)).codex?.access, "ready");
  assert.equal(reads, 3, "asking outright always asks");
});

test("two asks at once run the engine commands once", async () => {
  const { EngineAccessHost } = await import("../../../src/main/agent/engine-services.mts");
  let reads = 0;
  const host = new EngineAccessHost(
    {
      claude: { readiness: async () => ({ access: "ready" }) },
      codex: {
        readiness: async () => {
          reads += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { access: "ready" };
        },
      },
    },
    async () => {},
  );

  const [first, second] = await Promise.all([host.read(), host.read()]);
  assert.deepEqual(first, second);
  assert.equal(reads, 1);
});
