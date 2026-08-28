import type { IconType } from "react-icons";
import { LuBrain as Brain, LuCheck as Check, LuFeather as Feather, LuFileCheck2 as FileCheck2, LuFlame as Flame, LuGauge as Gauge, LuHand as Hand, LuMoon as Moon, LuShieldOff as ShieldOff, LuSignal as Signal, LuSignalHigh as SignalHigh, LuSignalLow as SignalLow, LuSignalMedium as SignalMedium, LuSparkles as Sparkles, LuZap as Zap } from "react-icons/lu";
import { useRef, useState, type ReactNode } from "react";
import { AGENT_ENGINES, byEngine, effortsFor, engineLabel, modelsFor, type AgentEngine, type AgentModel, type EngineReadiness } from "../../domain/agent-engine";
import type { AgentEffort, ExecutionPolicy } from "../../domain/run";
import { moveListFocus, useDismissibleLayer } from "../focus";
import { CopyButton } from "./CopyButton";

type Choice<T extends string> = { value: T; label: string; short: string; description: string; icon: IconType; danger?: true };

// ExecutionPolicy still accepts "plan"; it is left out of the picker because nobody uses it.
const modes: Choice<ExecutionPolicy>[] = [
  { value: "autonomous", label: "Auto mode", short: "Auto", description: "Only ask for potentially unsafe actions", icon: Zap },
  { value: "bypass", label: "Bypass permissions", short: "Bypass", description: "Use tools and change files without asking", icon: ShieldOff, danger: true },
  { value: "allow-edits", label: "Allow edits", short: "Edits", description: "Apply file edits without asking", icon: FileCheck2 },
  { value: "confirm", label: "Let me decide", short: "Confirm", description: "Ask before using tools or changing files", icon: Hand },
];

const modelIcons: Record<AgentModel, IconType> = { fable: Sparkles, opus: Brain, sonnet: Gauge, haiku: Feather, "gpt-5.6-sol": Sparkles, "gpt-5.6-terra": Gauge, "gpt-5.6-luna": Moon };

const effortStyles: Record<AgentEffort, { short: string; icon: IconType }> = {
  ultra: { short: "Ultra", icon: Flame },
  max: { short: "Max", icon: Flame },
  xhigh: { short: "Extra high", icon: Signal },
  high: { short: "High", icon: SignalHigh },
  medium: { short: "Medium", icon: SignalMedium },
  low: { short: "Low", icon: SignalLow },
};

const modelsOf = byEngine((engine): Choice<AgentModel>[] => modelsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, short: spec.label, description: spec.description, icon: modelIcons[spec.id] })));
const effortsOf = byEngine((engine): Choice<AgentEffort>[] => effortsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, description: spec.description, ...effortStyles[spec.id] })));

/** The model list is one list, headed by engine, so choosing a model is how an engine is chosen. */
const modelGroups = AGENT_ENGINES.map((engine) => ({ engine, label: engineLabel(engine), choices: modelsOf[engine] }));

export const EVERY_ENGINE_READY = byEngine((): EngineReadiness => ({ access: "ready" }));

/** What stands between an engine and a run, in the words the user needs to clear it. */
function readinessNote(label: string, readiness: EngineReadiness): string | null {
  if (readiness.access === "missing") return `${label} is not installed`;
  if (readiness.access === "outdated") return `${label} ${readiness.version ?? ""} is too old. This app needs ${readiness.required}.`.replace("  ", " ");
  if (readiness.access === "unavailable") return `${label} would not start`;
  /** Ready, but behind: the models it never heard of are simply absent, so say why the list is short. */
  if (readiness.required) return `More models after upgrading ${label}`;
  return null;
}

function ReadinessHint({ note, fix }: { note: string; fix?: string }) {
  return <div className="setting-hint setting-readiness">
    <span>{note}</span>
    {fix ? <><code>{fix}</code><CopyButton text={fix} label={`Copy ${fix}`} /></> : null}
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
    <span><strong>{item.label}</strong><small>{item.description}</small></span>
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
  return <SettingMenu label={label} axis={axis} heading={heading} value={selected.short}>
    {(close) => choices.map((item) => <Option key={item.value} item={item} selected={item.value === value} onSelect={() => { onChange(item.value); close(); }} />)}
  </SettingMenu>;
}

function ModelMenu({ engine, engineLocked, engineAccess, model, onChange, onOpen, onSignIn }: {
  engine: AgentEngine;
  engineLocked: boolean;
  engineAccess: Record<AgentEngine, EngineReadiness>;
  model: AgentModel;
  onChange: (engine: AgentEngine, model: AgentModel) => void;
  onOpen: () => void;
  onSignIn: (engine: AgentEngine) => void;
}) {
  const selected = modelsOf[engine].find((item) => item.value === model) ?? modelsOf[engine][0];
  const offered = modelGroups.filter((group) => !engineLocked || group.engine === engine);
  const locked = modelGroups.filter((group) => engineLocked && group.engine !== engine);
  /** Only a menu that offers another engine needs to know whether that engine can be picked. */
  return <SettingMenu label="Model" axis="Model" heading="Choose a model" value={selected.short} {...(engineLocked ? {} : { onOpen })}>
    {(close) => <>
      {offered.map((group) => {
        const readiness = engineAccess[group.engine];
        const ready = readiness.access === "ready";
        const note = readinessNote(group.label, readiness);
        /** A command that names its models hides the ones it cannot run, so the list never offers a dead pick. */
        const choices = readiness.models ? group.choices.filter((item) => readiness.models?.includes(item.value)) : group.choices;
        return <div key={group.engine} className="setting-group" role="group" aria-label={group.label}>
          <div className="setting-group-heading">{group.label}</div>
          {choices.map((item) => <Option key={item.value} item={item} selected={group.engine === engine && item.value === model} disabled={!ready} {...(ready ? { onSelect: () => { onChange(group.engine, item.value); close(); } } : {})} />)}
          {readiness.access === "signed-out" && <button type="button" className="setting-hint" onClick={() => { onSignIn(group.engine); close(); }}>Sign in to use {group.label}</button>}
          {note && <ReadinessHint note={note} {...(readiness.fix ? { fix: readiness.fix } : {})} />}
        </div>;
      })}
      {locked.length > 0 && <hr className="setting-rule" />}
      {locked.map((group) => <div key={group.engine} className="setting-option setting-locked" role="option" aria-selected={false} aria-disabled="true">Start a new thread to use {group.label}</div>)}
    </>}
  </SettingMenu>;
}

export function ComposerSettings({ mode, engine, engineLabel, engineLocked, engineAccess, model, effort, onModeChange, onModelChange, onEffortChange, onEngineRead, onSignIn }: {
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
}) {
  return (
    <div className="composer-settings">
      <ChoiceMenu label="Permission mode" axis="Mode" heading={`How should ${engineLabel} actions be approved?`} choices={modes} value={mode} onChange={onModeChange} />
      <ModelMenu engine={engine} engineLocked={engineLocked} engineAccess={engineAccess} model={model} onChange={onModelChange} onOpen={onEngineRead} onSignIn={onSignIn} />
      <ChoiceMenu label="Effort" axis="Effort" heading={`How hard should ${engineLabel} think?`} choices={effortsOf[engine]} value={effort} onChange={(choice) => onEffortChange(engine, choice)} />
    </div>
  );
}
