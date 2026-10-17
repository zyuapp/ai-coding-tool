import assert from "node:assert/strict";
import { constants, type PathLike } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import { codexAppServer } from "../../../src/main/codex/app-server-client.mts";
import { codexChildEnvironment, preparePrivateCodexHome, PRIVATE_CODEX_HOME_ENV } from "../../../src/main/codex/codex-home.mts";
import { privateHomeConfig } from "../../../src/main/codex/codex-home-config.mts";
import { suggestCodexTitle } from "../../../src/main/codex/codex-title-writer.mts";

const filesystems = vi.hoisted(() => ({ foreign: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  // Paths under `foreign` stand for a second filesystem: hard links across it fail as the kernel's do.
  const inside = (file: PathLike) => filesystems.foreign !== "" && path.resolve(String(file)).startsWith(filesystems.foreign);
  const link: typeof fs.link = async (existing, created) => {
    if (inside(existing) !== inside(created)) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    return fs.link(existing, created);
  };
  return { ...fs, link, default: { ...fs, link } };
});

test("shared inputs follow edits and late sign-in, while each launch repairs missing links and discovers profiles", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-home-")));
  const source = path.join(root, "shared");
  const privateHome = path.join(root, "private");
  try {
    await mkdir(source);
    await writeFile(path.join(source, "config.toml"), 'model = "one"');
    await preparePrivateCodexHome(privateHome, source);
    await writeFile(path.join(source, "config.toml"), 'model = "two"');
    await writeFile(path.join(source, "auth.json"), "synthetic credentials");
    assert.equal(await readFile(path.join(privateHome, "config.toml"), "utf8"), 'model = "two"');
    assert.equal(await readFile(path.join(privateHome, "auth.json"), "utf8"), "synthetic credentials");
    await unlink(path.join(privateHome, "auth.json"));
    await writeFile(path.join(source, "review.config.toml"), 'model = "review"');
    await Promise.all([preparePrivateCodexHome(privateHome, source), preparePrivateCodexHome(privateHome, source)]);
    assert.equal(await readlink(path.join(privateHome, "auth.json")), path.join(source, "auth.json"));
    assert.equal(await readFile(path.join(privateHome, "review.config.toml"), "utf8"), 'model = "review"');
    const environment = { PATH: process.env.PATH, CODEX_HOME: source, CODEX_SQLITE_HOME: source, [PRIVATE_CODEX_HOME_ENV]: privateHome };
    const child = await codexChildEnvironment(environment);
    assert.equal(child.CODEX_HOME, privateHome);
    assert.equal(child.CODEX_SQLITE_HOME, privateHome);
    assert.equal(environment.CODEX_HOME, source);
    const command = await codexAppServer(["-c", `sqlite_home="${source}"`], { env: environment });
    assert.deepEqual(command.args.slice(-4), ["-c", `sqlite_home="${privateHome}"`, "-c", `log_dir="${privateHome}/log"`]);
    const account = await codexAppServer([], { env: environment, sharedHome: true });
    assert.equal(account.env, environment);
    assert.deepEqual(account.args, ["app-server", "--listen", "stdio://"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP credentials support no-follow writes, common locks, and source replacement after logout", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-mcp-home-")));
  const source = path.join(root, "shared");
  const privateHome = path.join(root, "private");
  try {
    await mkdir(source); await mkdir(privateHome);
    await symlink(path.join(source, ".credentials.json"), path.join(privateHome, ".credentials.json"));
    await mkdir(path.join(privateHome, "plugins", "cache"), { recursive: true });
    await writeFile(path.join(privateHome, "plugins", "cache", "old-install"), "retained");
    await preparePrivateCodexHome(privateHome, source);
    const sharedCredentials = path.join(source, ".credentials.json");
    const privateCredentials = path.join(privateHome, ".credentials.json");
    const file = await open(privateCredentials, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    await file.writeFile('{"fixture":"refreshed"}'); await file.close();
    assert.equal(await readFile(sharedCredentials, "utf8"), '{"fixture":"refreshed"}');
    assert.equal(await realpath(path.join(privateHome, "mcp-oauth-locks")), path.join(source, "mcp-oauth-locks"));
    await unlink(sharedCredentials);
    await preparePrivateCodexHome(privateHome, source);
    assert.equal(await readFile(privateCredentials, "utf8"), "{}");
    assert.equal((await stat(privateCredentials)).ino, (await stat(sharedCredentials)).ino);
    assert.equal(await realpath(path.join(privateHome, "plugins", "cache")), path.join(source, "plugins", "cache"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a private home on another filesystem moves beside the shared home and keeps one credential file", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-cross-device-home-")));
  const source = path.join(root, "shared");
  const privateHome = path.join(root, "app-data", "codex-private");
  filesystems.foreign = path.join(root, "app-data");
  try {
    await mkdir(source); await mkdir(path.join(privateHome, "plugins"), { recursive: true });
    await writeFile(path.join(source, "config.toml"), 'model = "shared"');
    // Launches that failed before relocation existed left only links behind.
    await symlink(path.join(source, "auth.json"), path.join(privateHome, "auth.json"));
    await symlink(path.join(source, "plugins", "cache"), path.join(privateHome, "plugins", "cache"));
    const destination = await preparePrivateCodexHome(privateHome, source);
    assert.equal(path.dirname(path.dirname(destination)), source);
    assert.equal(await realpath(privateHome), destination);
    assert.equal(await readFile(path.join(privateHome, "config.toml"), "utf8"), 'model = "shared"');
    const privateCredentials = path.join(destination, ".credentials.json");
    assert((await lstat(privateCredentials)).isFile());
    const file = await open(privateCredentials, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    await file.writeFile('{"fixture":"refreshed"}'); await file.close();
    assert.equal(await readFile(path.join(source, ".credentials.json"), "utf8"), '{"fixture":"refreshed"}');
    const child = await codexChildEnvironment({ CODEX_HOME: source, [PRIVATE_CODEX_HOME_ENV]: privateHome });
    assert.equal(child.CODEX_HOME, destination);
    await rm(destination, { recursive: true });
    assert.equal(await preparePrivateCodexHome(privateHome, source), destination);
    assert.equal((await stat(privateCredentials)).ino, (await stat(path.join(source, ".credentials.json"))).ino);
  } finally {
    filesystems.foreign = "";
    await rm(root, { recursive: true, force: true });
  }
});

test("a title run on another filesystem stores its databases in the moved home, and earlier title leftovers do not block the move", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-cross-device-title-")));
  const source = path.join(root, "shared");
  const privateHome = path.join(root, "app-data", "codex-private");
  const bin = path.join(root, "bin");
  filesystems.foreign = path.join(root, "app-data");
  const original = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME, [PRIVATE_CODEX_HOME_ENV]: process.env[PRIVATE_CODEX_HOME_ENV] };
  try {
    await mkdir(source); await mkdir(path.join(privateHome, "log"), { recursive: true }); await mkdir(bin);
    // A title that ran while launches failed wrote straight into the unprepared home.
    for (const name of ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm", "logs_2.sqlite", "log/codex-tui.log"]) await writeFile(path.join(privateHome, name), "title");
    await symlink(path.join(source, "auth.json"), path.join(privateHome, "auth.json"));
    // Stands in for `codex exec`: records its database in sqlite_home and answers with a title.
    await writeFile(path.join(bin, "codex"), `#!/bin/sh
for arg; do
  case "$arg" in sqlite_home=*) home=$(printf %s "$arg" | sed 's/^sqlite_home="//; s/"$//') ;; esac
  [ "$previous" = --output-last-message ] && output="$arg"
  previous="$arg"
done
cat > /dev/null
printf title > "$home/state_5.sqlite"
printf '{"title":"Sidebar overlap"}' > "$output"
`);
    await chmod(path.join(bin, "codex"), 0o755);
    Object.assign(process.env, { PATH: `${bin}${path.delimiter}${original.PATH}`, CODEX_HOME: source, [PRIVATE_CODEX_HOME_ENV]: privateHome });
    assert.equal(await suggestCodexTitle("Fix the sidebar overlap"), "Sidebar overlap");
    const destination = await realpath(privateHome);
    assert.equal(path.dirname(path.dirname(destination)), source);
    assert.equal(await readFile(path.join(destination, "state_5.sqlite"), "utf8"), "title");
    assert.equal(await lstat(path.join(destination, "log")).catch(() => null), null, "leftovers from the unprepared home are discarded");
    assert.equal((await codexChildEnvironment(process.env)).CODEX_HOME, destination, "Codex still starts");
    assert.equal((await stat(path.join(destination, ".credentials.json"))).ino, (await stat(path.join(source, ".credentials.json"))).ino);
  } finally {
    for (const [name, value] of Object.entries(original)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    filesystems.foreign = "";
    await rm(root, { recursive: true, force: true });
  }
});

test("a private home with conversation state on another filesystem is never moved or discarded", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-cross-device-state-")));
  const source = path.join(root, "shared");
  const privateHome = path.join(root, "app-data", "codex-private");
  filesystems.foreign = path.join(root, "app-data");
  try {
    await mkdir(source); await mkdir(path.join(privateHome, "sessions"), { recursive: true });
    await writeFile(path.join(privateHome, "sessions", "rollout.jsonl"), "conversation");
    await assert.rejects(preparePrivateCodexHome(privateHome, source), /same filesystem/);
    assert.equal(await readFile(path.join(privateHome, "sessions", "rollout.jsonl"), "utf8"), "conversation");
    assert(!(await lstat(privateHome)).isSymbolicLink());
  } finally {
    filesystems.foreign = "";
    await rm(root, { recursive: true, force: true });
  }
});

test("file references remain relative to the declaring home and saved hook state follows its source", () => {
  const args = privateHomeConfig({ model_instructions_file: "../instructions.md", agents: { reviewer: { config_file: "custom/reviewer.toml" } }, hooks: { state: {
    "/shared/config.toml:session_start:0:0": { trusted_hash: "sha256:original", enabled: false },
    "/shared/.aicodingtool/home/config.toml:session_start:0:0": { trusted_hash: "sha256:private", enabled: true },
  } } }, "/shared", "/shared/.aicodingtool/home");
  assert.deepEqual(args, ["-c", 'model_instructions_file="/instructions.md"', "-c", 'agents={ "reviewer" = { "config_file" = "/shared/custom/reviewer.toml" } }',
    "-c", 'hooks.state={ "/shared/.aicodingtool/home/config.toml:session_start:0:0" = { "trusted_hash" = "sha256:original", "enabled" = false } }']);
});

test("Keychain configurations keep native credential lookup in the source home and private auth in memory", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-keyring-home-")));
  try {
    const source = path.join(root, "shared");
    const privateHome = path.join(root, "private");
    await mkdir(source);
    await writeFile(path.join(source, "config.toml"), 'cli_auth_credentials_store = "keyring"');
    const command = await codexAppServer([], { env: { PATH: process.env.PATH, CODEX_HOME: source, [PRIVATE_CODEX_HOME_ENV]: privateHome } });
    assert.equal(command.env?.CODEX_HOME, privateHome);
    assert(command.args.includes('cli_auth_credentials_store="ephemeral"'));
    assert.equal(command.sharedAuth?.env?.CODEX_HOME, source);
    assert.equal(command.sharedAuth?.env?.CODEX_SQLITE_HOME, privateHome);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private home conflicts fail without overwriting credentials or sharing runtime state", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codex-home-conflict-")));
  const source = path.join(root, "shared");
  const privateHome = path.join(root, "private");
  try {
    await mkdir(source); await mkdir(privateHome);
    await writeFile(path.join(privateHome, "auth.json"), "keep credentials");
    await assert.rejects(preparePrivateCodexHome(privateHome, source), /not a link/);
    assert.equal(await readFile(path.join(privateHome, "auth.json"), "utf8"), "keep credentials");
    await assert.rejects(preparePrivateCodexHome(source, source), /must be separate/);
    const alias = path.join(root, "alias");
    await symlink(source, alias);
    await assert.rejects(preparePrivateCodexHome(alias, source), /must be separate/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
