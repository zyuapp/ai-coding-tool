import { CommandGate, CommandButton, useCommandControls } from "./CommandControl";
import type { IconType } from "react-icons";
import { LuSearch as Search, LuStar as Star, LuGrid2X2 as Grid, LuX as X, LuBrain as Brain, LuCheck as Check, LuChevronDown as ChevronDown, LuFeather as Feather, LuFileCheck2 as FileCheck2, LuGauge as Gauge, LuHand as Hand, LuMoon as Moon, LuShieldOff as ShieldOff, LuSparkles as Sparkles, LuZap as Zap } from "react-icons/lu";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { byEngine, capabilitiesFor, catalogHasModel, effortForModel, effortsFor, engineLabel, isFavorite, modelsFor, offeredPolicies, type AgentEngine, type AgentModel, type EngineModel, type ModelCatalog, type EffortSpec, type EngineNotice, type EngineReadiness } from "../../domain/agent-engine";
import { libraryOpening, modelLibrary, type LibraryFilter } from "../../domain/model-library";
import { useModelCatalog } from "../model-catalog";
import { POLICIES, type AgentEffort, type ExecutionPolicy } from "../../domain/run";
import { moveListFocus, useDismissibleLayer } from "../focus";
import { CopyButton } from "./CopyButton";
import { engineIcon } from "./ThreadEngineIcon";

type Choice<T extends string> = { value: T; label: string; description?: string; icon: IconType; danger?: true };

const MODE_MARKS: Record<ExecutionPolicy, Pick<Choice<ExecutionPolicy>, "icon" | "danger">> = {
  autonomous: { icon: Zap },
  bypass: { icon: ShieldOff, danger: true },
  "allow-edits": { icon: FileCheck2 },
  confirm: { icon: Hand },
  plan: { icon: Hand },
};

/** The modes the picker offers for each engine. */
const modesOf = byEngine((engine) => offeredPolicies(engine).map((policy): Choice<ExecutionPolicy> => ({ value: policy, ...POLICIES[policy], ...MODE_MARKS[policy] })));

/** The marks of the models engines ship knowing. A model an engine names for itself takes the plain one. */
const MODEL_ICONS: Partial<Record<AgentEngine, Readonly<Record<string, IconType>>>> = {
  claude: { fable: Sparkles, opus: Brain, sonnet: Gauge, haiku: Feather },
  codex: { "gpt-6-astra": Brain, "gpt-6.1-sol": Sparkles, "gpt-6.1-terra": Gauge, "gpt-6-luna": Moon },
};

/** An engine's own group wears its glyph; a provider served through an engine wears a generic one. */
function ProviderMark({ engine, groupKey }: { engine: AgentEngine; groupKey: string }) {
  const Icon = groupKey === engine ? engineIcon(engine) : Sparkles;
  return <Icon className="model-provider-glyph" size={16} aria-hidden="true" />;
}

function modelIcon(engine: AgentEngine, model: AgentModel): IconType {
  const icons = MODEL_ICONS[engine];
  return (icons && Object.hasOwn(icons, model) ? icons[model] : undefined) ?? Brain;
}

/** What is wrong with an engine, said in the words Settings and the composer error use as well. */
function ReadinessHint({ notice, onOpenSettings }: { notice: EngineNotice; onOpenSettings?: () => void }) {
  /** The fix command is long, so it is offered to copy and spelled out only where Settings cannot; one Settings can run is left to its Update button. */
  return <div className="setting-hint setting-readiness">
    <span>{notice.message}</span>
    {notice.fix && !onOpenSettings && <code>{notice.fix}</code>}
    {notice.fix && !(notice.updatable && onOpenSettings) && <CopyButton text={notice.fix} label={`Copy ${notice.fix}`} />}
    {onOpenSettings && <button className="setting-readiness-link" type="button" onClick={onOpenSettings}>Settings</button>}
  </div>;
}

