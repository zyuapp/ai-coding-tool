import type { AgentEffort } from "./run.js";

/** The backends that can run a task. Each offers its own models, efforts, and context windows. */
export type AgentEngine = "claude" | "codex";
export const DEFAULT_ENGINE: AgentEngine = "claude";

/**
 * Every effort any engine offers, deepest first, which is the order pickers list them in. Which of
 * them a model takes is the model's own business, so each model names its own.
 */
const EFFORTS = {
  ultra: { label: "Ultra effort", description: "Deepest reasoning, splitting work across agents" },
  max: { label: "Max effort", description: "Everything the model has, slowest" },
  xhigh: { label: "Extra high effort", description: "Deeper than high" },
  high: { label: "High effort", description: "Deep reasoning" },
  medium: { label: "Medium effort", description: "Moderate thinking" },
  low: { label: "Low effort", description: "Minimal thinking, fastest replies" },
} as const satisfies Record<AgentEffort, Omit<EffortSpec, "id">>;

/** Deepest first. A clamp walks this to find the nearest effort a model will take. */
const EFFORT_ORDER = Object.keys(EFFORTS) as readonly AgentEffort[];

/** The named efforts as specs, always deepest first however they were named. */
function efforts(...ids: readonly AgentEffort[]): readonly EffortSpec[] {
  return EFFORT_ORDER.filter((id) => ids.includes(id)).map((id) => ({ id, ...EFFORTS[id] }));
}

const EFFORTS_THROUGH_MAX = efforts("max", "xhigh", "high", "medium", "low");
/** Codex's deepest tier hands work to sub-agents, which its smallest model does not do. */
const EFFORTS_THROUGH_ULTRA = efforts("ultra", ...EFFORTS_THROUGH_MAX.map((spec) => spec.id));

/** The efforts the Claude SDK accepts, which its `EffortLevel` type must keep matching. */
export type ClaudeEffort = Exclude<AgentEffort, "ultra">;

const CLAUDE_MODELS = [
  { id: "fable", label: "Fable", description: "Most capable for demanding work", contextWindow: 1_000_000, efforts: EFFORTS_THROUGH_MAX },
  { id: "opus", label: "Opus", description: "Best for complex reasoning", contextWindow: 1_000_000, efforts: EFFORTS_THROUGH_MAX },
  { id: "sonnet", label: "Sonnet", description: "Balanced speed and capability", contextWindow: 1_000_000, efforts: EFFORTS_THROUGH_MAX },
  { id: "haiku", label: "Haiku", description: "Fastest for lightweight work", contextWindow: 200_000, efforts: [] },
] as const;

/** Codex's model catalogue exposes no context window; 272k is what its GPT-5 line documents. */
const CODEX_CONTEXT_WINDOW = 272_000;

const CODEX_MODELS = [
  { id: "gpt-5.6-sol", label: "Sol", description: "Latest frontier agentic coding model", contextWindow: CODEX_CONTEXT_WINDOW, efforts: EFFORTS_THROUGH_ULTRA },
  { id: "gpt-5.6-terra", label: "Terra", description: "Balanced agentic coding model for everyday work", contextWindow: CODEX_CONTEXT_WINDOW, efforts: EFFORTS_THROUGH_ULTRA },
  { id: "gpt-5.6-luna", label: "Luna", description: "Efficient model for lightweight work", contextWindow: CODEX_CONTEXT_WINDOW, efforts: EFFORTS_THROUGH_MAX },
] as const;

export type AgentModel = (typeof CLAUDE_MODELS)[number]["id"] | (typeof CODEX_MODELS)[number]["id"];

/**
 * Runs always request the widest context a model offers, so `contextWindow` is that ceiling. An
 * empty `efforts` is a model that takes no effort at all, which is drawn as no effort control.
 */
export type ModelSpec = { id: AgentModel; label: string; description: string; contextWindow: number; efforts: readonly EffortSpec[] };

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
  defaultEffort: AgentEffort;
  capabilities: EngineCapabilities;
};

const ENGINES: Record<AgentEngine, EngineSpec> = {
  claude: {
    label: "Claude",
    models: CLAUDE_MODELS,
    defaultModel: "opus",
    defaultEffort: "high",
    capabilities: { workflows: true, subagents: true },
  },
  codex: {
    label: "Codex",
    models: CODEX_MODELS,
    defaultModel: "gpt-5.6-sol",
    defaultEffort: "high",
    capabilities: { workflows: false, subagents: true },
  },
};

export const DEFAULT_MODEL: AgentModel = ENGINES[DEFAULT_ENGINE].defaultModel;

/** Every engine, in the order pickers list them. */
export const AGENT_ENGINES = Object.keys(ENGINES) as readonly AgentEngine[];

/**
 * Whether an engine can take a run right now, or what stands in the way. The app runs the engine
 * command the user installed, so `missing` means no such command and `outdated` means one too old
 * to speak to; `unavailable` is a command that is present but would not start.
 */
export type EngineAccess = "ready" | "signed-out" | "unavailable" | "missing" | "outdated";

/** What the app found out about an engine on this machine. */
export type EngineReadiness = {
  access: EngineAccess;
  /** What the installed command reported, when one was found. */
  version?: string;
  /** The version the app was built against, named only when the installed one is older. */
  required?: string;
  /** The command that installs or upgrades this engine the way the user already has it. */
  fix?: string;
  /** The catalogue models the installed command can run. Absent means it runs all of them. */
  models?: readonly AgentModel[];
};

