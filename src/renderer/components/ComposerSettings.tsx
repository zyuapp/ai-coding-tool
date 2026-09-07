import type { IconType } from "react-icons";
import { LuSearch as Search, LuStar as Star, LuGrid2X2 as Grid, LuX as X, LuBrain as Brain, LuCheck as Check, LuFeather as Feather, LuFileCheck2 as FileCheck2, LuFlame as Flame, LuGauge as Gauge, LuHand as Hand, LuMoon as Moon, LuNetwork as Network, LuShieldOff as ShieldOff, LuSignal as Signal, LuSignalHigh as SignalHigh, LuSignalLow as SignalLow, LuSignalMedium as SignalMedium, LuSparkles as Sparkles, LuZap as Zap } from "react-icons/lu";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AGENT_ENGINES, byEngine, byModel, effortForModel, engineLabel, engineNotice, modelsFor, type AgentEngine, type AgentModel, type EngineNotice, type EngineReadiness } from "../../domain/agent-engine";
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

const modelIcons: Record<AgentModel, IconType> = { fable: Sparkles, opus: Brain, sonnet: Gauge, haiku: Feather, "gpt-6-astra": Brain, "gpt-5.6-sol": Sparkles, "gpt-5.6-terra": Gauge, "gpt-5.6-luna": Moon };

/** Bars for the depth ladder, and a mark of its own for the tier that works differently. */
const effortIcons: Record<AgentEffort, IconType> = {
  ultra: Network,
  max: Flame,
  xhigh: Signal,
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
};

const modelsOf = byEngine((engine): Choice<AgentModel>[] => modelsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, description: spec.description, icon: modelIcons[spec.id] })));
const effortsOf = byModel((model): Choice<AgentEffort>[] => model.efforts.map((spec) => ({ value: spec.id, ...spec, icon: effortIcons[spec.id] })));

/** Provider filters and search share the same catalog. */
const modelGroups = AGENT_ENGINES.map((engine) => ({ engine, label: engineLabel(engine), choices: modelsOf[engine] }));

export const EVERY_ENGINE_READY = byEngine((): EngineReadiness => ({ access: "ready" }));

/** What is wrong with an engine, said in the words Settings and the composer error use as well. */
function ReadinessHint({ notice, onOpenSettings }: { notice: EngineNotice; onOpenSettings?: () => void }) {
  /** The fix command is long, so it is offered to copy and spelled out only where Settings cannot. */
  return <div className="setting-hint setting-readiness">
    <span>{notice.message}</span>
    {notice.fix && !onOpenSettings && <code>{notice.fix}</code>}
    {notice.fix && <CopyButton text={notice.fix} label={`Copy ${notice.fix}`} />}
    {onOpenSettings && <button className="setting-readiness-link" type="button" onClick={onOpenSettings}>Settings</button>}
  </div>;
}

