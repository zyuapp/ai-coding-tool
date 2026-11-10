import { AGENT_ENGINES, type AgentEngine } from "../domain/agent-engine.js";
import type { EngineModule, ProviderContext } from "./agent/engine-module.mjs";
import type { EngineProvider } from "./agent/engine-router.mjs";
import type { EngineServices } from "./agent/engine-services.mjs";
import { claudeEngine } from "./claude/claude-engine.mjs";
import { codexEngine } from "./codex/codex-engine.mjs";
import { openCodeEngine } from "./opencode/opencode-engine.mjs";

export { EngineAccessHost } from "./agent/engine-services.mjs";

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

export const engineServices = Object.fromEntries(AGENT_ENGINES.map((engine) => [engine, ENGINE_MODULES[engine].services])) as Record<AgentEngine, EngineServices>;

/** Stops whatever an engine keeps running to answer outside a run. */
export async function closeEngineServices() {
  await Promise.all(AGENT_ENGINES.map((engine) => engineServices[engine].close?.()));
}
