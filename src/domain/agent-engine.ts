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

const CLAUDE_EFFORTS: readonly EffortSpec[] = [
  { id: "max", label: "Max effort", description: "Everything the model has, slowest" },
  { id: "xhigh", label: "Extra high effort", description: "Deeper than high, where the model offers it" },
  { id: "high", label: "High effort", description: "Deep reasoning" },
  { id: "medium", label: "Medium effort", description: "Moderate thinking" },
  { id: "low", label: "Low effort", description: "Minimal thinking, fastest replies" },
];

export type AgentModel = (typeof CLAUDE_MODELS)[number]["id"];

/** Runs always request the widest context a model offers, so `contextWindow` is that ceiling. */
export type ModelSpec = { id: AgentModel; label: string; description: string; contextWindow: number };

export type EffortSpec = { id: AgentEffort; label: string; description: string };

/** The panels and controls an engine can feed; one that cannot is not drawn for its threads. */
export type EngineCapabilities = {
  planUsage: boolean;
  workflows: boolean;
  subagents: boolean;
};

type EngineSpec = {
  label: string;
  models: readonly ModelSpec[];
  defaultModel: AgentModel;
  efforts: readonly EffortSpec[];
  defaultEffort: AgentEffort;
  capabilities: EngineCapabilities;
};

const ENGINES: Record<AgentEngine, EngineSpec> = {
  claude: {
    label: "Claude",
    models: CLAUDE_MODELS,
    defaultModel: "opus",
    efforts: CLAUDE_EFFORTS,
    defaultEffort: "high",
    capabilities: { planUsage: true, workflows: true, subagents: true },
  },
};

export const DEFAULT_MODEL: AgentModel = ENGINES[DEFAULT_ENGINE].defaultModel;

const ENGINE_IDS = Object.keys(ENGINES) as AgentEngine[];
const MODEL_IDS = new Set<string>(ENGINE_IDS.flatMap((engine) => ENGINES[engine].models.map((model) => model.id)));
const EFFORT_IDS = new Set<string>(ENGINE_IDS.flatMap((engine) => ENGINES[engine].efforts.map((effort) => effort.id)));

export function isAgentEngine(value: unknown): value is AgentEngine {
  return typeof value === "string" && Object.hasOwn(ENGINES, value);
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

export function effortsFor(engine: AgentEngine): readonly EffortSpec[] {
  return ENGINES[engine].efforts;
}

export function defaultModelFor(engine: AgentEngine): AgentModel {
  return ENGINES[engine].defaultModel;
}

export function defaultEffortFor(engine: AgentEngine): AgentEffort {
  return ENGINES[engine].defaultEffort;
}

export function capabilitiesFor(engine: AgentEngine): EngineCapabilities {
  return ENGINES[engine].capabilities;
}

/** What the engine is called wherever the app speaks of the agent running a thread. */
export function engineLabel(engine: AgentEngine): string {
  return ENGINES[engine].label;
}

/** One value per engine, built now so a picker reads a stable list instead of building one per render. */
export function byEngine<T>(build: (engine: AgentEngine) => T): Record<AgentEngine, T> {
  return Object.fromEntries(ENGINE_IDS.map((engine) => [engine, build(engine)])) as Record<AgentEngine, T>;
}

/** A model the engine does not offer is measured against the engine's default model. */
export function contextWindowLimit(engine: AgentEngine, model: AgentModel): number {
  const { models, defaultModel } = ENGINES[engine];
  return (models.find((spec) => spec.id === model) ?? models.find((spec) => spec.id === defaultModel))?.contextWindow ?? 0;
}
