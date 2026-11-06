import { AGENT_ENGINES, type AgentEngine } from "../../domain/agent-engine.js";
import { claudeEngine } from "../claude/claude-engine.mjs";
import { codexEngine } from "../codex/codex-engine.mjs";
import { openCodeEngine } from "../opencode/opencode-engine.mjs";
import type { ToolHost } from "../tools/mcp-http-host.mjs";
import type { EngineServices } from "./engine-services.mjs";
import type { EngineProvider } from "./engine-router.mjs";
import type { SessionPool } from "./session-pool.mjs";

/** The command an engine is installed as, the npm package it is published as, and how to install it. */
export type EngineCommand = { command: string; packageName: string; install: string; isNative: (realPath: string) => boolean };

/** What every engine's provider is built with in a worker. */
export type ProviderContext = {
  /** Serves the app's tools to every session of the process. */
  host: ToolHost;
  /** The sessions a channel keeps warm, shared by its engines. */
  pool: SessionPool;
  /** Where images an engine generates are saved. */
  generatedImages?: string;
};

/** Everything the app knows of one engine. Each part loads the engine's own code when first used. */
export type EngineModule = {
  binary: EngineCommand;
  services: EngineServices;
  createProvider(context: ProviderContext): Promise<EngineProvider>;
};

export const ENGINE_MODULES: Record<AgentEngine, EngineModule> = {
  claude: claudeEngine,
  codex: codexEngine,
  opencode: openCodeEngine,
};

/** One provider per engine, built for one channel. */
export async function engineProviders(context: ProviderContext): Promise<Record<AgentEngine, EngineProvider>> {
  const built = await Promise.all(AGENT_ENGINES.map(async (engine) => [engine, await ENGINE_MODULES[engine].createProvider(context)] as const));
  return Object.fromEntries(built) as Record<AgentEngine, EngineProvider>;
}
