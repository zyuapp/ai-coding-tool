import { temporaryDirectory } from "../../support/temporary-directory.mts";
import assert from "node:assert/strict";
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { compareVersions, isOlderThan, readVersion } from "../../../src/domain/engine-version.ts";
import type { EngineReadiness } from "../../../src/domain/agent-engine.ts";
import { engineBinaryPath, installCommand, installedEngine } from "../../../src/main/agent/engine-binary.mts";

/** A stand-in command that prints a version, so no real engine is spawned. */
async function fakeEngine(command: string, version: string) {
  const folder = await temporaryDirectory(path.join(os.tmpdir(), "engine-path-"));
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
  assert.equal(found?.update?.command, "codex update", "an install the path does not place anywhere known is left to the engine's own updater");
});

test("an engine that is nowhere on the path is absent, and the app can say how to install it", async () => {
  const empty = await temporaryDirectory(path.join(os.tmpdir(), "engine-empty-"));
  assert.equal(await onPath(empty, async () => engineBinaryPath("claude")), undefined);
  assert.equal(await onPath(empty, () => installedEngine("claude")), undefined);
  assert.equal(installCommand("codex"), "brew install --cask codex");
  assert.equal(installCommand("claude"), "curl -fsSL https://claude.ai/install.sh | bash");
});

test("the upgrade command follows the launcher to the real file, so a cask upgrades through Homebrew", async () => {
  const root = await temporaryDirectory(path.join(os.tmpdir(), "engine-brew-"));
  const cask = path.join(root, "Caskroom", "codex", "0.150.1");
  await mkdir(cask, { recursive: true });
  const real = path.join(cask, "codex");
  await writeFile(real, "#!/bin/sh\necho 'codex-cli 0.150.1'\n");
  await chmod(real, 0o755);
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await symlink(real, path.join(bin, "codex"));

  const found = await onPath(bin, () => installedEngine("codex"));
  assert.deepEqual(found?.update, { command: "brew upgrade --cask codex", file: "brew", args: ["upgrade", "--cask", "codex"] });
  assert.deepEqual(found?.keg, { kind: "cask", name: "codex", prefix: root });
});

test("a global npm install upgrades through the npm of its own prefix, and a version manager's is left to the user", async () => {
  /** The real path, since macOS reaches the temporary folder through a link. */
  const root = await realpath(await temporaryDirectory(path.join(os.tmpdir(), "engine-npm-")));
  const pkg = path.join(root, "node", "lib", "node_modules", "@openai", "codex", "bin");
  await mkdir(pkg, { recursive: true });
  const real = path.join(pkg, "codex.js");
  await writeFile(real, "#!/bin/sh\necho 'codex-cli 0.150.1'\n");
  await chmod(real, 0o755);
  const bin = path.join(root, "node", "bin");
  await mkdir(bin, { recursive: true });
  await symlink(real, path.join(bin, "codex"));
  await writeFile(path.join(bin, "npm"), "#!/bin/sh\n");
  await chmod(path.join(bin, "npm"), 0o755);
  const prefix = path.join(root, "node");
  const found = await onPath(bin, () => installedEngine("codex"));
  assert.deepEqual(found?.update, {
    command: "npm install -g @openai/codex@latest",
    file: path.join(bin, "npm"),
    args: ["install", "-g", "--prefix", prefix, "--allow-scripts=@openai/codex", "@openai/codex@latest"],
  });

  const mise = path.join(root, "mise", "installs", "claude", "2.1.0");
  await mkdir(mise, { recursive: true });
  await writeFile(path.join(mise, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
  await chmod(path.join(mise, "claude"), 0o755);
  const managed = await onPath(mise, () => installedEngine("claude"));
  assert.equal(managed?.version, "2.1.0");
  assert.equal(managed?.update, null);

  const local = path.join(root, ".local", "bin");
  await mkdir(local, { recursive: true });
  await writeFile(path.join(local, "claude"), '#!/bin/bash\nmise use -g --quiet "claude" || exit 1\nexec mise x "claude" -- "claude" "$@"\n');
  await chmod(path.join(local, "claude"), 0o755);
  assert.equal((await onPath(local, () => installedEngine("claude")))?.update, null, "a mise launcher where the native install would be is still mise's");
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

test("an update runs the engine's own upgrade, then reads every engine from scratch", async () => {
  const { EngineAccessHost } = await import("../../../src/main/agent/engine-services.mts");
  let version = "0.147.0";
  let updates = 0;
  let paths = 0;
  const host = new EngineAccessHost(
    {
      claude: { readiness: async () => ({ access: "ready" }) },
      codex: {
        readiness: async () => (version === "0.147.0" ? { access: "outdated", version, required: "0.150.1" } : { access: "ready", version }),
        update: async () => {
          updates += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          version = "0.150.1";
        },
      },
    },
    async () => { paths += 1; },
  );

  assert.equal((await host.read()).codex?.access, "outdated");
  const [first, second] = await Promise.all([host.update("codex"), host.update("codex")]);
  assert.equal(updates, 1, "a second ask while the upgrade runs joins it");
  assert.deepEqual(first, second);
  assert.deepEqual(first.codex, { access: "ready", version: "0.150.1" });
  assert.equal(paths, 1, "the shell is read again, since an upgrade can move the command");
});

test("the newest release is read from npm once an hour, and an answer that cannot be read is no answer", async () => {
  const { latestEngineVersion } = await import("../../../src/main/agent/engine-binary.mts");
  const asked: string[] = [];
  const original = globalThis.fetch;
  let reply: unknown = { version: "0.161.0" };
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  try {
    const installed = { path: "/bin/codex", version: "0.160.1", update: null, keg: null };
    assert.equal(await latestEngineVersion("codex", installed), "0.161.0");
    assert.equal(await latestEngineVersion("codex", installed), "0.161.0");
    assert.deepEqual(asked, ["https://registry.npmjs.org/%40openai%2Fcodex/latest"], "the second ask is answered from the last hour's");
    reply = { version: "2.2.0-beta.1" };
    assert.equal(await latestEngineVersion("claude", { ...installed, version: "2.1.0" }), null, "a prerelease is not offered");
  } finally {
    globalThis.fetch = original;
  }
});
