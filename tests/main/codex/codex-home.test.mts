import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readlink, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { codexAppServer } from "../../../src/main/codex/app-server-client.mts";
import { codexChildEnvironment, preparePrivateCodexHome, PRIVATE_CODEX_HOME_ENV } from "../../../src/main/codex/codex-home.mts";
import { privateHomeConfig } from "../../../src/main/codex/codex-home-config.mts";

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

test("file references remain relative to the declaring home and saved hook state follows its source", () => {
  const args = privateHomeConfig({ model_instructions_file: "../instructions.md", agents: { reviewer: { config_file: "custom/reviewer.toml" } }, hooks: { state: {
    "/shared/config.toml:session_start:0:0": { trusted_hash: "sha256:original", enabled: false },
  } } }, "/shared", "/private");
  assert.deepEqual(args, ["-c", 'model_instructions_file="/instructions.md"', "-c", 'agents={ "reviewer" = { "config_file" = "/shared/custom/reviewer.toml" } }',
    "-c", 'hooks.state={ "/private/config.toml:session_start:0:0" = { "trusted_hash" = "sha256:original", "enabled" = false } }']);
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
