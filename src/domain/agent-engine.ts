import type { CoordinationRole } from "./coordination.js";
import type { AgentEffort, ExecutionPolicy } from "./run.js";

/** The backends that can run a task. Each offers its own models, efforts, and context windows. */
export type AgentEngine = "claude" | "codex" | "opencode";
export const DEFAULT_ENGINE: AgentEngine = "claude";

/**
 * Every effort any engine offers, deepest first, which is the order pickers list them in. Which of
 * them a model takes is the model's own business, so each model names its own. The order is the
 * description, so only an effort that does something else says anything.
 */
const EFFORTS = {
  ultra: { label: "Ultra", description: "Splits the work across agents", delegates: true },
  max: { label: "Max" },
  xhigh: { label: "Extra high" },
  high: { label: "High" },
  medium: { label: "Medium" },
  low: { label: "Low" },
} as const satisfies Record<AgentEffort, Omit<EffortSpec, "id">>;

/** Deepest first. A clamp walks this to find the nearest effort a model will take. */
const EFFORT_ORDER = Object.keys(EFFORTS) as readonly AgentEffort[];

/** The named efforts as specs, always deepest first however they were named. */
export function efforts(...ids: readonly AgentEffort[]): readonly EffortSpec[] {
  return EFFORT_ORDER.filter((id) => ids.includes(id)).map((id) => ({ id, ...EFFORTS[id] }));
}

const EFFORTS_THROUGH_MAX = efforts("max", "xhigh", "high", "medium", "low");
/** Codex's deepest tier hands work to sub-agents, which its smallest model does not do. */
const EFFORTS_THROUGH_ULTRA = efforts("ultra", ...EFFORTS_THROUGH_MAX.map((spec) => spec.id));

/** The efforts the Claude SDK accepts, which its `EffortLevel` type must keep matching. */
export type ClaudeEffort = Exclude<AgentEffort, "ultra">;

const CLAUDE_MODELS = [
  { id: "fable", label: "Fable", description: "Most capable for demanding work", contextWindow: 1_000_000, efforts: EFFORTS_THROUGH_MAX, manualCompaction: true },
  { id: "opus", label: "Opus", description: "Best for complex reasoning", contextWindow: 1_000_000, efforts: EFFORTS_THROUGH_MAX, manualCompaction: true },
  { id: "sonnet", label: "Sonnet", description: "Balanced speed and capability", contextWindow: 1_000_000, efforts: EFFORTS_THROUGH_MAX, manualCompaction: true },
  { id: "haiku", label: "Haiku", description: "Fastest for lightweight work", contextWindow: 200_000, efforts: [], manualCompaction: true, delegable: false },
] as const;

/** The default context window in Codex's model catalogue, used until the server reports its own. */
const CODEX_CONTEXT_WINDOW = 272_000;

const CODEX_MODELS = [
  { id: "gpt-6-astra", label: "Astra", description: "Most capable model for complex, demanding work", contextWindow: CODEX_CONTEXT_WINDOW, efforts: EFFORTS_THROUGH_ULTRA, manualCompaction: true },
  { id: "gpt-6.1-sol", label: "Sol", description: "Strong coding model for everyday work", contextWindow: CODEX_CONTEXT_WINDOW, efforts: EFFORTS_THROUGH_ULTRA, manualCompaction: true },
  { id: "gpt-5.6-terra", label: "Terra", description: "Balanced agentic coding model for everyday work", contextWindow: CODEX_CONTEXT_WINDOW, efforts: EFFORTS_THROUGH_ULTRA, manualCompaction: true },
  { id: "gpt-6-luna", label: "Luna", description: "Efficient model for lightweight work", contextWindow: CODEX_CONTEXT_WINDOW, efforts: EFFORTS_THROUGH_MAX, manualCompaction: true },
] as const;

/** A model this build ships knowing. */
export type BuiltInModel = (typeof CLAUDE_MODELS)[number]["id"] | (typeof CODEX_MODELS)[number]["id"];

/**
 * A model id as an engine names it. An engine may report models this build never heard of, so any
 * well-formed id is one; whether an engine offers it is the catalogue's to say.
 */
