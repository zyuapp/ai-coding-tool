import { AGENT_ENGINES, byEngine, engineLabel, engineNotice, isFavorite, modelsFor, type AgentEngine, type AgentModel, type EngineId, type EngineModel, type EngineNotice, type EngineReadiness, type ModelCatalog, type ModelSpec } from "./agent-engine.js";

/** Every engine taken as ready, as a picker reads them before main has said otherwise. */
export const EVERY_ENGINE_READY: Readonly<Record<AgentEngine, EngineReadiness>> = byEngine((): EngineReadiness => ({ access: "ready" }));

/** What an engine's first heading says stands in the way of its models. */
export type LibraryHint =
  /** Another engine than a settled thread's, which only a new thread reaches. */
  | { kind: "new-thread" }
  | { kind: "sign-in" }
  | { kind: "notice"; notice: EngineNotice };

/**
 * One heading of the library: an engine's models, or one provider's for an engine that runs models
 * from many. `first` marks an engine's first heading, which alone carries its hint.
 */
export type LibraryGroup = {
  key: string;
  engine: AgentEngine;
  label: string;
  first: boolean;
  models: readonly ModelSpec[];
  /** Set on another engine than a settled thread's. */
  locked: boolean;
  /** False while the models are listed but cannot be picked: the group is locked, or its engine cannot run. */
  selectable: boolean;
  hint?: LibraryHint;
};

/** One model as the picker lists it. */
export type LibraryEntry = { group: LibraryGroup; spec: ModelSpec; pinned: boolean };

export type LibraryOptions = {
  /** The thread's engine, or the draft's. One only a newer build knows leaves every heading locked when locked. */
  engine: EngineId;
  /** Set once the thread has an engine for good. */
  locked: boolean;
  /** The model in use, which always has a row among the first. */
  model?: AgentModel;
  /** The pinned models, in the order they were pinned. */
  favorites?: readonly EngineModel[];
  query?: string;
  /** Narrows the library to the models this choice may take. */
  allows?: (engine: AgentEngine, model: AgentModel) => boolean;
};

export type ModelLibrary = {
  /** Every heading with the models this choice may take. */
  available: readonly LibraryGroup[];
  /** The heading the model in use sits under, else the engine's first. */
  home?: string;
  /**
   * The rows always in reach: the model in use where it is not pinned, then the pins in the order
   * they were made. With nothing pinned, the models under `home`. A search keeps the ones it matches.
   */
  top: readonly LibraryEntry[];
  /**
   * Every model `top` does not hold, under its heading, for a picker asked for all of them or for
   * what a search matches. A heading left with no models stays only while it has something to say.
   */
  rest: readonly LibraryGroup[];
  /** What stands in the way of the thread's own engine, said beside `top` rather than under a heading. */
  notice?: LibraryGroup;
};

type Heading = Pick<LibraryGroup, "key" | "engine" | "label" | "first" | "models">;

const headings = new WeakMap<ModelCatalog, readonly Heading[]>();

/** Each engine's models under their providers where they name one, built once per catalogue. An engine with none keeps one empty heading. */
function headingsOf(catalog: ModelCatalog): readonly Heading[] {
  let built = headings.get(catalog);
  if (!built) {
    built = AGENT_ENGINES.flatMap((engine): Heading[] => {
      const byProvider = new Map<string, ModelSpec[]>();
      for (const spec of modelsFor(catalog, engine)) {
        const provider = spec.provider ?? "";
        byProvider.set(provider, [...byProvider.get(provider) ?? [], spec]);
      }
      if (!byProvider.size) byProvider.set("", []);
      return [...byProvider].map(([provider, models], index) => ({
        key: provider ? `${engine}:${provider}` : engine,
        engine,
        label: provider || engineLabel(engine),
        first: index === 0,
        models,
      }));
    });
    headings.set(catalog, built);
  }
  return built;
}

function hintOf(heading: Heading, readiness: EngineReadiness, locked: boolean): LibraryHint | undefined {
  if (!heading.first) return undefined;
  if (locked) return { kind: "new-thread" };
  if (readiness.access === "signed-out") return { kind: "sign-in" };
  const notice = engineNotice(heading.engine, readiness);
  return notice ? { kind: "notice", notice } : undefined;
}

/** The library a model picker draws: which rows it keeps in reach, which headings hold the others, what each lets the user pick, and what stands in the way. */
export function modelLibrary(catalog: ModelCatalog, access: Readonly<Record<AgentEngine, EngineReadiness>>, options: LibraryOptions): ModelLibrary {
  const { engine, favorites = [], allows } = options;
  const search = options.query?.trim().toLocaleLowerCase() ?? "";
  const available = headingsOf(catalog).map((heading): LibraryGroup => {
    const readiness = access[heading.engine];
    const locked = options.locked && heading.engine !== engine;
    const hint = hintOf(heading, readiness, locked);
    return {
      ...heading,
      models: heading.models.filter((spec) => (!readiness.models || readiness.models.includes(spec.id)) && (!allows || allows(heading.engine, spec.id))),
      locked,
      selectable: readiness.access === "ready" && !locked,
      ...(hint ? { hint } : {}),
    };
  });
  const entry = (group: LibraryGroup, spec: ModelSpec): LibraryEntry => ({ group, spec, pinned: isFavorite(favorites, group.engine, spec.id) });
  const find = (owner: EngineId, model: AgentModel): LibraryEntry[] => {
    for (const group of available) {
      const spec = group.engine === owner ? group.models.find((candidate) => candidate.id === model) : undefined;
      if (spec) return [entry(group, spec)];
    }
    return [];
  };
  const own = available.filter((group) => group.engine === engine);
  const inUse = options.model === undefined ? [] : find(engine, options.model);
  const home = inUse[0]?.group ?? own[0];
  const pins = favorites.flatMap((favorite) => find(favorite.engine, favorite.model));
  let top = pins.length ? [...inUse.filter((used) => !used.pinned), ...pins] : home?.models.map((spec) => entry(home, spec)) ?? [];
  const held = new Set(top.map(({ group, spec }) => `${group.key}/${spec.id}`));
  const matches = (group: LibraryGroup, spec: ModelSpec) => !search || `${group.label} ${spec.label} ${spec.id}`.toLocaleLowerCase().includes(search);
  top = top.filter(({ group, spec }) => matches(group, spec));
  const notice = own.find((group) => group.hint);
  const rest = available
    .map((group): LibraryGroup => ({
      key: group.key, engine: group.engine, label: group.label, first: group.first, locked: group.locked, selectable: group.selectable,
      models: group.models.filter((spec) => !held.has(`${group.key}/${spec.id}`) && matches(group, spec)),
      ...(group.hint && group !== notice ? { hint: group.hint } : {}),
    }))
    .filter((group) => group.models.length || (!search && group.hint));
  return { available, ...(home ? { home: home.key } : {}), top, rest, ...(notice ? { notice } : {}) };
}
