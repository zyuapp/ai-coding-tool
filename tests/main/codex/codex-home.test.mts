import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { codexAppServer } from "../../../src/main/codex/app-server-client.mts";
import { codexChildEnvironment, preparePrivateCodexHome, PRIVATE_CODEX_HOME_ENV } from "../../../src/main/codex/codex-home.mts";

test("the private Codex home follows default settings without importing account or thread state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "aicodingtool-codex-home-"));
  const source = path.join(directory, "default");
  const userData = path.join(directory, "user-data");
  await Promise.all([mkdir(source), mkdir(userData)]);
  await Promise.all([
    writeFile(path.join(source, "config.toml"), 'model = "gpt-5.6"'),
    writeFile(path.join(source, "review.config.toml"), 'model_reasoning_effort = "high"'),
    writeFile(path.join(source, "auth.json"), "secret"),
  ]);

  const privateHome = await preparePrivateCodexHome(userData, source);
  assert.equal(await readFile(path.join(privateHome, "config.toml"), "utf8"), 'model = "gpt-5.6"');
  assert.equal(await readFile(path.join(privateHome, "review.config.toml"), "utf8"), 'model_reasoning_effort = "high"');
  await assert.rejects(readFile(path.join(privateHome, "auth.json"), "utf8"), { code: "ENOENT" });

  await writeFile(path.join(source, "config.toml"), 'model = "gpt-5.7"');
  await preparePrivateCodexHome(userData, source);
  assert.equal(await readFile(path.join(privateHome, "config.toml"), "utf8"), 'model = "gpt-5.7"', "settings refresh on restart");
});

test("only Codex children receive the private home and SQLite override", () => {
  const privateHome = "/private/app/codex";
  const parentEnvironment: NodeJS.ProcessEnv = { PATH: "/bin", [PRIVATE_CODEX_HOME_ENV]: privateHome };
  const environment = codexChildEnvironment(parentEnvironment);
  assert.equal(parentEnvironment.CODEX_HOME, undefined, "the parent environment remains unchanged");
  assert.equal(environment.CODEX_HOME, privateHome);
  assert.equal(environment.CODEX_SQLITE_HOME, privateHome);

  const command = codexAppServer([], { env: parentEnvironment });
  assert.equal(command.env?.CODEX_HOME, privateHome);
  assert.deepEqual(command.args.slice(-6), [
    "-c", 'sqlite_home="/private/app/codex"',
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'mcp_oauth_credentials_store="file"',
  ]);
});