export type AgentModel = BuiltInModel | (string & {});

/** Long enough for a provider-qualified id, short enough that a stray payload cannot ride in as one. */
const MODEL_ID_LIMIT = 256;
const MODEL_ID_SHAPE = /^[^\s\p{Cc}]+$/u;

/** True for a well-formed model id, known here or not. A name every object inherits is never one, since ids key plain records. */
export function isModelId(value: unknown): value is AgentModel {
  return typeof value === "string" && value.length <= MODEL_ID_LIMIT && MODEL_ID_SHAPE.test(value) && !Object.hasOwn(Object.prototype, value);
}

/** Models the catalogue replaced, each read as its successor wherever a saved setting still names it. */
const RETIRED_MODELS: Readonly<Record<string, BuiltInModel>> = { "gpt-5.6-sol": "gpt-6.1-sol", "gpt-6-sol": "gpt-6.1-sol", "gpt-5.6-luna": "gpt-6-luna" };

export function currentModel(value: unknown): unknown {
  return typeof value === "string" && Object.hasOwn(RETIRED_MODELS, value) ? RETIRED_MODELS[value] : value;
}

/**
 * Runs always request the widest context a model offers, so `contextWindow` is that ceiling. An
 * empty `efforts` is a model that takes no effort at all, which is drawn as no effort control.
 * `manualCompaction` is the model compacting its thread on request, without a user message.
 * `delegable: false` is a model a coordinator may not start a thread on. `provider` names who serves
 * the model, for an engine that runs models from many, which pickers list it under.
 */
export type ModelSpec = { id: AgentModel; label: string; description: string; contextWindow: number; efforts: readonly EffortSpec[]; manualCompaction?: boolean; delegable?: false; provider?: string };

/** `delegates` is an effort that hands work to the engine's own agents, which a coordinator never takes. */
export type EffortSpec = { id: AgentEffort; label: string; description?: string; delegates?: true };

/** The panels and controls an engine can feed; one that cannot is not drawn for its threads. */
export type EngineCapabilities = {
  fastMode: boolean;
  workflows: boolean;
  subagents: boolean;
  /** Can recover a saved subagent's settings without running it again. */
  subagentMetadata: boolean;
  /** Reviewing the thread's changes is work the engine performs itself, not a prompt it is sent. */
  review: boolean;
  /** The modes the engine can keep its promise for, in no particular order. */
  policies: readonly ExecutionPolicy[];
  /** The mode a run nobody watches gets, such as a reviewer's, so it never waits on an approval. */
  unattendedPolicy: ExecutionPolicy;
};

const EVERY_POLICY: readonly ExecutionPolicy[] = ["confirm", "plan", "allow-edits", "autonomous", "bypass"];

/**
 * Asking least first. A mode an engine lacks falls to the nearest one after it. Plan is a different
 * kind of run rather than a step here, so it falls to confirm like any mode with none offered after it.
 */
const POLICY_ORDER: readonly ExecutionPolicy[] = ["bypass", "autonomous", "allow-edits", "confirm"];

/** How an engine's models are known: a list this build ships with, or only once the engine names them. */
type EngineModels = { kind: "built-in"; list: readonly ModelSpec[]; default: AgentModel } | { kind: "discovered" };

type EngineSpec = {
  label: string;
  models: EngineModels;
  defaultEffort: AgentEffort;
  capabilities: EngineCapabilities;
};

/** The default engine's own default, which a draft lands on when its engine has none to offer. */
export const DEFAULT_MODEL: AgentModel = "opus";

