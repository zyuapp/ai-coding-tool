import { CommandGate, CommandButton, useCommandControls } from "./CommandControl";
import type { IconType } from "react-icons";
import { LuStar as Star, LuGrid2X2 as Grid, LuX as X, LuBrain as Brain, LuFeather as Feather, LuFileCheck2 as FileCheck2, LuGauge as Gauge, LuHand as Hand, LuMoon as Moon, LuShieldOff as ShieldOff, LuSparkles as Sparkles, LuZap as Zap } from "react-icons/lu";
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { byEngine, capabilitiesFor, catalogHasModel, effortForModel, effortsFor, engineLabel, isFavorite, modelsFor, offeredPolicies, type AgentEngine, type AgentModel, type EngineModel, type ModelCatalog, type EffortSpec, type EngineNotice, type EngineReadiness } from "../../domain/agent-engine";
import { libraryOpening, modelLibrary, type LibraryFilter } from "../../domain/model-library";
import { useModelCatalog } from "../model-catalog";
import { POLICIES, type AgentEffort, type ExecutionPolicy } from "../../domain/run";
import { useDismissibleLayer } from "../focus";
import { MenuGroup, MenuItem, MenuNote, MenuSurface, MenuTrigger, useListKeys, useMenuAnchor } from "../ui/Menu";
import { Button, IconButton, Segmented } from "../ui/Button";
import { SearchField } from "../ui/Field";
import { NavItem, NavList, NavSeparator } from "../ui/NavList";
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
    {onOpenSettings && <Button variant="link" className="setting-readiness-link" onClick={onOpenSettings}>Settings</Button>}
  </div>;
}

/** The widest the library is drawn; a narrower window takes it to its own width. */
const LIBRARY_WIDTH = 760;

/** The library is placed against the window, so a composer narrowed by a panel beside it does not narrow the library too. */
function LibraryPopover({ anchor, heading, onKeyDown, children }: { anchor: HTMLElement | null; heading: string; onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void; children: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null);
  const placed = useMenuAnchor(anchor, surface, { minWidth: LIBRARY_WIDTH, maxWidth: LIBRARY_WIDTH });
  return <div ref={surface} className="glass-popover model-library" style={placed} role="dialog" aria-label={heading} onKeyDown={onKeyDown}>{children}</div>;
}