/** The readiness of the engines whose readiness can change. One not named is always ready. */
export type EngineStatus = Partial<Record<AgentEngine, EngineReadiness>>;

/** What is wrong with an engine's install, said once for the composer, the model menu, and Settings. */
export type EngineNotice = {
  /** True when this stops a run outright; false for an engine that runs but is behind. */
  blocking: boolean;
  /** What is wrong, without the command that fixes it. */
  message: string;
  /** The command that fixes it, when there is one. */
  fix?: string;
};

/**
 * What is wrong with this engine on this machine, or nothing when it is fine. A signed-out engine is
 * left out: signing in is a button rather than a sentence.
 */
export function engineNotice(engine: AgentEngine, readiness: EngineReadiness): EngineNotice | null {
  const label = engineLabel(engine);
  const fix = readiness.fix ? { fix: readiness.fix } : {};
  const named = `${label} ${readiness.version ?? "on this machine"}`;
  if (readiness.access === "missing") return { blocking: true, message: `${label} is not installed.`, ...fix };
  if (readiness.access === "outdated") return { blocking: true, message: `${named} is too old. This app needs ${readiness.required}.`, ...fix };
  if (readiness.access === "unavailable") return { blocking: true, message: `${label} is installed but would not start.` };
  /** Ready, but behind: it runs, and the models it never heard of are simply missing from the menu. */
  if (readiness.required) return { blocking: false, message: `${named} is behind ${readiness.required}, so some of its models are missing.`, ...fix };
  return null;
}

/**
 * Why this engine cannot take a run, in the words the user needs to clear it, or nothing when it
 * can. An engine that runs but is behind is not a blocker, however old it is.
 */
export function engineBlocker(engine: AgentEngine, readiness: EngineReadiness): string | null {
  const notice = engineNotice(engine, readiness);
  if (!notice?.blocking) return null;
  return notice.fix ? `${notice.message} Run \`${notice.fix}\` to fix it.` : notice.message;
}

/** True when this engine's state is one the user has to clear before any run can start on it. */
export function engineIsBlocked(engine: AgentEngine, readiness: EngineReadiness): boolean {
  return engineNotice(engine, readiness)?.blocking === true;
}

/** True when any engine has something wrong with it, whether it stops a run or only loses models. */
export function engineNeedsAttention(status: EngineStatus | null): boolean {
  return AGENT_ENGINES.some((engine) => status?.[engine] && engineNotice(engine, status[engine]) !== null);
}

const MODEL_SPECS = new Map<string, ModelSpec>(AGENT_ENGINES.flatMap((engine) => ENGINES[engine].models.map((model) => [model.id, model] as const)));
const EFFORT_IDS = new Set<string>(EFFORT_ORDER);

export function isAgentEngine(value: unknown): value is AgentEngine {
  return typeof value === "string" && Object.hasOwn(ENGINES, value);
}

/** True for a model any engine offers; use `engineHasModel` to ask about one engine. */
export function isAgentModel(value: unknown): value is AgentModel {
  return typeof value === "string" && MODEL_SPECS.has(value);
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
  return EFFORTS_THROUGH_MAX.some((spec) => spec.id === effort) ? effort as ClaudeEffort : "high";
}

/** True for an effort at least one of the engine's models takes; ask `modelHasEffort` about a model. */
export function engineHasEffort(engine: AgentEngine, effort: AgentEffort) {
  return ENGINES[engine].models.some((model) => model.efforts.some((spec) => spec.id === effort));
}

export function modelHasEffort(model: AgentModel, effort: AgentEffort) {
  return effortsFor(model).some((spec) => spec.id === effort);
}

/** False for a model that reasons at one depth, whose threads are run and drawn without an effort. */
export function modelTakesEffort(model: AgentModel) {
  return effortsFor(model).length > 0;
}

/**
 * The effort a run on this model actually gets: the one asked for where the model takes it, else the
 * nearest one below. A model that takes no effort keeps what it was given, since nothing reads it.
 */
export function effortForModel(model: AgentModel, effort: AgentEffort): AgentEffort {
  const offered = effortsFor(model);
  if (offered.length === 0 || offered.some((spec) => spec.id === effort)) return effort;
  const asked = EFFORT_ORDER.indexOf(effort);
  return (offered.find((spec) => EFFORT_ORDER.indexOf(spec.id) >= asked) ?? offered[offered.length - 1]!).id;
}

export function modelsFor(engine: AgentEngine): readonly ModelSpec[] {
  return ENGINES[engine].models;
}

/** The efforts this model takes, deepest first. Empty for a model that takes none. */
export function effortsFor(model: AgentModel): readonly EffortSpec[] {
  return MODEL_SPECS.get(model)?.efforts ?? [];
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

/** One value per model, built now so a picker reads a stable list instead of building one per render. */
export function byModel<T>(build: (model: ModelSpec) => T): Record<AgentModel, T> {
  return Object.fromEntries([...MODEL_SPECS.values()].map((spec) => [spec.id, build(spec)])) as Record<AgentModel, T>;
}

/** A model the engine does not offer is measured against the engine's default model. */
export function contextWindowLimit(engine: AgentEngine, model: AgentModel): number {
  const { models, defaultModel } = ENGINES[engine];
  return (models.find((spec) => spec.id === model) ?? models.find((spec) => spec.id === defaultModel))?.contextWindow ?? 0;
}