const ENGINES: Record<AgentEngine, EngineSpec> = {
  claude: {
    label: "Claude",
    models: { kind: "built-in", list: CLAUDE_MODELS, default: DEFAULT_MODEL },
    defaultEffort: "high",
    capabilities: { fastMode: false, workflows: true, subagents: true, subagentMetadata: true, review: false, policies: EVERY_POLICY, unattendedPolicy: "autonomous" },
  },
  codex: {
    label: "Codex",
    models: { kind: "built-in", list: CODEX_MODELS, default: "gpt-6.1-sol" },
    defaultEffort: "high",
    capabilities: { fastMode: true, workflows: false, subagents: true, subagentMetadata: true, review: true, policies: EVERY_POLICY, unattendedPolicy: "autonomous" },
  },
  opencode: {
    label: "OpenCode",
    models: { kind: "discovered" },
    defaultEffort: "high",
    /** Auto stands on a reviewer that judges each call, which OpenCode has none of. */
    capabilities: { fastMode: false, workflows: false, subagents: false, subagentMetadata: false, review: false, policies: ["confirm", "plan", "allow-edits", "bypass"], unattendedPolicy: "bypass" },
  },
};

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
  /** The newest release, named only when the installed one is older. */
  latest?: string;
  /**
   * The command that installs this engine, or that upgrades it the way the user already has it.
   * Absent for an install the app cannot upgrade, such as one a version manager keeps.
   */
  fix?: string;
  /** The catalogue models the installed command can run. Absent means it runs all of them. */
  models?: readonly AgentModel[];
  /** The models the engine names for itself, in place of the ones this build ships knowing. */
  catalog?: readonly ModelSpec[];
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
  /** True when the app can run `fix` itself, which it does for an installed command that is behind. */
  updatable?: true;
};

/**
 * What is wrong with this engine on this machine, or nothing when it is fine. A signed-out engine is
 * left out: signing in is a button rather than a sentence.
 */
export function engineNotice(engine: AgentEngine, readiness: EngineReadiness): EngineNotice | null {
  const label = engineLabel(engine);
  const fix = readiness.fix ? { fix: readiness.fix } : {};
  const update = readiness.fix ? { fix: readiness.fix, updatable: true as const } : {};
  const named = `${label} ${readiness.version ?? "on this machine"}`;
  if (readiness.access === "missing") return { blocking: true, message: `${label} is not installed.`, ...fix };
  if (readiness.access === "outdated") return { blocking: true, message: `${named} is too old. Update to ${readiness.required}.`, ...update };
  if (readiness.access === "unavailable") return { blocking: true, message: `${label} is installed but would not start.` };
  if (readiness.access === "ready" && readiness.catalog?.length === 0) return { blocking: true, message: `${label} has no models. Connect a provider first.`, ...fix };
  /** Ready, but behind: it runs, and the models it never heard of are simply missing from the menu. */
  if (readiness.required) return { blocking: false, message: `${named} is behind ${readiness.required}, so some models are hidden.`, ...update };
  return null;
}

/** A version an installed engine can move to, the one it is on, and the command that moves it when the app can run it. */
export type EngineUpdate = { target: string; version?: string; command?: string };

/** What this engine could update to, aiming for the newest release, or nothing when it is current or not installed. */
export function engineUpdate(readiness: EngineReadiness): EngineUpdate | null {
  const target = readiness.latest ?? readiness.required;
  if (readiness.access === "missing" || !target) return null;
  return { target, ...(readiness.version ? { version: readiness.version } : {}), ...(readiness.fix ? { command: readiness.fix } : {}) };
}

/**
 * Why this engine cannot take a run, in the words the user needs to clear it, or nothing when it
 * can. An engine that runs but is behind is not a blocker, however old it is.
 */
