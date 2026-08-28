import type { EngineReadiness } from "../../domain/agent-engine.js";
import { isOlderThan } from "../../domain/engine-version.js";
import { CODEX_PROTOCOL_VERSION } from "../codex/protocol/version.js";
import { CLAUDE_BASELINE_VERSION } from "./claude-baseline.js";
import { installCommand, installedEngine } from "./engine-binary.mjs";

/**
 * Claude Code names the models it can run, so a command behind the app loses the models it never
 * heard of rather than being turned away. The hint carries the upgrade command so the loss is not
 * silent.
 */
export async function readClaudeReadiness(): Promise<EngineReadiness> {
  const installed = await installedEngine("claude");
  if (!installed) return { access: "missing", fix: installCommand("claude") };
  const { discoverClaudeModels } = await import("./claude-agent-provider.mjs");
  const models = await discoverClaudeModels();
  return {
    access: "ready",
    ...(installed.version ? { version: installed.version } : {}),
    ...(isOlderThan(installed.version, CLAUDE_BASELINE_VERSION) ? { required: CLAUDE_BASELINE_VERSION, fix: installed.upgrade } : {}),
    ...(models ? { models } : {}),
  };
}

/**
 * Codex speaks the protocol its own version generated, and the app holds one generated copy of it, so
 * a command older than that copy is turned away rather than asked to answer messages it lacks.
 */
export async function readCodexReadiness(): Promise<EngineReadiness> {
  const installed = await installedEngine("codex");
  if (!installed) return { access: "missing", fix: installCommand("codex") };
  if (isOlderThan(installed.version, CODEX_PROTOCOL_VERSION)) {
    return { access: "outdated", ...(installed.version ? { version: installed.version } : {}), required: CODEX_PROTOCOL_VERSION, fix: installed.upgrade };
  }
  const { readCodexAccess } = await import("../codex/codex-account.mjs");
  return { access: await readCodexAccess(), ...(installed.version ? { version: installed.version } : {}) };
}
