import { CommandGate, CommandButton, useCommandControls } from "./CommandControl";
import type { IconType } from "react-icons";
import { LuStar as Star, LuGrid2X2 as Grid, LuChevronDown as ChevronDown, LuBrain as Brain, LuFeather as Feather, LuFileCheck2 as FileCheck2, LuGauge as Gauge, LuHand as Hand, LuMoon as Moon, LuShieldOff as ShieldOff, LuSparkles as Sparkles, LuZap as Zap } from "react-icons/lu";
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { byEngine, capabilitiesFor, catalogHasModel, effortForModel, effortsFor, engineLabel, isFavorite, modelsFor, offeredPolicies, type AgentEngine, type AgentModel, type EngineModel, type ModelCatalog, type EffortSpec, type EngineNotice, type EngineReadiness } from "../../domain/agent-engine";
import { modelLibrary, type LibraryEntry, type LibraryGroup } from "../../domain/model-library";
import { useModelCatalog } from "../model-catalog";
import { POLICIES, type AgentEffort, type ExecutionPolicy } from "../../domain/run";
import { useDismissibleLayer } from "../focus";
import { MenuGroup, MenuItem, MenuNote, MenuSeparator, MenuSurface, MenuTrigger, useListKeys, useMenuAnchor } from "../ui/Menu";
import { Button, IconButton, Segmented } from "../ui/Button";
import { SearchField } from "../ui/Field";
import { CopyButton } from "./CopyButton";

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

/** How wide the library is drawn; a narrower window takes it to its own width. */
const LIBRARY_WIDTH = 300;

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

/** The efforts as a row of bars, shallowest first and lit up to the one in effect, beside its name. Pointing at a bar names it; a press or a drag takes the effort under the pointer when let go. */
function EffortMeter({ steps, value, onChange }: { steps: readonly EffortSpec[]; value: AgentEffort; onChange: (effort: AgentEffort) => void }) {
  const bars = useRef<HTMLSpanElement>(null);
  /** The bar under the pointer, and whether the pointer is held down on the row. */
  const [pointed, setPointed] = useState<number | null>(null);
  const [held, setHeld] = useState(false);
  /** A new effort, however it was set, is the one named until the pointer moves again. */
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setPointed(null);
  }
  const last = steps.length - 1;
  const index = Math.max(0, steps.findIndex((spec) => spec.id === value));
  const lit = held && pointed !== null ? pointed : index;
  const named = steps[pointed ?? index];
  const pick = (step: number) => {
    const spec = steps[Math.min(last, Math.max(0, step))];
    if (spec && spec.id !== value) onChange(spec.id);
  };
  /** The effort whose bar the pointer is over, or the end one once it is past either end of the row. */
  const under = (event: PointerEvent<HTMLElement>) => {
    const stops = [...(bars.current?.children ?? [])];
    const at = stops.findIndex((stop) => event.clientX < stop.getBoundingClientRect().right);
    return at === -1 ? last : at;
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = ({ ArrowLeft: index - 1, ArrowDown: index - 1, ArrowRight: index + 1, ArrowUp: index + 1, Home: 0, End: last } as Record<string, number>)[event.key];
    if (step === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    pick(step);
  };
  const release = () => {
    if (held && pointed !== null) pick(pointed);
    setHeld(false);
  };
  return <div className={`effort-slider${steps[lit]?.delegates ? " delegates" : ""}`}>
    <span className="effort-value" aria-hidden="true">{named?.label}</span>
    <span
      ref={bars}
      className="effort-bars"
      role="slider"
      tabIndex={0}
      aria-label="Effort"
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={steps[index]?.label}
      onKeyDown={keyDown}
      onPointerDown={(event) => {
        if (event.button !== 0 || !last) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setHeld(true);
        setPointed(under(event));
      }}
      onPointerMove={(event) => setPointed(under(event))}
      onPointerLeave={() => { if (!held) setPointed(null); }}
      onPointerUp={release}
      onPointerCancel={() => setHeld(false)}
    >
      {steps.map((spec, step) => <span key={spec.id} className={`effort-stop${step <= lit ? " lit" : ""}`} data-tip={spec.description}>{spec.label}</span>)}
    </span>
  </div>;
}

