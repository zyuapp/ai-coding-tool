import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  const platform = process.platform === "darwin" ? "darwin-arm64" : `${process.platform}-${process.arch}`;
  const platformPackage = `@openai/codex-${platform}`;
  const triples: Record<string, string> = {
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "linux-x64": "x86_64-unknown-linux-musl",
  };
  const triple = triples[platform];
  assert.ok(triple, `the pinned Codex is not available for ${process.platform}-${process.arch}`);
  const packageRoot = path.dirname(createRequire(import.meta.url).resolve(`${platformPackage}/package.json`));
  const { stdout } = await promisify(execFile)(path.join(packageRoot, "vendor", triple, "bin", "codex"), ["--version"]);
  assert.equal(stdout.trim(), `codex-cli ${pinned}`);
});

test("the app runs the Codex the user installed, and refuses rather than guessing when there is none", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "codex-path-"));
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
