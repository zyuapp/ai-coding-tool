import { efforts, isAgentEffort, isModelId, type AgentModel, type ModelSpec } from "../../domain/agent-engine.js";

/** A model as the server lists it; only what the picker and a run read. */
export type OpenCodeModel = {
  id: string;
  providerID: string;
  name?: string;
  enabled?: boolean;
  variants?: readonly { id: string }[];
  limit?: { context?: number };
};

export type OpenCodeProvider = { id: string; name?: string };

/** What a picker model id names on the server: its provider, the provider's own id for it, and a depth to reason at. */
export type ModelRef = { providerID: string; id: string; variant?: string };

/** An app model id is the provider and the provider's id joined, as OpenCode writes it: `openrouter/z-ai/glm-5.3-flash`. */
export function appModelId(model: Pick<OpenCodeModel, "id" | "providerID">): AgentModel {
  return `${model.providerID}/${model.id}`;
}

/** The server's reference for an app model id, at the effort a run asked for when the model reasons at more than one depth. */
export function modelRef(model: AgentModel, variant?: string): ModelRef | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1), ...(variant ? { variant } : {}) };
}

/**
 * The models the server offers, as the picker lists them: each connected provider's models, the
 * server's default first. A model reasons at the depths its variants name that the app also names;
 * a variant only OpenCode knows is left out.
 */
export function openCodeCatalog(models: readonly OpenCodeModel[], providers: readonly OpenCodeProvider[], defaultModel?: Pick<OpenCodeModel, "id" | "providerID">): ModelSpec[] {
  const names = new Map(providers.map((provider) => [provider.id, provider.name ?? provider.id]));
  const specs = models.flatMap((model): ModelSpec[] => {
    const id = appModelId(model);
    if (model.enabled === false || !isModelId(id)) return [];
    const provider = names.get(model.providerID) ?? model.providerID;
    const offered = (model.variants ?? []).map((variant) => variant.id).filter(isAgentEffort);
    return [{
      id,
      label: model.name ?? model.id,
      description: model.id,
      provider,
      contextWindow: model.limit?.context ?? 0,
      efforts: efforts(...offered),
      manualCompaction: true,
    }];
  });
  const first = defaultModel ? appModelId(defaultModel) : undefined;
  const index = specs.findIndex((spec) => spec.id === first);
  return index > 0 ? [specs[index]!, ...specs.slice(0, index), ...specs.slice(index + 1)] : specs;
}
