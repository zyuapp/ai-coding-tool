import { CommandGate, CommandButton, useCommandControls } from "./CommandControl";
import type { IconType } from "react-icons";
import { LuSearch as Search, LuStar as Star, LuGrid2X2 as Grid, LuX as X, LuBrain as Brain, LuCheck as Check, LuChevronDown as ChevronDown, LuFeather as Feather, LuFileCheck2 as FileCheck2, LuGauge as Gauge, LuHand as Hand, LuMoon as Moon, LuShieldOff as ShieldOff, LuSparkles as Sparkles, LuZap as Zap } from "react-icons/lu";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { AGENT_ENGINES, capabilitiesFor, byEngine, effortForModel, effortsFor, engineLabel, engineNotice, isAgentModel, modelsFor, type AgentEngine, type AgentModel, type EffortSpec, type EngineNotice, type EngineReadiness } from "../../domain/agent-engine";
import { POLICIES, type AgentEffort, type ExecutionPolicy } from "../../domain/run";
import { moveListFocus, useDismissibleLayer } from "../focus";
import { CopyButton } from "./CopyButton";

type Choice<T extends string> = { value: T; label: string; description?: string; icon: IconType; danger?: true };

const modes: Choice<ExecutionPolicy>[] = [
  { value: "autonomous", ...POLICIES.autonomous, icon: Zap },
  { value: "bypass", ...POLICIES.bypass, icon: ShieldOff, danger: true },
  { value: "allow-edits", ...POLICIES["allow-edits"], icon: FileCheck2 },
  { value: "confirm", ...POLICIES.confirm, icon: Hand },
];

const modelIcons: Record<AgentModel, IconType> = { fable: Sparkles, opus: Brain, sonnet: Gauge, haiku: Feather, "gpt-6-astra": Brain, "gpt-6.1-sol": Sparkles, "gpt-5.6-terra": Gauge, "gpt-6-luna": Moon };

const modelsOf = byEngine((engine): Choice<AgentModel>[] => modelsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, description: spec.description, icon: modelIcons[spec.id] })));

/** Provider filters and search share the same catalog. */
const modelGroups = AGENT_ENGINES.map((engine) => ({ engine, label: engineLabel(engine), choices: modelsOf[engine] }));

export const EVERY_ENGINE_READY = byEngine((): EngineReadiness => ({ access: "ready" }));

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
      <span className="setting-value">{value}</span>
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
function effortSteps(model: AgentModel, effort: EffortControl) {
  const role = effort.coordinating ? "coordinator" : undefined;
  return { steps: [...effortsFor(model, role)].reverse(), value: effortForModel(model, effort.value, role) };
}

/** The efforts on a track the knob slides along freely while dragged, settling on the nearest effort when let go. */
function EffortSlider({ steps, value, onChange }: { steps: readonly EffortSpec[]; value: AgentEffort; onChange: (effort: AgentEffort) => void }) {
  const rail = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hovered, setHovered] = useState(-1);
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
    const knob = box.height + 4;
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
  return <>
    <div
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
        setHovered(-1);
        setDrag(fraction(event));
      }}
      onPointerMove={(event) => {
        const where = fraction(event);
        if (drag !== null) return setDrag(where);
        const step = nearest(where);
        setHovered(Math.abs(where - at(step)) * (rail.current?.clientWidth ?? 0) < 12 && step !== index ? step : -1);
      }}
      onPointerUp={release}
      onPointerCancel={() => setDrag(null)}
      onPointerLeave={() => setHovered(-1)}
    >
      <div className="effort-rail" ref={rail}>
        <div className="effort-fill" />
        {steps.map((spec, step) => <span
          key={spec.id}
          className={`effort-tick${at(step) < (drag ?? at(index)) ? " passed" : ""}${step === hovered ? " hovered" : ""}`}
          data-label={spec.label}
          style={{ "--effort-tick": at(step) } as CSSProperties}
        />)}
        <div className="effort-knob" />
      </div>
      {last > 0 && <div className="effort-ends" aria-hidden="true"><span>{steps[0]!.label}</span><span>{steps[last]!.label}</span></div>}
    </div>
    <span className={`effort-strip-value${steps[shown]?.delegates ? " delegates" : ""}`} data-tip={steps[shown]?.description}>{steps[shown]?.label ?? value}</span>
  </>;
}

