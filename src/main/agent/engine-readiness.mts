import type { AgentEngine, EngineReadiness } from "../../domain/agent-engine.js";
import { isOlderThan } from "../../domain/engine-version.js";
import { latestEngineVersion, type InstalledEngine } from "./engine-binary.mjs";

/**
 * Where an install stands against what the app was built on and the newest release, and the command
 * that moves it on when it is behind either and the app can run that command.
 */
export async function versionReadiness(engine: AgentEngine, installed: InstalledEngine, baseline: string): Promise<Pick<EngineReadiness, "version" | "required" | "latest" | "fix">> {
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
