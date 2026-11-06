import { byEngine, type AgentEngine } from "../../src/domain/agent-engine.ts";
import type { EngineServices } from "../../src/main/agent/engine-services.mts";

/** One value per engine: the one given where an engine is named, else what `build` makes for it. */
export function everyEngine<T>(build: (engine: AgentEngine) => T, named: Partial<Record<AgentEngine, T>> = {}): Record<AgentEngine, T> {
  return byEngine((engine) => Object.hasOwn(named, engine) ? named[engine] as T : build(engine));
}

type ReadinessServices = Pick<EngineServices, "readiness" | "signIn" | "update">;

/** What `EngineAccessHost` asks of each engine: ready with nothing to sign in to or update, but for the engines named. */
export function readinessStubs(named: Partial<Record<AgentEngine, ReadinessServices>> = {}): Record<AgentEngine, ReadinessServices> {
  return everyEngine(() => ({ readiness: async () => ({ access: "ready" }) }), named);
}
