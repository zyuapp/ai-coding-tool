import { Brain, Check, Feather, FileCheck2, Flame, Gauge, Hand, Signal, SignalHigh, SignalLow, SignalMedium, Sparkles, Zap, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { effortsFor, modelsFor, type AgentEngine, type AgentModel } from "../../domain/agent-engine";
import type { AgentEffort, ExecutionPolicy } from "../../domain/run";
import { moveListFocus, useDismissibleLayer } from "../focus";

type Choice<T extends string> = { value: T; label: string; short: string; description: string; icon: LucideIcon };

// ExecutionPolicy still accepts "plan"; it is left out of the picker because nobody uses it.
const modes: Choice<ExecutionPolicy>[] = [
  { value: "autonomous", label: "Auto mode", short: "Auto", description: "Only ask for potentially unsafe actions", icon: Zap },
  { value: "allow-edits", label: "Allow all edit", short: "Edits", description: "Apply file edits without asking", icon: FileCheck2 },
  { value: "confirm", label: "Let me decide", short: "Confirm", description: "Ask before using tools or changing files", icon: Hand },
];

const modelIcons: Record<AgentModel, LucideIcon> = { fable: Sparkles, opus: Brain, sonnet: Gauge, haiku: Feather };

/** Each engine's choices are built once, the first time its picker renders. */
function perEngine<T>(build: (engine: AgentEngine) => T) {
  const built = new Map<AgentEngine, T>();
  return (engine: AgentEngine) => built.get(engine) ?? built.set(engine, build(engine)).get(engine)!;
}

const modelsOf = perEngine((engine): Choice<AgentModel>[] => modelsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, short: spec.label, description: spec.description, icon: modelIcons[spec.id] })));

const effortChoices: Record<AgentEffort, Omit<Choice<AgentEffort>, "value">> = {
  max: { label: "Max effort", short: "Max", description: "Everything the model has, slowest", icon: Flame },
  xhigh: { label: "Extra high effort", short: "Extra high", description: "Deeper than high, where the model offers it", icon: Signal },
  high: { label: "High effort", short: "High", description: "Deep reasoning", icon: SignalHigh },
  medium: { label: "Medium effort", short: "Medium", description: "Moderate thinking", icon: SignalMedium },
  low: { label: "Low effort", short: "Low", description: "Minimal thinking, fastest replies", icon: SignalLow },
};

const effortsOf = perEngine((engine): Choice<AgentEffort>[] => effortsFor(engine).map((value) => ({ value, ...effortChoices[value] })));

function ChoiceMenu<T extends string>({ label, axis, heading, choices, value, onChange }: {
  label: string;
  axis: string;
  heading: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const selected = choices.find((item) => item.value === value) ?? choices[0];
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (details.current) details.current.open = false; };
  useDismissibleLayer(open, [details], close, summary);

  return <details ref={details} className="setting-menu" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary ref={summary} aria-label={label}>
      <span className="setting-axis">{axis}</span>
      <span className="setting-value">{selected.short}</span>
    </summary>
    {open && <div className="setting-popover" role="listbox" aria-label={heading} onKeyDown={moveListFocus}>
      <div className="setting-heading">{heading}</div>
      {choices.map((item) => {
        const Icon = item.icon;
        return <button
          type="button"
          role="option"
          aria-selected={item.value === value}
          autoFocus={item.value === value}
          className="setting-option"
          key={item.value}
          onClick={(event) => {
            onChange(item.value);
            close();
          }}
        >
          <span className="setting-icon" aria-hidden="true"><Icon size={20} /></span>
          <span><strong>{item.label}</strong><small>{item.description}</small></span>
          <span className="setting-check" aria-hidden="true">{item.value === value && <Check size={20} />}</span>
        </button>;
      })}
    </div>}
  </details>;
}

export function ComposerSettings({ mode, engine, engineLabel, model, effort, onModeChange, onModelChange, onEffortChange }: {
  mode: ExecutionPolicy;
  engine: AgentEngine;
  engineLabel: string;
  model: AgentModel;
  effort: AgentEffort;
  onModeChange: (mode: ExecutionPolicy) => void;
  onModelChange: (engine: AgentEngine, model: AgentModel) => void;
  onEffortChange: (effort: AgentEffort) => void;
}) {
  return (
    <div className="composer-settings">
      <ChoiceMenu label="Permission mode" axis="Mode" heading={`How should ${engineLabel} actions be approved?`} choices={modes} value={mode} onChange={onModeChange} />
      <ChoiceMenu label="Model" axis="Model" heading="Choose a model" choices={modelsOf(engine)} value={model} onChange={(choice) => onModelChange(engine, choice)} />
      <ChoiceMenu label="Effort" axis="Effort" heading={`How hard should ${engineLabel} think?`} choices={effortsOf(engine)} value={effort} onChange={onEffortChange} />
    </div>
  );
}
