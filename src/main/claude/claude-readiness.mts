import type { EngineReadiness } from "../../domain/agent-engine.js";
import { installCommand, installedEngine } from "../agent/engine-binary.mjs";
import { versionReadiness } from "../agent/engine-readiness.mjs";
import { CLAUDE_BASELINE_VERSION } from "./claude-baseline.js";

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