/** The effort for the model in the library, pinned under the list so it stays in reach however long the list grows. */
function EffortStrip({ model, modelLabel, effort }: { model: AgentModel; modelLabel: string; effort: EffortControl }) {
  const { steps, value } = effortSteps(model, effort);
  return <div className="effort-strip">
    <span className="effort-strip-axis">Effort<small>{modelLabel}</small></span>
    {steps.length
      ? <EffortSlider steps={steps} value={value} onChange={effort.onChange} />
      : <span className="effort-strip-none">{modelLabel} has no effort setting</span>}
  </div>;
}

type ModelLibraryProps = {
  engine: AgentEngine;
  engineLocked: boolean;
  engineAccess: Record<AgentEngine, EngineReadiness>;
  model: AgentModel;
  favoriteModels?: AgentModel[];
  onModelFavorite?: (model: AgentModel, favorite: boolean) => void;
  onChange: (engine: AgentEngine, model: AgentModel) => void;
  onSignIn: (engine: AgentEngine) => void;
  onOpenEngineSettings?: () => void;
  /** Narrows the library to the models this choice may take. */
  models?: (model: AgentModel) => boolean;
  /** Set where the menu picks the effort too. Picking a model then leaves the library open to fit the effort. */
  effort?: EffortControl;
};

function ModelLibrary({ engine, engineLocked, engineAccess, model, modelLabel, favoriteModels = [], onModelFavorite, onChange, onSignIn, onOpenEngineSettings, models, effort, close }: ModelLibraryProps & { modelLabel: string; close: () => void }) {
  const [filter, setFilter] = useState<AgentEngine | "favorites" | "all">(() => {
    if (engineLocked) return engine;
    return favoriteModels.length ? "favorites" : "all";
  });
  const [query, setQuery] = useState("");
  const results = useRef<HTMLDivElement>(null);
  const favorites = new Set(favoriteModels);
  const search = query.trim().toLocaleLowerCase();
  const available = modelGroups.map((group) => {
    const readiness = engineAccess[group.engine];
    return { ...group, choices: group.choices.filter((item) => (!readiness.models || readiness.models.includes(item.value)) && (!models || models(item.value))) };
  });
  const groups = available.filter((group) => search || filter === "all" || filter === "favorites" || filter === group.engine).map((group) => ({
    ...group,
    choices: group.choices.filter((item) => {
      if (search) return `${group.label} ${item.label} ${item.value} ${item.description}`.toLocaleLowerCase().includes(search);
      return filter !== "favorites" || favorites.has(item.value);
    }),
  }));
  const count = groups.reduce((total, group) => total + group.choices.length, 0);
  let heading = "All models";
  if (filter === "favorites") heading = "Favorites";
  else if (filter !== "all") heading = engineLabel(filter);
  if (search) heading = "Search results";

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
        <button type="button" aria-pressed={!search && filter === "favorites"} onClick={() => { setFilter("favorites"); setQuery(""); }}><Star size={16} />Favorites<span>{available.reduce((total, group) => total + group.choices.filter((item) => favorites.has(item.value)).length, 0)}</span></button>
        <button type="button" aria-pressed={!search && filter === "all"} onClick={() => { setFilter("all"); setQuery(""); }}><Grid size={16} />All models<span>{available.reduce((total, group) => total + group.choices.length, 0)}</span></button>
        <hr />
        {available.map((group) => <button key={group.engine} type="button" aria-pressed={!search && filter === group.engine} onClick={() => { setFilter(group.engine); setQuery(""); }}><span className="model-provider-initial" aria-hidden="true">{group.label[0]}</span>{group.label}<span>{group.choices.length}</span></button>)}
      </nav>
      <div className="model-results" ref={results} onKeyDown={navigate}>
        <div className="model-results-heading"><span>{heading}</span><span aria-live="polite">{count} models</span></div>
        {groups.map((group) => {
          const readiness = engineAccess[group.engine];
          const locked = engineLocked && group.engine !== engine;
          const ready = readiness.access === "ready" && !locked;
          const notice = engineNotice(group.engine, readiness);
          if (!group.choices.length && (search || filter === "favorites")) return null;
          return <div key={group.engine} role="group" aria-label={group.label}>
            {group.choices.map((item) => {
              const selected = group.engine === engine && item.value === model;
              const favorite = favorites.has(item.value);
              const Icon = item.icon;
              return <div key={item.value} className={`model-row${selected ? " selected" : ""}`}>
                <button type="button" className="model-choice" aria-pressed={selected} disabled={!ready} onClick={() => { onChange(group.engine, item.value); if (!effort) close(); }}>
                  <span className="model-row-icon" aria-hidden="true"><Icon size={18} /></span>
                  <span className="model-row-label"><strong>{item.label}</strong><small data-tip={`${group.label} · ${item.description}`} data-tip-overflow>{group.label} · {item.description}</small></span>
                  {selected && <Check size={16} className="model-selected-check" aria-hidden="true" />}
                </button>
                {onModelFavorite && <button type="button" className="model-favorite" aria-label={`${favorite ? "Unpin" : "Pin"} ${item.label}`} aria-pressed={favorite} data-tip={favorite ? "Unpin from Favorites" : "Pin to Favorites"} onClick={() => onModelFavorite(item.value, !favorite)}><Star size={16} fill={favorite ? "currentColor" : "none"} /></button>}
              </div>;
            })}
            {locked && <p className="setting-hint">Start a new thread to use {group.label}</p>}
            {!locked && readiness.access === "signed-out" && <button type="button" className="setting-hint" onClick={() => { onSignIn(group.engine); close(); }}>Sign in to use {group.label}</button>}
            {!locked && notice && <ReadinessHint notice={notice} onOpenSettings={onOpenEngineSettings ? () => { onOpenEngineSettings(); close(); } : undefined} />}
          </div>;
        })}
        {count === 0 && <p className="model-empty">{search ? "No models found. Try another name or provider." : filter === "favorites" ? "Pin models from All models to keep them here." : "No models available."}</p>}
      </div>
    </div>
    {effort
      ? <EffortStrip model={model} modelLabel={modelLabel} effort={effort} />
      : <div className="model-library-footer">{engineLocked ? `This thread uses ${engineLabel(engine)}.` : "↑ ↓ navigate · Enter select"}<span><Star size={12} /> Pin your go-to models</span></div>}
  </>;
}

