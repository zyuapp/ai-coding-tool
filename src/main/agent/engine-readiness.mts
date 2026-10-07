import type { AgentEngine, EngineReadiness } from "../../domain/agent-engine.js";
import { isOlderThan } from "../../domain/engine-version.js";
import { CODEX_PROTOCOL_VERSION } from "../codex/protocol/version.js";
import { CLAUDE_BASELINE_VERSION } from "./claude-baseline.js";
import { installCommand, installedEngine, latestEngineVersion, type InstalledEngine } from "./engine-binary.mjs";

/**
 * Where an install stands against what the app was built on and the newest release, and the command
 * that moves it on when it is behind either and the app can run that command.
 */
async function versionReadiness(engine: AgentEngine, installed: InstalledEngine, baseline: string): Promise<Pick<EngineReadiness, "version" | "required" | "latest" | "fix">> {
  const latest = installed.version ? await latestEngineVersion(engine, installed) : null;
  const required = isOlderThan(installed.version, baseline) ? baseline : undefined;
  const newer = latest && installed.version && isOlderThan(installed.version, latest) ? latest : undefined;
  return {
    ...(installed.version ? { version: installed.version } : {}),
    ...(required ? { required } : {}),
    ...(newer ? { latest: newer } : {}),
    ...(installed.update && (required || newer) ? { fix: installed.update.command } : {}),
  };
}

/**
 * Claude Code names the models it can run, so a command behind the app loses the models it never
 * heard of rather than being turned away. The hint carries the upgrade command so the loss is not
 * silent.
 */
export async function readClaudeReadiness(): Promise<EngineReadiness> {
  const installed = await installedEngine("claude");
  if (!installed) return { access: "missing", fix: installCommand("claude") };
  const { discoverClaudeModels } = await import("./claude-agent-provider.mjs");
  const [models, version] = await Promise.all([discoverClaudeModels(), versionReadiness("claude", installed, CLAUDE_BASELINE_VERSION)]);
  return { access: "ready", ...version, ...(models ? { models } : {}) };
}

/**
 * Codex speaks the protocol its own version generated, and the app holds one generated copy of it, so
 * a command older than that copy is turned away rather than asked to answer messages it lacks.
 */
export async function readCodexReadiness(): Promise<EngineReadiness> {
  const installed = await installedEngine("codex");
  if (!installed) return { access: "missing", fix: installCommand("codex") };
  const version = versionReadiness("codex", installed, CODEX_PROTOCOL_VERSION);
  if (isOlderThan(installed.version, CODEX_PROTOCOL_VERSION)) return { access: "outdated", ...await version };
  const { readCodexAccess } = await import("../codex/codex-account.mjs");
  const [access, known] = await Promise.all([readCodexAccess(), version]);
  return { access, ...known };
}