function SettingMenu({ label, axis, heading, value, onOpen, library = false, children }: {
  label: string;
  axis: string;
  heading: string;
  value: ReactNode;
  onOpen?: () => void;
  library?: boolean;
  /** The options, handed the menu's own close so a pick can shut it. */
  children: (close: () => void) => ReactNode;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (details.current) details.current.open = false; };
  useDismissibleLayer(open, [details], close, summary);

  return <details ref={details} className="setting-menu" onToggle={(event) => { setOpen(event.currentTarget.open); if (event.currentTarget.open) onOpen?.(); }}>
    <summary ref={summary} aria-label={label}>
      <span className="setting-axis">{axis}</span>
      <span className="setting-value">{value}</span>
    </summary>
    {open && <div className={`setting-popover${library ? " model-library" : ""}`} role={library ? "dialog" : "listbox"} aria-label={heading} onKeyDown={library ? undefined : moveListFocus}>
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
  const selected = choices.find((item) => item.value === value) ?? choices[0];
  return <SettingMenu label={label} axis={axis} heading={heading} value={selected.label}>
    {(close) => choices.map((item) => <Option key={item.value} item={item} selected={item.value === value} onSelect={() => { onChange(item.value); close(); }} />)}
  </SettingMenu>;
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
};

function ModelLibrary({ engine, engineLocked, engineAccess, model, favoriteModels = [], onModelFavorite, onChange, onSignIn, onOpenEngineSettings, close }: ModelLibraryProps & { close: () => void }) {
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
    return { ...group, choices: group.choices.filter((item) => !readiness.models || readiness.models.includes(item.value)) };
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
      <Search size={17} aria-hidden="true" />
      <input autoFocus aria-label="Find a model or provider" placeholder="Find a model or provider…" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
      <button type="button" aria-label="Close model picker" onClick={close}><X size={15} /></button>
    </div>
    <div className="model-library-body">
      <nav className="model-provider-rail" aria-label="Filter models">
        <button type="button" aria-pressed={!search && filter === "favorites"} onClick={() => { setFilter("favorites"); setQuery(""); }}><Star size={15} />Favorites<span>{available.reduce((total, group) => total + group.choices.filter((item) => favorites.has(item.value)).length, 0)}</span></button>
        <button type="button" aria-pressed={!search && filter === "all"} onClick={() => { setFilter("all"); setQuery(""); }}><Grid size={15} />All models<span>{available.reduce((total, group) => total + group.choices.length, 0)}</span></button>
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
                <button type="button" className="model-choice" aria-pressed={selected} disabled={!ready} onClick={() => { onChange(group.engine, item.value); close(); }} title={item.description}>
                  <span className="model-row-icon" aria-hidden="true"><Icon size={18} /></span>
                  <span className="model-row-label"><strong>{item.label}</strong><small>{group.label} · {item.description}</small></span>
                  {selected && <Check size={16} className="model-selected-check" aria-hidden="true" />}
                </button>
                {onModelFavorite && <button type="button" className="model-favorite" aria-label={`${favorite ? "Unpin" : "Pin"} ${item.label}`} aria-pressed={favorite} onClick={() => onModelFavorite(item.value, !favorite)}><Star size={15} fill={favorite ? "currentColor" : "none"} /></button>}
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
    <div className="model-library-footer">{engineLocked ? `This thread uses ${engineLabel(engine)}.` : "↑ ↓ navigate · Enter select"}<span><Star size={12} /> Pin your go-to models</span></div>
  </>;
}

function ModelMenu({ onOpen, ...props }: ModelLibraryProps & { onOpen: () => void }) {
  const selected = modelsOf[props.engine].find((item) => item.value === props.model) ?? modelsOf[props.engine][0];
  return <SettingMenu label="Model" axis="Model" heading="Choose a model" value={selected.label} library onOpen={props.engineLocked ? undefined : onOpen}>
    {(close) => <ModelLibrary {...props} close={close} />}
  </SettingMenu>;
}

export function ComposerSettings({ mode, engine, engineLabel, engineLocked, engineAccess, model, effort, onModeChange, favoriteModels, onModelFavorite, onModelChange, onEffortChange, onEngineRead, onSignIn, onOpenEngineSettings }: {
  mode: ExecutionPolicy;
  engine: AgentEngine;
  engineLabel: string;
  /** Set once the thread has an engine for good, which is from its first message on. */
  engineLocked: boolean;
  engineAccess: Record<AgentEngine, EngineReadiness>;
  model: AgentModel;
  effort: AgentEffort;
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
  return (
    <div className="composer-settings">
      <ChoiceMenu label="Permission mode" axis="Mode" heading={`How should ${engineLabel} actions be approved?`} choices={modes} value={mode} onChange={onModeChange} />
      <ModelMenu engine={engine} engineLocked={engineLocked} engineAccess={engineAccess} model={model} favoriteModels={favoriteModels} onModelFavorite={onModelFavorite} onChange={onModelChange} onOpen={onEngineRead} onSignIn={onSignIn} {...(onOpenEngineSettings ? { onOpenEngineSettings } : {})} />
      {effortsOf[model].length > 0 && <ChoiceMenu label="Effort" axis="Effort" heading={`How hard should ${engineLabel} think?`} choices={effortsOf[model]} value={effortForModel(model, effort)} onChange={(choice) => onEffortChange(engine, choice)} />}
    </div>
  );
}