/** The effort and mode for the model in the library, a row each under the list, so they stay in reach however long the list grows. With no model chosen, the effort says nothing of one. */
function LibrarySettings({ engine, model, modelLabel, effort, mode }: { engine: AgentEngine; model: AgentModel | undefined; modelLabel: string; effort?: EffortControl; mode?: ModeControl }) {
  const { steps, value } = effort ? effortSteps(useModelCatalog(), engine, model, effort) : { steps: [], value: undefined };
  const stepped = steps.length > 0 && value !== undefined;
  return <div className="library-settings">
    {effort && (stepped || model !== undefined) && <div className="library-setting effort-strip">
      {stepped
        ? <><span className="library-setting-axis">Effort</span><EffortMeter steps={steps} value={value} onChange={effort.onChange} /></>
        : <span className="effort-strip-none">{modelLabel} has no effort setting</span>}
    </div>}
    {mode && <div className="library-setting">
      <span className="library-setting-axis">Mode</span>
      <Segmented
        label="Permission mode"
        className="library-modes"
        options={mode.choices.map((choice) => ({ value: choice.value, label: <span className="mode-word" data-label={choice.label}>{choice.label}</span>, tip: choice.description, ...(choice.danger ? { tone: "danger" } : {}) }))}
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

/** Why a model's row cannot be picked, in the words its engine's heading says it. */
function blocked(available: readonly LibraryGroup[], group: LibraryGroup): string | undefined {
  const hint = available.find((other) => other.engine === group.engine && other.hint)?.hint;
  if (hint?.kind === "new-thread") return `Start a new thread to use ${engineLabel(group.engine)}`;
  if (hint?.kind === "sign-in") return `Sign in to use ${engineLabel(group.engine)}`;
  return hint?.notice.message;
}

/** What a heading says stands in the way of its models, with the way past it where there is one. */
function GroupHint({ group, onSignIn, onOpenSettings }: { group: LibraryGroup; onSignIn: () => void; onOpenSettings?: () => void }) {
  if (group.hint?.kind === "new-thread") return <p className="setting-hint">Start a new thread to use {engineLabel(group.engine)}</p>;
  if (group.hint?.kind === "sign-in") return <Button variant="link" className="setting-hint" onClick={onSignIn}>Sign in to use {group.label}</Button>;
  if (group.hint?.kind === "notice") return <ReadinessHint notice={group.hint.notice} {...(onOpenSettings ? { onOpenSettings } : {})} />;
  return null;
}

/**
 * One menu: the models kept in reach, every other model under its provider once asked for, and the
 * effort and mode under them. Typing searches every model in place.
 */
function ModelLibrary({ engine, engineLocked, engineAccess, model, modelLabel, favoriteModels = [], onModelFavorite, onChange, onSignIn, onOpenEngineSettings, models, effort, mode, close }: ModelLibraryProps & { modelLabel: string; close: () => void }) {
  const catalog = useModelCatalog();
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const search = query.trim();
  const { available, home, top, rest, notice } = modelLibrary(catalog, engineAccess, { engine, locked: engineLocked, favorites: favoriteModels, query, ...(model === undefined ? {} : { model }), ...(models ? { allows: models } : {}) });
  /** With nothing to keep in reach, the headings are all there is to show. */
  const open = all || search !== "" || !top.length;
  const lead = !search && top.length > 1 && !top[0]!.pinned && top[1]!.pinned;

  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('.model-choice:not([aria-disabled="true"])') ?? [])];
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
  const hintActions = (group: LibraryGroup) => ({ group, onSignIn: () => { onSignIn(group.engine); close(); }, ...(onOpenEngineSettings ? { onOpenSettings: () => { onOpenEngineSettings(); close(); } } : {}) });
  const row = ({ group, spec, pinned }: LibraryEntry, provider?: string) => {
    const Icon = modelIcon(group.engine, spec.id);
    return <div key={`${group.key}/${spec.id}`} className="model-row">
      <MenuItem
        role="button"
        className="model-choice"
        checked={group.engine === engine && spec.id === model}
        disabled={!group.selectable}
        icon={<Icon size={16} />}
        detail={provider}
        data-tip={group.selectable ? spec.description : blocked(available, group)}
        onClick={() => { onChange(group.engine, spec.id); if (!effort) close(); }}
      >
        {spec.label}
      </MenuItem>
      {onModelFavorite && <IconButton size="xs" className="model-favorite" label={`${pinned ? "Unpin" : "Pin"} ${spec.label}`} tip={pinned ? "Unpin from Favorites" : "Pin to Favorites"} pressed={pinned} onClick={() => onModelFavorite(group.engine, spec.id, !pinned)}><Star size={14} fill={pinned ? "currentColor" : "none"} /></IconButton>}
    </div>;
  };

  return <>
    <div className="model-search" onKeyDown={navigate}>
      <SearchField variant="menu" type="text" autoFocus label="Search models" placeholder="Search models" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
    </div>
    <div className="model-list" ref={list} onKeyDown={navigate}>
      {top.map((entry, at) => <div key={`${entry.group.key}/${entry.spec.id}`} className="model-kept">
        {row(entry, entry.group.key === home ? undefined : entry.group.label)}
        {lead && at === 0 && <MenuSeparator />}
      </div>)}
      {notice && !search && <GroupHint {...hintActions(notice)} />}
      {open && rest.map((group) => <MenuGroup key={group.key} label={group.label} aria-label={group.label}>
        {group.models.map((spec) => row({ group, spec, pinned: isFavorite(favoriteModels, group.engine, spec.id) }))}
        <GroupHint {...hintActions(group)} />
      </MenuGroup>)}
      {search && !top.length && !rest.length && <MenuNote className="model-empty">No models found. Try another name or provider.</MenuNote>}
    </div>
    {!search && top.length > 0 && rest.length > 0 && <MenuItem role="button" className="model-all" aria-expanded={all} icon={<Grid size={16} />} detail={<ChevronDown size={14} aria-hidden="true" />} onClick={() => setAll(!all)}>All models</MenuItem>}
    {(effort || mode) && <>
      <MenuSeparator />
      <LibrarySettings engine={engine} model={model} modelLabel={modelLabel} {...(effort ? { effort } : {})} {...(mode ? { mode } : {})} />
    </>}
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
