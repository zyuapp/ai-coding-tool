import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { codexExecutable } from "../src/main/codex/codex-executable.mts";

const run = promisify(execFile);
const target = path.resolve("src/main/codex/protocol");
const executable = codexExecutable();

const version = (await run(executable, ["--version"])).stdout.trim().replace(/^codex-cli\s+/, "");
const generated = await mkdtemp(path.join(os.tmpdir(), "codex-protocol-"));
await run(executable, ["app-server", "generate-ts", "--out", generated]);
await rm(target, { recursive: true, force: true });
await cp(generated, target, { recursive: true });
await rm(generated, { recursive: true, force: true });
await writeFile(path.join(target, "version.ts"), `// GENERATED CODE! DO NOT MODIFY BY HAND! Written by scripts/generate-codex-protocol.mts.\n\n/** The \`codex --version\` these bindings were generated from. */\nexport const CODEX_PROTOCOL_VERSION = ${JSON.stringify(version)};\n`);
console.log(`Codex protocol ${version} written to ${target}`);
