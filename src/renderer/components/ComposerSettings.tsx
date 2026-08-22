import { Brain, Check, Feather, FileCheck2, Flame, Gauge, Hand, Signal, SignalHigh, SignalLow, SignalMedium, Sparkles, Zap, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../../domain/run";
import { moveListFocus, useDismissibleLayer } from "../focus";

type Choice<T extends string> = { value: T; label: string; description: string; icon: LucideIcon; elevated?: boolean };

// ExecutionPolicy still accepts "plan"; it is left out of the picker because nobody uses it.
const modes: Choice<ExecutionPolicy>[] = [
  { value: "autonomous", label: "Auto mode", description: "Only ask for potentially unsafe actions", icon: Zap, elevated: true },
  { value: "allow-edits", label: "Allow all edit", description: "Apply file edits without asking", icon: FileCheck2 },
  { value: "confirm", label: "Let me decide", description: "Ask before using tools or changing files", icon: Hand },
];

const models: Choice<AgentModel>[] = [
  { value: "fable", label: "Fable", description: "Most capable for demanding work", icon: Sparkles },
  { value: "opus", label: "Opus", description: "Best for complex reasoning", icon: Brain },
  { value: "sonnet", label: "Sonnet", description: "Balanced speed and capability", icon: Gauge },
  { value: "haiku", label: "Haiku", description: "Fastest for lightweight work", icon: Feather },
];

const efforts: Choice<AgentEffort>[] = [
  { value: "max", label: "Max effort", description: "Everything the model has, slowest", icon: Flame, elevated: true },
  { value: "xhigh", label: "Extra high effort", description: "Deeper than high, where the model offers it", icon: Signal },
  { value: "high", label: "High effort", description: "Deep reasoning", icon: SignalHigh },
  { value: "medium", label: "Medium effort", description: "Moderate thinking", icon: SignalMedium },
  { value: "low", label: "Low effort", description: "Minimal thinking, fastest replies", icon: SignalLow },
];

function ChoiceMenu<T extends string>({ label, heading, choices, value, onChange }: {
  label: string;
  heading: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const selected = choices.find((item) => item.value === value) ?? choices[0];
  const SelectedIcon = selected.icon;
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { if (details.current) details.current.open = false; };
  useDismissibleLayer(open, [details], close, summary);

  return <details ref={details} className={`setting-menu ${selected.elevated ? "elevated" : ""}`} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary ref={summary} aria-label={label}>
      <span className="setting-summary-icon" aria-hidden="true"><SelectedIcon size={16} /></span>
      <span className="setting-summary-label">{selected.label}</span>
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
          className={`setting-option ${item.elevated ? "elevated" : ""}`}
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

export function ComposerSettings({ mode, model, effort, onModeChange, onModelChange, onEffortChange }: {
  mode: ExecutionPolicy;
  model: AgentModel;
  effort: AgentEffort;
  onModeChange: (mode: ExecutionPolicy) => void;
  onModelChange: (model: AgentModel) => void;
  onEffortChange: (effort: AgentEffort) => void;
}) {
  return (
    <div className="composer-settings">
      <ChoiceMenu label="Permission mode" heading="How should Claude actions be approved?" choices={modes} value={mode} onChange={onModeChange} />
      <ChoiceMenu label="Model" heading="Choose a model" choices={models} value={model} onChange={onModelChange} />
      <ChoiceMenu label="Effort" heading="How hard should Claude think?" choices={efforts} value={effort} onChange={onEffortChange} />
    </div>
  );
}
