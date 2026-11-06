import { DEFAULT_ENGINE, DEFAULT_MODEL, defaultModelIn, effortForModel, policyFor, type AgentEngine, type AgentModel, type ModelCatalog } from "./agent-engine.js";
import type { CoordinationRole } from "./coordination.js";
import type { AgentEffort, ExecutionPolicy } from "./run.js";

/** What the new-thread composer starts its thread on. */
export type AgentDraft = { engine: AgentEngine; model: AgentModel; effort: AgentEffort; policy: ExecutionPolicy; fastMode: boolean };

/**
 * A draft held to its engine. No model means the engine's default, and an engine with none to offer
 * yet gives way to the default engine. The effort moves to the nearest one the model takes, and the mode
 * to the nearest the engine offers. A named model is kept, so a send says when its engine does not offer
 * it, and fast mode stays a preference that only an engine with it applies.
 */
export function normalizeDraft(catalog: ModelCatalog, draft: Omit<AgentDraft, "model"> & { model?: AgentModel | undefined }, role?: CoordinationRole): AgentDraft {
  const named = draft.model ?? defaultModelIn(catalog, draft.engine);
  const engine = named === undefined ? DEFAULT_ENGINE : draft.engine;
  const model = named ?? defaultModelIn(catalog, DEFAULT_ENGINE) ?? DEFAULT_MODEL;
  return { engine, model, effort: effortForModel(catalog, engine, model, draft.effort, role), policy: policyFor(engine, draft.policy), fastMode: draft.fastMode };
}