function SettingMenu({ label, axis, heading, value, detail, danger = false, onOpen, onKeyDown, library = false, children }: {
  /** The menu's name with its current value, as a screen reader says the chip. */
  label: string;
  /** The axis named before the value; a chip that carries several settings goes without one. */
  axis?: string;
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
  const listKeys = useListKeys();
  const close = () => { if (details.current) details.current.open = false; };
  useDismissibleLayer(open, [details], close, summary);

  return <details ref={details} className={`setting-menu${danger ? " danger" : ""}`} onToggle={(event) => { setOpen(event.currentTarget.open); if (event.currentTarget.open) onOpen?.(); }}>
    <MenuTrigger as="summary" variant="ghost" ref={summary} aria-label={label} tone={danger ? "danger" : undefined}>
      {axis && <span className="setting-axis">{axis}</span>}
      <span className="setting-value" {...(typeof value === "string" ? { "data-tip": value, "data-tip-overflow": true } : {})}>{value}</span>
      {detail !== undefined && <span className="setting-detail"><span aria-hidden="true">·</span>{detail}</span>}
    </MenuTrigger>
    {open && (library
      ? <LibraryPopover anchor={summary.current} heading={heading} {...(onKeyDown ? { onKeyDown } : {})}>{children(close)}</LibraryPopover>
      : <MenuSurface checkable className="setting-popover" role="listbox" aria-label={heading} onKeyDown={onKeyDown ?? listKeys}>
        <MenuGroup label={heading}>{children(close)}</MenuGroup>
      </MenuSurface>)}
  </details>;
}

function Option<T extends string>({ item, selected, disabled = false, onSelect }: {
  item: Choice<T>;
  selected: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}) {
  const Icon = item.icon;
  return <MenuItem
    role="option"
    checked={selected}
    disabled={disabled}
    autoFocus={selected}
    className={item.danger ? "danger" : undefined}
    icon={<Icon size={16} />}
    description={item.description}
    onClick={onSelect}
  >
    {item.label}
  </MenuItem>;
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

/** The permission mode a model menu sets alongside its model. */
export type ModeControl = { value: ExecutionPolicy; choices: Choice<ExecutionPolicy>[]; onChange: (mode: ExecutionPolicy) => void };

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

/** The effort and mode for the model in the library, pinned under the list so they stay in reach however long the list grows. With no model chosen, the effort says nothing of one. */
function LibrarySettings({ engine, model, modelLabel, effort, mode }: { engine: AgentEngine; model: AgentModel | undefined; modelLabel: string; effort?: EffortControl; mode?: ModeControl }) {
  const { steps, value } = effort ? effortSteps(useModelCatalog(), engine, model, effort) : { steps: [], value: undefined };
  return <div className="library-settings">
    {effort && <div className="library-setting effort-strip">
      <span className="library-setting-axis">Effort<small>{modelLabel}</small></span>
      {steps.length && value
        ? <EffortSlider steps={steps} value={value} onChange={effort.onChange} />
        : model !== undefined && <span className="effort-strip-none">{modelLabel} has no effort setting</span>}
    </div>}
    {mode && <div className="library-setting">
      <span className="library-setting-axis">Mode</span>
      <Segmented
        label="Permission mode"
        className="library-modes"
        options={mode.choices.map((choice) => {
          const Icon = choice.icon;
          return { value: choice.value, label: <><Icon size={14} aria-hidden="true" />{choice.label}</>, tip: choice.description, ...(choice.danger ? { tone: "danger" } : {}) };
        })}
        value={mode.value}
        onChange={mode.onChange}
      />
    </div>}
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
  /** Set where the menu picks the permission mode too. */
  mode?: ModeControl;
};

function ModelLibrary({ engine, engineLocked, engineAccess, model, modelLabel, favoriteModels = [], onModelFavorite, onChange, onSignIn, onOpenEngineSettings, models, effort, mode, close }: ModelLibraryProps & { modelLabel: string; close: () => void }) {
  const catalog = useModelCatalog();
  const [filter, setFilter] = useState<LibraryFilter>(() => libraryOpening(catalog, { engine, locked: engineLocked, model, favorites: favoriteModels }));
  const [query, setQuery] = useState("");
  const results = useRef<HTMLDivElement>(null);
  const search = query.trim();
  const { available, shown, count, total, favoriteCount, heading } = modelLibrary(catalog, engineAccess, { engine, locked: engineLocked, favorites: favoriteModels, filter, query, ...(models ? { allows: models } : {}) });

  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(results.current?.querySelectorAll<HTMLButtonElement>('.model-choice:not([aria-disabled="true"])') ?? [])];
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
      <SearchField variant="palette" type="text" autoFocus label="Find a model or provider" placeholder="Find a model or provider…" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
      <IconButton label="Close model picker" onClick={close}><X size={16} /></IconButton>
    </div>
    <div className="model-library-body">
      <NavList className="model-provider-rail" label="Filter models">
        <NavItem selected={!search && filter === "favorites"} icon={<Star size={16} />} count={favoriteCount} onClick={() => { setFilter("favorites"); setQuery(""); }}>Favorites</NavItem>
        <NavItem selected={!search && filter === "all"} icon={<Grid size={16} />} count={total} onClick={() => { setFilter("all"); setQuery(""); }}>All models</NavItem>
        <NavSeparator />
        {available.map((group) => <NavItem key={group.key} selected={!search && filter === group.key} icon={<ProviderMark engine={group.engine} groupKey={group.key} />} count={group.models.length} onClick={() => { setFilter(group.key); setQuery(""); }}>{group.label}</NavItem>)}
      </NavList>
      <div className="model-results" data-checkable ref={results} onKeyDown={navigate}>
        <div className="model-results-heading"><span>{heading}</span><span aria-live="polite">{count} models</span></div>
        {shown.map((group) => <div key={group.key} role="group" aria-label={group.label}>
          {group.models.map((spec) => {
            const selected = group.engine === engine && spec.id === model;
            const favorite = isFavorite(favoriteModels, group.engine, spec.id);
            const Icon = modelIcon(group.engine, spec.id);
            return <div key={spec.id} className="model-row">
              <MenuItem
                role="button"
                className="model-choice"
                checked={selected}
                disabled={!group.selectable}
                icon={<Icon size={16} />}
                description={<span data-tip={`${group.label} · ${spec.description}`} data-tip-overflow>{group.label} · {spec.description}</span>}
                onClick={() => { onChange(group.engine, spec.id); if (!effort) close(); }}
              >
                {spec.label}
              </MenuItem>
              {onModelFavorite && <IconButton className="model-favorite" label={`${favorite ? "Unpin" : "Pin"} ${spec.label}`} tip={favorite ? "Unpin from Favorites" : "Pin to Favorites"} pressed={favorite} onClick={() => onModelFavorite(group.engine, spec.id, !favorite)}><Star size={16} fill={favorite ? "currentColor" : "none"} /></IconButton>}
            </div>;
          })}
          {group.hint?.kind === "new-thread" && <p className="setting-hint">Start a new thread to use {engineLabel(group.engine)}</p>}
          {group.hint?.kind === "sign-in" && <Button variant="link" className="setting-hint" onClick={() => { onSignIn(group.engine); close(); }}>Sign in to use {group.label}</Button>}
          {group.hint?.kind === "notice" && <ReadinessHint notice={group.hint.notice} onOpenSettings={onOpenEngineSettings ? () => { onOpenEngineSettings(); close(); } : undefined} />}
        </div>)}
        {count === 0 && <MenuNote className="model-empty">{search ? "No models found. Try another name or provider." : filter === "favorites" ? "Pin models from All models to keep them here." : "No models available."}</MenuNote>}
      </div>
    </div>
    {effort || mode
      ? <LibrarySettings engine={engine} model={model} modelLabel={modelLabel} {...(effort ? { effort } : {})} {...(mode ? { mode } : {})} />
      : <div className="model-library-footer">{engineLocked ? `This thread uses ${engineLabel(engine)}.` : "↑ ↓ navigate · Enter select"}<span><Star size={12} /> Pin your go-to models</span></div>}
  </>;
}

/** The model chip and the library it opens, with the effort and mode beside the model where `effort` and `mode` are set. `onOpen` asks after the engines, so the library can say which it can pick. */
export function ModelMenu({ onOpen, ...props }: ModelLibraryProps & { onOpen: () => void }) {
  /** A model this build does not know, as a newer computer may run, is named as it is sent. */
  const catalog = useModelCatalog();
  const offered = modelsFor(catalog, props.engine);
  const selected = offered.find((spec) => spec.id === props.model) ?? (props.model !== undefined && catalogHasModel(catalog, props.model) ? offered[0] : undefined);
  const modelLabel = selected?.label ?? props.model ?? "Choose a model";
  const { effort, mode } = props;
  const { steps, value } = effort ? effortSteps(catalog, props.engine, props.model, effort) : { steps: [], value: undefined };
  const shown = steps.find((spec) => spec.id === value);
  const modeChoice = mode?.choices.find((choice) => choice.value === mode.value);
  const modeLabel = modeChoice?.label ?? mode?.value;
  const ModeIcon = modeChoice?.icon;
  /** Left and right step the effort from anywhere in the library but a search being typed or the mode row. */
  const stepEffort = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !effort || !steps.length || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    if (event.target instanceof HTMLInputElement && event.target.value) return;
    event.preventDefault();
    const next = steps[steps.findIndex((spec) => spec.id === value) + (event.key === "ArrowRight" ? 1 : -1)];
    if (next) effort.onChange(next.id);
  };
  const effortLabel = steps.length ? shown?.label ?? value : undefined;
  const settings = ["Model", ...(effortLabel ? ["effort"] : []), ...(mode ? ["mode"] : [])];
  const spoken = settings.length > 1 ? `${settings.slice(0, -1).join(", ")} and ${settings.at(-1)}` : "Model";
  return <SettingMenu
    label={`${spoken}: ${[modelLabel, effortLabel, modeLabel].filter(Boolean).join(", ")}`}
    {...(mode ? {} : { axis: "Model" })}
    heading={`Choose ${spoken.toLowerCase()}`}
    value={modelLabel}
    danger={modeChoice?.danger}
    detail={effortLabel || mode ? <>
      {effortLabel && <span className={`setting-effort${shown?.delegates ? " delegates" : ""}`}>{effortLabel}</span>}
      {effortLabel && mode && <span className="setting-dot" aria-hidden="true">·</span>}
      {mode && <span className="setting-mode">{ModeIcon && <ModeIcon size={12} aria-hidden="true" />}{modeLabel}</span>}
    </> : undefined}
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
  const modeControl: ModeControl | undefined = controls.available({ type: "task.set-policy", taskId, policy: mode })
    ? { value: mode, choices: modesOf[engine], onChange: onModeChange }
    : undefined;
  const effortControl: EffortControl | undefined = controls.available({ type: "task.set-effort", taskId, engine, effort })
    ? { value: effort, coordinating, onChange: (choice) => onEffortChange(engine, choice) }
    : undefined;
  return (
    <div className="composer-settings">
      {!controls.available({ type: "task.set-model", taskId, engine, model }) && modeControl && <ChoiceMenu label="Permission mode" axis="Mode" heading={`How should ${engineLabel} actions be approved?`} choices={modeControl.choices} value={mode} onChange={onModeChange} />}
      <CommandGate command={{ type: "task.set-model", taskId, engine, model }}><ModelMenu engine={engine} engineLocked={engineLocked} engineAccess={engineAccess} model={model} favoriteModels={favoriteModels} onModelFavorite={onModelFavorite} onChange={onModelChange} onOpen={onEngineRead} onSignIn={onSignIn} {...(effortControl ? { effort: effortControl } : {})} {...(modeControl ? { mode: modeControl } : {})} {...(onOpenEngineSettings ? { onOpenEngineSettings } : {})} /></CommandGate>
      {capabilitiesFor(engine).fastMode && <CommandButton command={{ type: "task.set-fast-mode", taskId, fastMode: !fastMode }} variant="ghost" pill data-toggle="accent" className="fast-mode-toggle" aria-label="Fast mode" aria-pressed={fastMode} data-tip={`Fast mode ${fastMode ? "on" : "off"} · faster responses use more of your plan`} onClick={() => onFastModeChange(!fastMode)}><Zap size={14} fill={fastMode ? "currentColor" : "none"} aria-hidden="true" /><span aria-hidden="true">Fast</span></CommandButton>}
    </div>
  );
}
