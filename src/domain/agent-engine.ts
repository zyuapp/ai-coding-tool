import type { AgentEffort } from "./run.js";

/** The backends that can run a task. Each offers its own models, efforts, and context windows. */
export type AgentEngine = "claude";
export const DEFAULT_ENGINE: AgentEngine = "claude";

const CLAUDE_MODELS = [
  { id: "fable", label: "Fable", description: "Most capable for demanding work", contextWindow: 1_000_000 },
  { id: "opus", label: "Opus", description: "Best for complex reasoning", contextWindow: 1_000_000 },
  { id: "sonnet", label: "Sonnet", description: "Balanced speed and capability", contextWindow: 1_000_000 },
  { id: "haiku", label: "Haiku", description: "Fastest for lightweight work", contextWindow: 200_000 },
] as const;

export type AgentModel = (typeof CLAUDE_MODELS)[number]["id"];

/** Runs always request the widest context a model offers, so `contextWindow` is that ceiling. */
export type ModelSpec = { id: AgentModel; label: string; description: string; contextWindow: number };

type EngineSpec = {
  label: string;
  models: readonly ModelSpec[];
  defaultModel: AgentModel;
  efforts: readonly AgentEffort[];
  defaultEffort: AgentEffort;
};

const ENGINES: Record<AgentEngine, EngineSpec> = {
  claude: {
    label: "Claude",
    models: CLAUDE_MODELS,
    defaultModel: "opus",
    efforts: ["max", "xhigh", "high", "medium", "low"],
    defaultEffort: "high",
  },
};

export const DEFAULT_MODEL: AgentModel = ENGINES[DEFAULT_ENGINE].defaultModel;

const ENGINE_IDS = Object.keys(ENGINES) as AgentEngine[];
const MODEL_IDS = new Set<string>(ENGINE_IDS.flatMap((engine) => ENGINES[engine].models.map((model) => model.id)));
const EFFORT_IDS = new Set<string>(ENGINE_IDS.flatMap((engine) => ENGINES[engine].efforts));

export function isAgentEngine(value: unknown): value is AgentEngine {
  return typeof value === "string" && value in ENGINES;
}

/** True for a model any engine offers; use `engineHasModel` to ask about one engine. */
export function isAgentModel(value: unknown): value is AgentModel {
  return typeof value === "string" && MODEL_IDS.has(value);
}

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && EFFORT_IDS.has(value);
}

export function engineHasModel(engine: AgentEngine, model: AgentModel) {
  return ENGINES[engine].models.some((spec) => spec.id === model);
}

export function modelsFor(engine: AgentEngine): readonly ModelSpec[] {
  return ENGINES[engine].models;
}

export function effortsFor(engine: AgentEngine): readonly AgentEffort[] {
  return ENGINES[engine].efforts;
}

export function defaultModelFor(engine: AgentEngine): AgentModel {
  return ENGINES[engine].defaultModel;
}

export function defaultEffortFor(engine: AgentEngine): AgentEffort {
  return ENGINES[engine].defaultEffort;
}

/** A model the engine does not offer is measured against the engine's default model. */
export function contextWindowLimit(engine: AgentEngine, model: AgentModel): number {
  const { models, defaultModel } = ENGINES[engine];
  return (models.find((spec) => spec.id === model) ?? models.find((spec) => spec.id === defaultModel))?.contextWindow ?? 0;
}