export function engineBlocker(engine: AgentEngine, readiness: EngineReadiness): string | null {
  const notice = engineNotice(engine, readiness);
  if (!notice?.blocking) return null;
  if (notice.updatable) return `${notice.message} Update it in Settings.`;
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

const EFFORT_IDS = new Set<string>(EFFORT_ORDER);

type CatalogEntry = { engine: AgentEngine; spec: ModelSpec; efforts: readonly EffortSpec[]; coordinatorEfforts: readonly EffortSpec[] };

/**
 * The models each engine offers, and what each of them takes. Ids are unique across the catalogue;
 * where two engines name the same one, the engine listed first owns it and the other does not list it.
 */
export type ModelCatalog = {
  readonly models: Readonly<Record<AgentEngine, readonly ModelSpec[]>>;
  readonly entries: ReadonlyMap<string, CatalogEntry>;
};

/** A spec a newer build or an engine sent is only listed when it is one this build can read. */
function isReadableSpec(value: unknown): value is ModelSpec {
  const spec = value as Partial<ModelSpec> | null;
  return typeof spec === "object" && spec !== null && isModelId(spec.id) && typeof spec.label === "string"
    && Array.isArray(spec.efforts) && spec.efforts.every((effort: unknown) => typeof effort === "object" && effort !== null && isAgentEffort((effort as EffortSpec).id) && typeof (effort as EffortSpec).label === "string");
}

export function modelCatalog(lists: Readonly<Record<AgentEngine, readonly ModelSpec[]>>): ModelCatalog {
  const entries = new Map<string, CatalogEntry>();
  const models = byEngine((engine) => lists[engine].filter((spec) => {
    if (!isReadableSpec(spec) || entries.has(spec.id)) return false;
    entries.set(spec.id, { engine, spec, efforts: spec.efforts, coordinatorEfforts: spec.efforts.filter((effort) => !effort.delegates) });
    return true;
  }));
  return { models, entries };
}

const BUILT_IN_LISTS: Readonly<Record<AgentEngine, readonly ModelSpec[]>> = byEngine((engine) => {
  const models = ENGINES[engine].models;
  return models.kind === "built-in" ? models.list : [];
});

/** The models this build ships knowing, which stand for every engine that names none of its own. */
export const BUILT_IN_MODELS: ModelCatalog = modelCatalog(BUILT_IN_LISTS);

const statusCatalogs = new WeakMap<EngineStatus, ModelCatalog>();

/** The catalogue a machine's engines make up: each engine's own list where it names one, else the built-in one. Kept per status, so a picker reads one stable catalogue. */
export function engineCatalog(status: EngineStatus | null | undefined): ModelCatalog {
  const named = (engine: AgentEngine) => Array.isArray(status?.[engine]?.catalog) ? status[engine].catalog : undefined;
  if (!status || !AGENT_ENGINES.some(named)) return BUILT_IN_MODELS;
  let catalog = statusCatalogs.get(status);
  if (!catalog) {
    catalog = modelCatalog(byEngine((engine) => named(engine) ?? BUILT_IN_LISTS[engine]));
    statusCatalogs.set(status, catalog);
  }
  return catalog;
}

export function isAgentEngine(value: unknown): value is AgentEngine {
  return typeof value === "string" && Object.hasOwn(ENGINES, value);
}

/** True for a model the catalogue offers on any engine; use `engineHasModel` to ask about one engine. */
export function catalogHasModel(catalog: ModelCatalog, model: AgentModel): boolean {
  return catalog.entries.has(model);
}

export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string" && EFFORT_IDS.has(value);
}

/** Reported provider values use the same names as the picker, while unfamiliar efforts remain readable. */
export function effortLabel(value: string) {
  return isAgentEffort(value) ? EFFORTS[value].label : value;
}

export function engineHasModel(catalog: ModelCatalog, engine: AgentEngine, model: AgentModel) {
  return catalog.entries.get(model)?.engine === engine;
}

/** True once an engine's models are known: it ships knowing them, or main has named them. One only a newer build knows offers none here, which is known. */
export function engineModelsKnown(status: EngineStatus | null | undefined, engine: AgentEngine) {
  return engineSpec(engine)?.models.kind !== "discovered" || Array.isArray(status?.[engine]?.catalog);
}

/** The engine that offers a model, or none for one the catalogue does not hold, as a newer computer may send. */
export function modelEngine(catalog: ModelCatalog, model: AgentModel): AgentEngine | undefined {
  return catalog.entries.get(model)?.engine;
}

/** The engine that offers a model the caller already knows the catalogue holds. */
export function engineForModel(catalog: ModelCatalog, model: AgentModel): AgentEngine {
  const engine = modelEngine(catalog, model);
  if (!engine) throw new Error(`No engine offers the ${model} model.`);
  return engine;
}

/** Why a model the catalogue does not hold cannot be picked. */
export function unknownModel(model: AgentModel): string {
  return `No engine here offers the ${model} model. Pick another model.`;
}

/** Why a thread that names no model cannot run while its engine has yet to name one. */
export function noModel(engine: AgentEngine): string {
  return `${engineLabel(engine)} has not named a model for this thread yet. Pick a model.`;
}

