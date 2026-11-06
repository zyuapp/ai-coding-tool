import { AGENT_ENGINES, byEngine, engineLabel, engineNotice, isFavorite, modelsFor, type AgentEngine, type AgentModel, type EngineModel, type EngineNotice, type EngineReadiness, type ModelCatalog, type ModelSpec } from "./agent-engine.js";

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

/** Favorites, every model, or one heading by its key. */
export type LibraryFilter = "favorites" | "all" | (string & {});

export type LibraryOptions = {
  /** The thread's engine, or the draft's. */
  engine: AgentEngine;
  /** Set once the thread has an engine for good. */
  locked: boolean;
  favorites?: readonly EngineModel[];
  filter?: LibraryFilter;
  query?: string;
  /** Narrows the library to the models this choice may take. */
  allows?: (engine: AgentEngine, model: AgentModel) => boolean;
};

export type ModelLibrary = {
  /** Every heading with the models this choice may take, which a filter rail lists and counts. */
  available: readonly LibraryGroup[];
  /** The headings the filter or search leaves, with the models they leave. */
  shown: readonly LibraryGroup[];
  /** How many models `shown` holds, `available` holds, and are pinned. */
  count: number;
  total: number;
  favoriteCount: number;
  heading: string;
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

/** The library a model picker draws: which headings it lists, what each lets the user pick, and what stands in the way. */
export function modelLibrary(catalog: ModelCatalog, access: Readonly<Record<AgentEngine, EngineReadiness>>, options: LibraryOptions): ModelLibrary {
  const { engine, favorites = [], filter = "all", allows } = options;
  const search = options.query?.trim().toLocaleLowerCase() ?? "";
  const pinned = (group: Heading, spec: ModelSpec) => isFavorite(favorites, group.engine, spec.id);
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
  const shown = available
    .filter((group) => search || filter === "all" || filter === "favorites" || filter === group.key)
    .map((group) => ({
      ...group,
      models: group.models.filter((spec) => search ? `${group.label} ${spec.label} ${spec.id} ${spec.description}`.toLocaleLowerCase().includes(search) : filter !== "favorites" || pinned(group, spec)),
    }))
    .filter((group) => group.models.length || !(search || filter === "favorites"));
  let heading = "All models";
  if (filter === "favorites") heading = "Favorites";
  else if (filter !== "all") heading = available.find((group) => group.key === filter)?.label ?? filter;
  if (search) heading = "Search results";
  return {
    available,
    shown,
    count: shown.reduce((total, group) => total + group.models.length, 0),
    total: available.reduce((total, group) => total + group.models.length, 0),
    favoriteCount: available.reduce((total, group) => total + group.models.filter((spec) => pinned(group, spec)).length, 0),
    heading,
  };
}

/** Where the library opens: a settled thread on the heading holding its model, else Favorites while any are pinned. */
export function libraryOpening(catalog: ModelCatalog, options: { engine: AgentEngine; locked: boolean; model: AgentModel | undefined; favorites?: readonly EngineModel[] }): LibraryFilter {
  if (options.locked) {
    const own = headingsOf(catalog).filter((heading) => heading.engine === options.engine);
    return (own.find((heading) => heading.models.some((spec) => spec.id === options.model)) ?? own[0])?.key ?? "all";
  }
  return options.favorites?.length ? "favorites" : "all";
}
