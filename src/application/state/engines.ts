import { engineCatalog, engineHasModel, engineModelsKnown, type AgentEngine, type AgentModel, type EngineReadiness, type EngineStatus, type ModelCatalog } from "../../domain/agent-engine.js";

export type EnginesState = {
  /** What main last said about which engines can take a run. Session-only, and never persisted. */
  /** What main has said about the engines' access; null until it has been asked. */
  engineStatus: EngineStatus | null;
  /** True while main is running the engine commands, which the Engines page says out loud. */
  engineChecking: boolean;
  /** The engine whose command the app is upgrading, which its Update button says out loud. */
  engineUpdating: AgentEngine | null;
  /** Engines the user asked to update while another was updating, in the order they asked. */
  engineUpdateQueue: AgentEngine[];
  /** True once the launch's first answer about the engines has offered their updates. */
  engineUpdatesOffered: boolean;
  /** True from the first launch after an app update until every engine it needs has been upgraded. */
  engineUpgradesOwed: boolean;
  agentSettingsReload: "idle" | "reloading" | "pending" | "reloaded" | "failed";
};

export function initialEnginesState(): EnginesState {
  return {
    engineStatus: null,
    engineChecking: false,
    engineUpdating: null,
    engineUpdateQueue: [],
    engineUpdatesOffered: false,
    engineUpgradesOwed: false,
    agentSettingsReload: "idle",
  };
}

/** An engine main has said nothing about is taken as ready; only main can say otherwise. */
export function engineReadinessOf(state: Pick<EnginesState, "engineStatus">, engine: AgentEngine): EngineReadiness {
  return state.engineStatus?.[engine] ?? { access: "ready" };
}

/** The models this machine's engines offer, as main last named them. */
export function catalogOf(state: Pick<EnginesState, "engineStatus">): ModelCatalog {
  return engineCatalog(state.engineStatus);
}

/** Whether a run may go to `model`: one its engine offers, or any while main has yet to name that engine's models. */
export function engineOffersModel(state: Pick<EnginesState, "engineStatus">, engine: AgentEngine, model: AgentModel) {
  return engineHasModel(catalogOf(state), engine, model) || !engineModelsKnown(state.engineStatus, engine);
}