function SettingMenu({ label, axis, heading, value, detail, danger = false, onOpen, onKeyDown, library = false, children }: {
  /** The menu's name with its current value, as a screen reader says the chip. */
  label: string;
  axis: string;
  heading: string;
  value: ReactNode;
  /** A second value read after the first, such as the effort beside its model. */
  detail?: ReactNode;
  /** Set while the value is one that acts without asking. */
  danger?: boolean;
  onOpen?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  library?: boolean;
  /** The options, handed the menu's own close so a pick can shut it. */
  children: (close: () => void) => ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (details.current) details.current.open = false; };
  useDismissibleLayer(open, [details], close, summary);

  return <details ref={details} className={`setting-menu${danger ? " danger" : ""}`} onToggle={(event) => { setOpen(event.currentTarget.open); if (event.currentTarget.open) onOpen?.(); }}>
    <summary ref={summary} aria-label={label}>
      <span className="setting-axis">{axis}</span>
      <span className="setting-value" {...(typeof value === "string" ? { "data-tip": value, "data-tip-overflow": true } : {})}>{value}</span>
      {detail !== undefined && <span className="setting-detail"><span aria-hidden="true">·</span>{detail}</span>}
      <ChevronDown size={12} className="setting-chevron" aria-hidden="true" />
    </summary>
    {open && <div className={`setting-popover${library ? " model-library" : ""}`} role={library ? "dialog" : "listbox"} aria-label={heading} onKeyDown={onKeyDown ?? (library ? undefined : moveListFocus)}>
      {!library && <div className="setting-heading">{heading}</div>}
      {children(close)}
    </div>}
  </details>;
}

