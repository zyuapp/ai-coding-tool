import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { codexAppServer } from "../../../src/main/codex/app-server-client.mts";
import { codexChildEnvironment, preparePrivateCodexHome, PRIVATE_CODEX_HOME_ENV } from "../../../src/main/codex/codex-home.mts";

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
