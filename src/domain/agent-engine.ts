import type { AgentEffort } from "./run.js";

/** The backends that can run a task. Each offers its own models, efforts, and context windows. */
export type AgentEngine = "claude" | "codex";
export const DEFAULT_ENGINE: AgentEngine = "claude";

const CLAUDE_MODELS = [
  { id: "fable", label: "Fable", description: "Most capable for demanding work", contextWindow: 1_000_000 },
  { id: "opus", label: "Opus", description: "Best for complex reasoning", contextWindow: 1_000_000 },
  { id: "sonnet", label: "Sonnet", description: "Balanced speed and capability", contextWindow: 1_000_000 },
  { id: "haiku", label: "Haiku", description: "Fastest for lightweight work", contextWindow: 200_000 },
] as const;

const CLAUDE_EFFORTS = [
  { id: "max", label: "Max effort", description: "Everything the model has, slowest" },
  { id: "xhigh", label: "Extra high effort", description: "Deeper than high, where the model offers it" },
  { id: "high", label: "High effort", description: "Deep reasoning" },
  { id: "medium", label: "Medium effort", description: "Moderate thinking" },
  { id: "low", label: "Low effort", description: "Minimal thinking, fastest replies" },
] as const satisfies readonly EffortSpec[];

/** The efforts the Claude SDK accepts, which its `EffortLevel` type must keep matching. */
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]["id"];

/** Codex's model catalogue exposes no context window; 272k is what its GPT-5 line documents. */
const CODEX_CONTEXT_WINDOW = 272_000;

const CODEX_MODELS = [
  { id: "gpt-5.6-sol", label: "Sol", description: "Latest frontier agentic coding model", contextWindow: CODEX_CONTEXT_WINDOW },
  { id: "gpt-5.6-terra", label: "Terra", description: "Balanced agentic coding model for everyday work", contextWindow: CODEX_CONTEXT_WINDOW },
  { id: "gpt-5.6-luna", label: "Luna", description: "Efficient model for lightweight work", contextWindow: CODEX_CONTEXT_WINDOW },
] as const;

const CODEX_EFFORTS: readonly EffortSpec[] = [
  { id: "ultra", label: "Ultra effort", description: "Deepest reasoning Codex offers, slowest" },
  { id: "xhigh", label: "Extra high effort", description: "Deeper than high" },
  { id: "high", label: "High effort", description: "Deep reasoning" },
  { id: "medium", label: "Medium effort", description: "Moderate thinking" },
  { id: "low", label: "Low effort", description: "Minimal thinking, fastest replies" },
];

export type AgentModel = (typeof CLAUDE_MODELS)[number]["id"] | (typeof CODEX_MODELS)[number]["id"];

/** Runs always request the widest context a model offers, so `contextWindow` is that ceiling. */
export type ModelSpec = { id: AgentModel; label: string; description: string; contextWindow: number };

export type EffortSpec = { id: AgentEffort; label: string; description: string };

/** The panels and controls an engine can feed; one that cannot is not drawn for its threads. */
export type EngineCapabilities = {
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
    capabilities: { workflows: true, subagents: true },
  },
  codex: {
    label: "Codex",
    models: CODEX_MODELS,
    defaultModel: "gpt-5.6-sol",
    efforts: CODEX_EFFORTS,
    defaultEffort: "high",
    capabilities: { workflows: false, subagents: true },
  },
};

export const DEFAULT_MODEL: AgentModel = ENGINES[DEFAULT_ENGINE].defaultModel;

/** Every engine, in the order pickers list them. */
export const AGENT_ENGINES = Object.keys(ENGINES) as readonly AgentEngine[];

/** Whether an engine can take a run right now, or what stands in the way. */
export type EngineAccess = "ready" | "signed-out" | "unavailable";
/** The access of the engines whose access can change. One not named is always ready. */
export type EngineStatus = Partial<Record<AgentEngine, EngineAccess>>;

const MODEL_IDS = new Set<string>(AGENT_ENGINES.flatMap((engine) => ENGINES[engine].models.map((model) => model.id)));
const EFFORT_IDS = new Set<string>(AGENT_ENGINES.flatMap((engine) => ENGINES[engine].efforts.map((effort) => effort.id)));

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

/** The engine that owns a model. Model ids are unique across the app catalogue. */
export function engineForModel(model: AgentModel): AgentEngine {
  const engine = AGENT_ENGINES.find((candidate) => engineHasModel(candidate, model));
  if (!engine) throw new Error(`No engine offers the ${model} model.`);
  return engine;
}

/** Manual context compaction is currently a Sol protocol capability, not a general Codex command. */
export function modelSupportsManualCompaction(engine: AgentEngine, model: AgentModel) {
  return engine === "codex" && model === "gpt-5.6-sol";
}

/** An effort Claude does not offer lands on its default, so a foreign one never reaches the SDK. */
export function claudeEffort(effort: AgentEffort): ClaudeEffort {
  return CLAUDE_EFFORTS.some((spec) => spec.id === effort) ? effort as ClaudeEffort : "high";
}

export function engineHasEffort(engine: AgentEngine, effort: AgentEffort) {
  return ENGINES[engine].efforts.some((spec) => spec.id === effort);
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
  return Object.fromEntries(AGENT_ENGINES.map((engine) => [engine, build(engine)])) as Record<AgentEngine, T>;
}

/** A model the engine does not offer is measured against the engine's default model. */
export function contextWindowLimit(engine: AgentEngine, model: AgentModel): number {
  const { models, defaultModel } = ENGINES[engine];
  return (models.find((spec) => spec.id === model) ?? models.find((spec) => spec.id === defaultModel))?.contextWindow ?? 0;
}
