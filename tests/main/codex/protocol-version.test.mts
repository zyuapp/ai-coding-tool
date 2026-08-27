import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";
import { codexExecutable, codexPlatformPackage, packagedCodexExecutable } from "../../../src/main/codex/codex-executable.mts";
import { CODEX_PROTOCOL_VERSION } from "../../../src/main/codex/protocol/version.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function json(file: string) {
  return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

test("the committed protocol bindings come from the bundled Codex, which is pinned exactly", async () => {
  const bundled = (await json("node_modules/@openai/codex/package.json")).version as string;
  const app = await json("package.json");

  assert.equal(app.dependencies["@openai/codex"], bundled, "the dependency is pinned to the exact bundled version");
  assert.equal(CODEX_PROTOCOL_VERSION, bundled, "run npm run generate:codex-protocol after bumping @openai/codex");
  const { stdout } = await promisify(execFile)(codexExecutable(), ["--version"]);
  assert.equal(stdout.trim(), `codex-cli ${bundled}`);
});

test("the packaged app runs the binary electron-builder unpacked from the asar", async () => {
  const resources = await mkdtemp(path.join(os.tmpdir(), "codex-resources-"));
  const { name, triple } = codexPlatformPackage();
  const unpacked = path.join(resources, "app.asar.unpacked", "node_modules", name, "vendor", triple, "bin");
  assert.equal(packagedCodexExecutable(resources), undefined);

  await mkdir(unpacked, { recursive: true });
  await writeFile(path.join(unpacked, "codex"), "");

  assert.equal(packagedCodexExecutable(resources), path.join(unpacked, "codex"));
  assert.equal(codexExecutable(resources), path.join(unpacked, "codex"));
  const asarUnpack = (await json("package.json")).build.asarUnpack as string[];
  assert.ok(asarUnpack.some((pattern) => pattern.startsWith(`node_modules/${name}/vendor`)), "the platform package's vendor tree is unpacked");
});
