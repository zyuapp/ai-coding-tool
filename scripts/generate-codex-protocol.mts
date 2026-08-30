import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const target = path.resolve("src/main/codex/protocol");
const codexPackage = path.dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json"));
const wrapper = path.join(codexPackage, "bin", "codex.js");
const codex = (args: string[]) => run(process.execPath, [wrapper, ...args]);

const version = (await codex(["--version"])).stdout.trim().replace(/^codex-cli\s+/, "");
const generated = await mkdtemp(path.join(os.tmpdir(), "codex-protocol-"));
await codex(["app-server", "generate-ts", "--out", generated]);
await rm(target, { recursive: true, force: true });
await cp(generated, target, { recursive: true });
await rm(generated, { recursive: true, force: true });
await writeFile(path.join(target, "version.ts"), `// GENERATED CODE! DO NOT MODIFY BY HAND! Written by scripts/generate-codex-protocol.mts.\n\n/** The \`codex --version\` these bindings were generated from. */\nexport const CODEX_PROTOCOL_VERSION = ${JSON.stringify(version)};\n`);
console.log(`Codex protocol ${version} written to ${target}`);