function Option<T extends string>({ item, selected, disabled = false, onSelect }: {
  item: Choice<T>;
  selected: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const Icon = item.icon;
  return <button
    type="button"
    role="option"
    aria-selected={selected}
    {...(disabled ? { "aria-disabled": true } : {})}
    autoFocus={selected}
    className={`setting-option${item.danger ? " danger" : ""}`}
    onClick={onSelect}
  >
    <span className="setting-icon" aria-hidden="true"><Icon size={20} /></span>
    <span><strong>{item.label}</strong>{item.description && <small>{item.description}</small>}</span>
    <span className="setting-check" aria-hidden="true">{selected && <Check size={20} />}</span>
  </button>;
}

function ChoiceMenu<T extends string>({ label, axis, heading, choices, value, onChange }: {
  label: string;
  axis: string;
  heading: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  /** A value only a newer build on a paired computer knows is named as it is, never as one of these. */
  const selected = choices.find((item) => item.value === value);
  return <SettingMenu label={`${label}: ${selected?.label ?? value}`} axis={axis} heading={heading} value={selected?.label ?? value} danger={selected?.danger}>
    {(close) => choices.map((item) => <Option key={item.value} item={item} selected={item.value === value} onSelect={() => { onChange(item.value); close(); }} />)}
  </SettingMenu>;
}

/** The effort a model menu sets alongside its model. A coordinator's offers only the efforts it takes. */
export type EffortControl = { value: AgentEffort; coordinating?: boolean; onChange: (effort: AgentEffort) => void };

/** The efforts a model offers, shallowest first, and the one a run on it gets. */
function effortSteps(catalog: ModelCatalog, engine: AgentEngine, model: AgentModel | undefined, effort: EffortControl) {
  if (model === undefined) return { steps: [], value: effort.value };
  const role = effort.coordinating ? "coordinator" : undefined;
  return { steps: [...effortsFor(catalog, engine, model, role)].reverse(), value: effortForModel(catalog, engine, model, effort.value, role) };
}

/** The efforts on a track the knob slides along freely while dragged, settling on the nearest effort when let go. Each effort is named under its stop. */
function EffortSlider({ steps, value, onChange }: { steps: readonly EffortSpec[]; value: AgentEffort; onChange: (effort: AgentEffort) => void }) {
  const rail = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const last = steps.length - 1;
  const index = Math.max(0, steps.findIndex((spec) => spec.id === value));
  const at = (step: number) => (last ? step / last : 0);
  const nearest = (fraction: number) => Math.round(fraction * last);
  const shown = drag === null ? index : nearest(drag);
  const pick = (step: number) => {
    const spec = steps[Math.min(last, Math.max(0, step))];
    if (spec && spec.id !== value) onChange(spec.id);
  };
  /** Where the pointer sits along the knob's travel, from 0 to 1. */
  const fraction = (event: PointerEvent<HTMLElement>) => {
    const box = rail.current?.getBoundingClientRect();
    if (!box?.width) return at(index);
    const knob = rail.current?.querySelector<HTMLElement>(".effort-knob")?.offsetWidth ?? box.height;
    return Math.min(1, Math.max(0, (event.clientX - box.left - knob / 2) / Math.max(1, box.width - knob)));
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = ({ ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: last } as Record<string, number>)[event.key];
    if (step === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    pick(step);
  };
  const release = () => {
    if (drag !== null) pick(nearest(drag));
    setDrag(null);
  };
  return <div
    className={`effort-slider${drag === null ? "" : " dragging"}${steps[shown]?.delegates ? " delegates" : ""}`}
    role="slider"
    tabIndex={0}
    aria-label="Effort"
    aria-valuemin={0}
    aria-valuemax={last}
    aria-valuenow={index}
    aria-valuetext={steps[index]?.label}
    style={{ "--effort-at": drag ?? at(index) } as CSSProperties}
    onKeyDown={keyDown}
    onPointerDown={(event) => {
      if (event.button !== 0 || !last) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDrag(fraction(event));
    }}
    onPointerMove={(event) => { if (drag !== null) setDrag(fraction(event)); }}
    onPointerUp={release}
    onPointerCancel={() => setDrag(null)}
  >
    <div className="effort-rail" ref={rail}>
      <div className="effort-fill" />
      <div className="effort-knob" />
    </div>
    <div className="effort-stops">
      {steps.map((spec, step) => <span
        key={spec.id}
        className={`effort-stop${step === shown ? " current" : ""}`}
        data-tip={spec.description}
        style={{ "--effort-stop": at(step) } as CSSProperties}
      >{spec.label}</span>)}
    </div>
  </div>;
}

/** The effort for the model in the library, pinned under the list so it stays in reach however long the list grows. With no model chosen, it says nothing of one. */
function EffortStrip({ engine, model, modelLabel, effort }: { engine: AgentEngine; model: AgentModel | undefined; modelLabel: string; effort: EffortControl }) {
  const { steps, value } = effortSteps(useModelCatalog(), engine, model, effort);
  return <div className="effort-strip">
    <span className="effort-strip-axis">Effort<small>{modelLabel}</small></span>
    {steps.length
      ? <EffortSlider steps={steps} value={value} onChange={effort.onChange} />
      : model !== undefined && <span className="effort-strip-none">{modelLabel} has no effort setting</span>}
  </div>;
}

type ModelLibraryProps = {
  engine: AgentEngine;
  engineLocked: boolean;
  engineAccess: Record<AgentEngine, EngineReadiness>;
  model: AgentModel | undefined;
  favoriteModels?: EngineModel[];
  onModelFavorite?: (engine: AgentEngine, model: AgentModel, favorite: boolean) => void;
  onChange: (engine: AgentEngine, model: AgentModel) => void;
  onSignIn: (engine: AgentEngine) => void;
  onOpenEngineSettings?: () => void;
  /** Narrows the library to the models this choice may take. */
  models?: (engine: AgentEngine, model: AgentModel) => boolean;
  /** Set where the menu picks the effort too. Picking a model then leaves the library open to fit the effort. */
  effort?: EffortControl;
};

function ModelLibrary({ engine, engineLocked, engineAccess, model, modelLabel, favoriteModels = [], onModelFavorite, onChange, onSignIn, onOpenEngineSettings, models, effort, close }: ModelLibraryProps & { modelLabel: string; close: () => void }) {
  const catalog = useModelCatalog();
  const [filter, setFilter] = useState<LibraryFilter>(() => libraryOpening(catalog, { engine, locked: engineLocked, model, favorites: favoriteModels }));
  const [query, setQuery] = useState("");
  const results = useRef<HTMLDivElement>(null);
  const search = query.trim();
  const { available, shown, count, total, favoriteCount, heading } = modelLibrary(catalog, engineAccess, { engine, locked: engineLocked, favorites: favoriteModels, filter, query, ...(models ? { allows: models } : {}) });

  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(results.current?.querySelectorAll<HTMLButtonElement>(".model-choice:not(:disabled)") ?? [])];
    if (!buttons.length) return;
    if (event.key === "Enter" && event.target instanceof HTMLElement && event.target.tagName === "INPUT") {
      event.preventDefault();
      buttons[0].click();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = index + (event.key === "ArrowDown" ? 1 : -1);
    if (index === -1) next = event.key === "ArrowDown" ? 0 : buttons.length - 1;
    buttons[(next + buttons.length) % buttons.length].focus();
  };

  return <>
    <div className="model-search" onKeyDown={navigate}>
      <Search size={18} aria-hidden="true" />
      <input autoFocus aria-label="Find a model or provider" placeholder="Find a model or provider…" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
      <button type="button" aria-label="Close model picker" onClick={close}><X size={16} /></button>
    </div>
    <div className="model-library-body">
      <nav className="model-provider-rail" aria-label="Filter models">
        <button type="button" aria-pressed={!search && filter === "favorites"} onClick={() => { setFilter("favorites"); setQuery(""); }}><Star size={16} />Favorites<span>{favoriteCount}</span></button>
        <button type="button" aria-pressed={!search && filter === "all"} onClick={() => { setFilter("all"); setQuery(""); }}><Grid size={16} />All models<span>{total}</span></button>
        <hr />
        {available.map((group) => <button key={group.key} type="button" aria-pressed={!search && filter === group.key} onClick={() => { setFilter(group.key); setQuery(""); }}><ProviderMark engine={group.engine} groupKey={group.key} />{group.label}<span>{group.models.length}</span></button>)}
      </nav>
      <div className="model-results" ref={results} onKeyDown={navigate}>
        <div className="model-results-heading"><span>{heading}</span><span aria-live="polite">{count} models</span></div>
        {shown.map((group) => <div key={group.key} role="group" aria-label={group.label}>
          {group.models.map((spec) => {
            const selected = group.engine === engine && spec.id === model;
            const favorite = isFavorite(favoriteModels, group.engine, spec.id);
            const Icon = modelIcon(group.engine, spec.id);
            return <div key={spec.id} className={`model-row${selected ? " selected" : ""}`}>
              <button type="button" className="model-choice" aria-pressed={selected} disabled={!group.selectable} onClick={() => { onChange(group.engine, spec.id); if (!effort) close(); }}>
                <span className="model-row-icon" aria-hidden="true"><Icon size={18} /></span>
                <span className="model-row-label"><strong>{spec.label}</strong><small data-tip={`${group.label} · ${spec.description}`} data-tip-overflow>{group.label} · {spec.description}</small></span>
                {selected && <Check size={16} className="model-selected-check" aria-hidden="true" />}
              </button>
              {onModelFavorite && <button type="button" className="model-favorite" aria-label={`${favorite ? "Unpin" : "Pin"} ${spec.label}`} aria-pressed={favorite} data-tip={favorite ? "Unpin from Favorites" : "Pin to Favorites"} onClick={() => onModelFavorite(group.engine, spec.id, !favorite)}><Star size={16} fill={favorite ? "currentColor" : "none"} /></button>}
            </div>;
          })}
          {group.hint?.kind === "new-thread" && <p className="setting-hint">Start a new thread to use {engineLabel(group.engine)}</p>}
          {group.hint?.kind === "sign-in" && <button type="button" className="setting-hint" onClick={() => { onSignIn(group.engine); close(); }}>Sign in to use {group.label}</button>}
          {group.hint?.kind === "notice" && <ReadinessHint notice={group.hint.notice} onOpenSettings={onOpenEngineSettings ? () => { onOpenEngineSettings(); close(); } : undefined} />}
        </div>)}
        {count === 0 && <p className="model-empty">{search ? "No models found. Try another name or provider." : filter === "favorites" ? "Pin models from All models to keep them here." : "No models available."}</p>}
      </div>
    </div>
    {effort
      ? <EffortStrip engine={engine} model={model} modelLabel={modelLabel} effort={effort} />
      : <div className="model-library-footer">{engineLocked ? `This thread uses ${engineLabel(engine)}.` : "↑ ↓ navigate · Enter select"}<span><Star size={12} /> Pin your go-to models</span></div>}
  </>;
}

/** The model chip and the library it opens, with the effort beside the model where `effort` is set. `onOpen` asks after the engines, so the library can say which it can pick. */
export function ModelMenu({ onOpen, ...props }: ModelLibraryProps & { onOpen: () => void }) {
  /** A model this build does not know, as a newer computer may run, is named as it is sent. */
  const catalog = useModelCatalog();
  const offered = modelsFor(catalog, props.engine);
  const selected = offered.find((spec) => spec.id === props.model) ?? (props.model !== undefined && catalogHasModel(catalog, props.model) ? offered[0] : undefined);
  const modelLabel = selected?.label ?? props.model ?? "Choose a model";
  const { effort } = props;
  const { steps, value } = effort ? effortSteps(catalog, props.engine, props.model, effort) : { steps: [], value: undefined };
  const shown = steps.find((spec) => spec.id === value);
  /** Left and right step the effort from anywhere in the library but a search being typed. */
  const stepEffort = (event: KeyboardEvent<HTMLElement>) => {
    if (!effort || !steps.length || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    if (event.target instanceof HTMLInputElement && event.target.value) return;
    event.preventDefault();
    const next = steps[steps.findIndex((spec) => spec.id === value) + (event.key === "ArrowRight" ? 1 : -1)];
    if (next) effort.onChange(next.id);
  };
  return <SettingMenu
    label={`${steps.length ? "Model and effort" : "Model"}: ${modelLabel}${steps.length ? `, ${shown?.label ?? value}` : ""}`}
    axis="Model"
    heading={steps.length ? "Choose a model and effort" : "Choose a model"}
    value={modelLabel}
    detail={steps.length ? <span className={shown?.delegates ? "delegates" : undefined}>{shown?.label ?? value}</span> : undefined}
    library
    onOpen={props.engineLocked ? undefined : onOpen}
    onKeyDown={stepEffort}
  >
    {(close) => <ModelLibrary {...props} modelLabel={modelLabel} close={close} />}
  </SettingMenu>;
}

export function ComposerSettings({ taskId, mode, engine, engineLabel, engineLocked, engineAccess, model, effort, coordinating = false, fastMode, onFastModeChange, onModeChange, favoriteModels, onModelFavorite, onModelChange, onEffortChange, onEngineRead, onSignIn, onOpenEngineSettings }: {
  taskId?: string;
  mode: ExecutionPolicy;
  engine: AgentEngine;
  engineLabel: string;
  /** Set once the thread has an engine for good, which is from its first message on. */
  engineLocked: boolean;
  engineAccess: Record<AgentEngine, EngineReadiness>;
  model: AgentModel | undefined;
  effort: AgentEffort;
  coordinating?: boolean;
  fastMode: boolean;
  onFastModeChange: (fastMode: boolean) => void;
  onModeChange: (mode: ExecutionPolicy) => void;
  favoriteModels?: EngineModel[];
  onModelFavorite?: (engine: AgentEngine, model: AgentModel, favorite: boolean) => void;
  onModelChange: (engine: AgentEngine, model: AgentModel) => void;
  onEffortChange: (engine: AgentEngine, effort: AgentEffort) => void;
  /** Asked when the model menu opens on another engine, so the menu can say whether it can be picked. */
  onEngineRead: () => void;
  onSignIn: (engine: AgentEngine) => void;
  /** Opens the Engines page, where the same trouble is shown with a button that checks again. */
  onOpenEngineSettings?: () => void;
}) {
  const controls = useCommandControls();
  const effortControl: EffortControl | undefined = controls.available({ type: "task.set-effort", taskId, engine, effort })
    ? { value: effort, coordinating, onChange: (choice) => onEffortChange(engine, choice) }
    : undefined;
  return (
    <div className="composer-settings">
      <CommandGate command={{ type: "task.set-policy", taskId, policy: mode }}><ChoiceMenu label="Permission mode" axis="Mode" heading={`How should ${engineLabel} actions be approved?`} choices={modesOf[engine]} value={mode} onChange={onModeChange} /></CommandGate>
      <CommandGate command={{ type: "task.set-model", taskId, engine, model }}><ModelMenu engine={engine} engineLocked={engineLocked} engineAccess={engineAccess} model={model} favoriteModels={favoriteModels} onModelFavorite={onModelFavorite} onChange={onModelChange} onOpen={onEngineRead} onSignIn={onSignIn} {...(effortControl ? { effort: effortControl } : {})} {...(onOpenEngineSettings ? { onOpenEngineSettings } : {})} /></CommandGate>
      {capabilitiesFor(engine).fastMode && <CommandButton command={{ type: "task.set-fast-mode", taskId, fastMode: !fastMode }} type="button" className="fast-mode-toggle" aria-label="Fast mode" aria-pressed={fastMode} data-tip={`Fast mode ${fastMode ? "on" : "off"} · faster responses use more of your plan`} onClick={() => onFastModeChange(!fastMode)}><Zap size={14} fill={fastMode ? "currentColor" : "none"} aria-hidden="true" /><span aria-hidden="true">Fast</span></CommandButton>}
    </div>
  );
}
