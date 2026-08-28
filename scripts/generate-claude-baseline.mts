import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readVersion } from "../src/domain/engine-version.ts";

const run = promisify(execFile);
const target = path.resolve("src/main/agent/claude-baseline.ts");

/**
 * The Claude Code the SDK ships. The app never runs it — it runs the one the user installed — but the
 * app is written against it, so its version is the floor an installed command has to reach.
 */
const packageRoot = path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json"));
const version = readVersion((await run(path.join(packageRoot, "claude"), ["--version"])).stdout);
if (!version) throw new Error("Claude Code printed no version.");

await writeFile(target, [
  "// GENERATED CODE! DO NOT MODIFY BY HAND! Written by scripts/generate-claude-baseline.mts.",
  "",
  "/** The Claude Code the app is built against. An older installed command is offered fewer models. */",
  `export const CLAUDE_BASELINE_VERSION = ${JSON.stringify(version)};`,
  "",
].join("\n"));
console.log(`Claude baseline ${version} written to ${target}`);
