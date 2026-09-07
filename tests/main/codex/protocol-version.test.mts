import { temporaryDirectory } from "../../support/temporary-directory.mts";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { codexExecutable } from "../../../src/main/codex/codex-executable.mts";
import { CODEX_PROTOCOL_VERSION } from "../../../src/main/codex/protocol/version.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function json(file: string) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

test("the committed protocol bindings come from the pinned Codex, which the app is built against", async () => {
  const pinned = (await json("node_modules/@openai/codex/package.json")).version as string;
  const app = await json("package.json");

  assert.equal(app.devDependencies["@openai/codex"], pinned, "the dependency is pinned to the exact generated version, and is needed only to generate them");
  assert.equal(CODEX_PROTOCOL_VERSION, pinned, "run npm run generate:codex-protocol after bumping @openai/codex");
});

test("the app runs the Codex the user installed, and refuses rather than guessing when there is none", async () => {
  const folder = await temporaryDirectory(path.join(os.tmpdir(), "codex-path-"));
  const executable = path.join(folder, "codex");
  await writeFile(executable, "");
  await chmod(executable, 0o755);
  const original = process.env.PATH;
  try {
    process.env.PATH = folder;
    assert.equal(codexExecutable(), executable);
    process.env.PATH = path.join(folder, "empty");
    assert.throws(() => codexExecutable(), /Codex is not installed/);
  } finally {
    process.env.PATH = original;
  }
});

test("neither engine's executable is packaged, since the app runs the one on the machine", async () => {
  const files = (await json("package.json")).build.files as string[];
  assert.ok(files.includes("!**/node_modules/@openai/codex-*/**/*"), "native Codex packages are excluded from every platform package");
  assert.ok(files.includes("!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*"), "native Claude packages are excluded from every platform package");
});
