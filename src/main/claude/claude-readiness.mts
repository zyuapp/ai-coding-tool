import type { EngineReadiness } from "../../domain/agent-engine.js";
import { installedEngine } from "../agent/engine-binary.mjs";
import { versionReadiness } from "../agent/engine-readiness.mjs";
import { CLAUDE_BASELINE_VERSION } from "./claude-baseline.js";
import { claudeBinary } from "./claude-binary.mjs";

/**
 * Claude Code names the models it can run, so a command behind the app loses the models it never
 * heard of rather than being turned away. The hint carries the upgrade command so the loss is not
 * silent.
 */
export async function readClaudeReadiness(): Promise<EngineReadiness> {
  const installed = await installedEngine(claudeBinary);
  if (!installed) return { access: "missing", fix: claudeBinary.install };
  const { discoverClaudeModels } = await import("./claude-agent-provider.mjs");
  const [models, version] = await Promise.all([discoverClaudeModels(), versionReadiness(claudeBinary, installed, CLAUDE_BASELINE_VERSION)]);
  return { access: "ready", ...version, ...(models ? { models } : {}) };
}