/** A name with case, spaces and punctuation dropped, so "GLM 5.3 Flash" and "glm-5.3-flash" read alike. */
function plainName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The model a name means: the id itself, else the one model whose own id or label reads the same.
 * Where several do, the pinned one wins; otherwise the name is refused with the ones it could mean,
 * since the same model from two providers differs in price and limits.
 */
export function resolveModel(catalog: ModelCatalog, name: AgentModel, favorites: readonly AgentModel[]): { model: AgentModel } | { error: string } {
  if (catalog.entries.has(name)) return { model: name };
  const plain = plainName(name);
  const matches = plain ? [...catalog.entries.values()].filter(({ spec }) => plainName(spec.id.slice(spec.id.lastIndexOf("/") + 1)) === plain || plainName(spec.label) === plain).map(({ spec }) => spec.id) : [];
  const pinned = matches.filter((model) => favorites.includes(model));
  const meant = pinned.length ? pinned : matches;
  if (meant.length === 1) return { model: meant[0]! };
  if (meant.length > 1) return { error: `${name} could mean ${meant.join(", ")}. Name one of them, or pin the one you mean in the model picker.` };
  return { error: unknownModel(name) };
}

/** Manual context compaction belongs to the model, so an engine that does not offer it cannot ask. */
export function modelSupportsManualCompaction(catalog: ModelCatalog, engine: AgentEngine, model: AgentModel) {
  const entry = catalog.entries.get(model);
  return entry?.engine === engine && entry.spec.manualCompaction === true;
}

export function modelDelegable(catalog: ModelCatalog, model: AgentModel) {
  return catalog.entries.get(model)?.spec.delegable !== false;
}

/** An effort Claude does not offer lands on its default, so a foreign one never reaches the SDK. */
export function claudeEffort(effort: AgentEffort): ClaudeEffort {
  return EFFORTS_THROUGH_MAX.some((spec) => spec.id === effort) ? effort as ClaudeEffort : "high";
}

/** True for an effort at least one of the engine's models takes; ask `modelHasEffort` about a model. */
export function engineHasEffort(catalog: ModelCatalog, engine: AgentEngine, effort: AgentEffort) {
  return modelsFor(catalog, engine).some((model) => model.efforts.some((spec) => spec.id === effort));
}

export function modelHasEffort(catalog: ModelCatalog, model: AgentModel, effort: AgentEffort, role?: CoordinationRole) {
  return effortsFor(catalog, model, role).some((spec) => spec.id === effort);
}

/** False for a model that reasons at one depth, whose threads are run and drawn without an effort. */
export function modelTakesEffort(catalog: ModelCatalog, model: AgentModel) {
  return effortsFor(catalog, model).length > 0;
}

/**
 * The effort a run on this model actually gets: the one asked for where the model takes it, else the
 * nearest one below. A model that takes no effort keeps what it was given, since nothing reads it.
 */
export function effortForModel(catalog: ModelCatalog, model: AgentModel, effort: AgentEffort, role?: CoordinationRole): AgentEffort {
  /** An effort only a newer build knows is kept as it is, as nothing here can say what it is nearest. */
  if (!isAgentEffort(effort)) return effort;
  const offered = effortsFor(catalog, model, role);
  if (offered.length === 0 || offered.some((spec) => spec.id === effort)) return effort;
  const asked = EFFORT_ORDER.indexOf(effort);
  return (offered.find((spec) => EFFORT_ORDER.indexOf(spec.id) >= asked) ?? offered[offered.length - 1]!).id;
}

/**
 * The engine's own record, or none for an engine only a newer build on a paired computer knows. What
 * is read off it below falls back to what keeps the window drawing, for a thread it shows read-only.
 */
function engineSpec(engine: AgentEngine): EngineSpec | undefined {
  return Object.hasOwn(ENGINES, engine) ? ENGINES[engine] : undefined;
}

const NO_CAPABILITIES: EngineCapabilities = { fastMode: false, workflows: false, subagents: false, subagentMetadata: false, review: false, policies: [], unattendedPolicy: "confirm" };

