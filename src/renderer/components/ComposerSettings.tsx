import type { IconType } from "react-icons";
import { LuBrain as Brain, LuCheck as Check, LuFeather as Feather, LuFileCheck2 as FileCheck2, LuFlame as Flame, LuGauge as Gauge, LuHand as Hand, LuMoon as Moon, LuNetwork as Network, LuShieldOff as ShieldOff, LuSignal as Signal, LuSignalHigh as SignalHigh, LuSignalLow as SignalLow, LuSignalMedium as SignalMedium, LuSparkles as Sparkles, LuZap as Zap } from "react-icons/lu";
import { useRef, useState, type ReactNode } from "react";
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

const modelIcons: Record<AgentModel, IconType> = { fable: Sparkles, opus: Brain, sonnet: Gauge, haiku: Feather, "gpt-5.6-sol": Sparkles, "gpt-5.6-terra": Gauge, "gpt-5.6-luna": Moon };

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

/** The model list is one list, headed by engine, so choosing a model is how an engine is chosen. */
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

function SettingMenu({ label, axis, heading, value, onOpen, children }: {
  label: string;
  axis: string;
  heading: string;
  value: ReactNode;
  onOpen?: () => void;
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
    {open && <div className="setting-popover" role="listbox" aria-label={heading} onKeyDown={moveListFocus}>
      <div className="setting-heading">{heading}</div>
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

function ModelMenu({ engine, engineLocked, engineAccess, model, onChange, onOpen, onSignIn, onOpenEngineSettings }: {
  engine: AgentEngine;
  engineLocked: boolean;
  engineAccess: Record<AgentEngine, EngineReadiness>;
  model: AgentModel;
  onChange: (engine: AgentEngine, model: AgentModel) => void;
  onOpen: () => void;
  onSignIn: (engine: AgentEngine) => void;
  /** Absent on a surface with no settings of its own, which then shows the note without the way in. */
  onOpenEngineSettings?: () => void;
}) {
  const selected = modelsOf[engine].find((item) => item.value === model) ?? modelsOf[engine][0];
  const offered = modelGroups.filter((group) => !engineLocked || group.engine === engine);
  const locked = modelGroups.filter((group) => engineLocked && group.engine !== engine);
  /** Only a menu that offers another engine needs to know whether that engine can be picked. */
  return <SettingMenu label="Model" axis="Model" heading="Choose a model" value={selected.label} {...(engineLocked ? {} : { onOpen })}>
    {(close) => <>
      {offered.map((group) => {
        const readiness = engineAccess[group.engine];
        const ready = readiness.access === "ready";
        const notice = engineNotice(group.engine, readiness);
        /** A command that names its models hides the ones it cannot run, so the list never offers a dead pick. */
        const choices = readiness.models ? group.choices.filter((item) => readiness.models?.includes(item.value)) : group.choices;
        return <div key={group.engine} className="setting-group" role="group" aria-label={group.label}>
          <div className="setting-group-heading">{group.label}</div>
          {choices.map((item) => <Option key={item.value} item={item} selected={group.engine === engine && item.value === model} disabled={!ready} {...(ready ? { onSelect: () => { onChange(group.engine, item.value); close(); } } : {})} />)}
          {readiness.access === "signed-out" && <button type="button" className="setting-hint" onClick={() => { onSignIn(group.engine); close(); }}>Sign in to use {group.label}</button>}
          {notice && <ReadinessHint notice={notice} {...(onOpenEngineSettings ? { onOpenSettings: () => { onOpenEngineSettings(); close(); } } : {})} />}
        </div>;
      })}
      {locked.length > 0 && <hr className="setting-rule" />}
      {locked.map((group) => <div key={group.engine} className="setting-option setting-locked" role="option" aria-selected={false} aria-disabled="true">Start a new thread to use {group.label}</div>)}
    </>}
  </SettingMenu>;
}

export function ComposerSettings({ mode, engine, engineLabel, engineLocked, engineAccess, model, effort, onModeChange, onModelChange, onEffortChange, onEngineRead, onSignIn, onOpenEngineSettings }: {
  mode: ExecutionPolicy;
  engine: AgentEngine;
  engineLabel: string;
  /** Set once the thread has an engine for good, which is from its first message on. */
  engineLocked: boolean;
  engineAccess: Record<AgentEngine, EngineReadiness>;
  model: AgentModel;
  effort: AgentEffort;
  onModeChange: (mode: ExecutionPolicy) => void;
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
      <ModelMenu engine={engine} engineLocked={engineLocked} engineAccess={engineAccess} model={model} onChange={onModelChange} onOpen={onEngineRead} onSignIn={onSignIn} {...(onOpenEngineSettings ? { onOpenEngineSettings } : {})} />
      {effortsOf[model].length > 0 && <ChoiceMenu label="Effort" axis="Effort" heading={`How hard should ${engineLabel} think?`} choices={effortsOf[model]} value={effortForModel(model, effort)} onChange={(choice) => onEffortChange(engine, choice)} />}
    </div>
  );
}