/** The model chip and the library it opens, with the effort beside the model where `effort` is set. `onOpen` asks after the engines, so the library can say which it can pick. */
export function ModelMenu({ onOpen, ...props }: ModelLibraryProps & { onOpen: () => void }) {
  /** A model this build does not know, as a newer computer may run, is named as it is sent. */
  const offered = modelsOf[props.engine] ?? [];
  const selected = offered.find((item) => item.value === props.model) ?? (isAgentModel(props.model) ? offered[0] : undefined);
  const modelLabel = selected?.label ?? props.model;
  const { effort } = props;
  const { steps, value } = effort ? effortSteps(props.model, effort) : { steps: [], value: undefined };
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
  model: AgentModel;
  effort: AgentEffort;
  coordinating?: boolean;
  fastMode: boolean;
  onFastModeChange: (fastMode: boolean) => void;
  onModeChange: (mode: ExecutionPolicy) => void;
  favoriteModels?: AgentModel[];
  onModelFavorite?: (model: AgentModel, favorite: boolean) => void;
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
      <CommandGate command={{ type: "task.set-policy", taskId, policy: mode }}><ChoiceMenu label="Permission mode" axis="Mode" heading={`How should ${engineLabel} actions be approved?`} choices={modes} value={mode} onChange={onModeChange} /></CommandGate>
      <CommandGate command={{ type: "task.set-model", taskId, engine, model }}><ModelMenu engine={engine} engineLocked={engineLocked} engineAccess={engineAccess} model={model} favoriteModels={favoriteModels} onModelFavorite={onModelFavorite} onChange={onModelChange} onOpen={onEngineRead} onSignIn={onSignIn} {...(effortControl ? { effort: effortControl } : {})} {...(onOpenEngineSettings ? { onOpenEngineSettings } : {})} /></CommandGate>
      {capabilitiesFor(engine).fastMode && <CommandButton command={{ type: "task.set-fast-mode", taskId, fastMode: !fastMode }} type="button" className="fast-mode-toggle" aria-label="Fast mode" aria-pressed={fastMode} data-tip={`Fast mode ${fastMode ? "on" : "off"} · faster responses use more of your plan`} onClick={() => onFastModeChange(!fastMode)}><Zap size={14} fill={fastMode ? "currentColor" : "none"} aria-hidden="true" /><span aria-hidden="true">Fast</span></CommandButton>}
    </div>
  );
}