export function modelsFor(catalog: ModelCatalog, engine: AgentEngine): readonly ModelSpec[] {
  return Object.hasOwn(catalog.models, engine) ? catalog.models[engine] : [];
}

/**
 * The efforts this model takes, deepest first. Empty for a model that takes none. A coordinator hands
 * work only to threads the user can see, never to the engine's own agents, so it takes none of the
 * efforts that would, whichever engine it runs on.
 */
export function effortsFor(catalog: ModelCatalog, model: AgentModel, role?: CoordinationRole): readonly EffortSpec[] {
  const entry = catalog.entries.get(model);
  if (!entry) return [];
  return role === "coordinator" ? entry.coordinatorEfforts : entry.efforts;
}

/** The default this build ships for the engine; none for one whose models are only known once it names them. */
export function defaultModelFor(engine: AgentEngine): AgentModel | undefined {
  const models = engineSpec(engine)?.models;
  return models?.kind === "built-in" ? models.default : undefined;
}

/** The engine's default where the catalogue offers it, else the first model the engine lists; none for an engine that lists none. */
export function defaultModelIn(catalog: ModelCatalog, engine: AgentEngine): AgentModel | undefined {
  const fixed = defaultModelFor(engine);
  return fixed !== undefined && engineHasModel(catalog, engine, fixed) ? fixed : modelsFor(catalog, engine)[0]?.id ?? fixed;
}

/** The model a thread runs on: its own, else its engine's default in the catalogue; none while that engine has yet to name any. */
export function threadModel(catalog: ModelCatalog, thread: { engine: AgentEngine; model?: AgentModel }): AgentModel | undefined {
  return thread.model ?? defaultModelIn(catalog, thread.engine);
}

export function defaultEffortFor(engine: AgentEngine): AgentEffort {
  return (engineSpec(engine) ?? ENGINES[DEFAULT_ENGINE]).defaultEffort;
}

/** An engine only a newer build knows can do nothing here. */
export function capabilitiesFor(engine: AgentEngine): EngineCapabilities {
  return engineSpec(engine)?.capabilities ?? NO_CAPABILITIES;
}

/** The mode a run on this engine gets: the one asked for where the engine offers it, else the nearest that asks more. */
export function policyFor(engine: AgentEngine, policy: ExecutionPolicy): ExecutionPolicy {
  const offered = capabilitiesFor(engine).policies;
  if (offered.includes(policy)) return policy;
  const asked = POLICY_ORDER.indexOf(policy);
  return (asked < 0 ? undefined : POLICY_ORDER.slice(asked).find((candidate) => offered.includes(candidate))) ?? "confirm";
}

/** What the engine is called wherever the app speaks of the agent running a thread; one only a newer build knows, by its own id. */
export function engineLabel(engine: AgentEngine): string {
  return engineSpec(engine)?.label ?? engine;
}

/** What stands in for the composer of a thread on an engine only a newer build knows, which this one shows read-only. */
export function unopenableEngine(engine: string): string {
  return `Runs on ${engine}, which this version can't open. Update to work in it here.`;
}

/** A model by the name the composer gives it, or by its id for one the catalogue does not hold, such as one a paired computer's newer build ran. */
export function modelLabel(catalog: ModelCatalog, model: string): string {
  return catalog.entries.get(model)?.spec.label ?? model;
}

/** One value per engine, built now so a picker reads a stable list instead of building one per render. */
export function byEngine<T>(build: (engine: AgentEngine) => T): Record<AgentEngine, T> {
  return Object.fromEntries(AGENT_ENGINES.map((engine) => [engine, build(engine)])) as Record<AgentEngine, T>;
}

/** A model the engine does not offer is measured against the engine's default model. */
export function contextWindowLimit(catalog: ModelCatalog, engine: AgentEngine, model: AgentModel): number {
  if (!engineSpec(engine)) return 0;
  const models = modelsFor(catalog, engine);
  const defaultModel = defaultModelIn(catalog, engine);
  if (defaultModel === undefined) return models.find((spec) => spec.id === model)?.contextWindow ?? 0;
  return (models.find((spec) => spec.id === model) ?? models.find((spec) => spec.id === defaultModel))?.contextWindow ?? 0;
}
