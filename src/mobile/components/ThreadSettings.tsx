import { Check } from "lucide-react";
import type { MobileThreadSettings } from "../../contracts/mobile";
import { effortsFor, modelsFor, type AgentEngine, type AgentModel } from "../../domain/agent-engine";
import type { AgentEffort, ExecutionPolicy } from "../../domain/run";

type Choice<T extends string> = { value: T; label: string; description: string };

/** The same wording the desktop composer uses, so a setting means one thing across both screens. */
const MODES: Choice<ExecutionPolicy>[] = [
  { value: "autonomous", label: "Auto mode", description: "Only ask for potentially unsafe actions" },
  { value: "allow-edits", label: "Allow all edit", description: "Apply file edits without asking" },
  { value: "confirm", label: "Let me decide", description: "Ask before using tools or changing files" },
];

/** Each engine's choices are built once, the first time its sheet renders. */
function perEngine<T>(build: (engine: AgentEngine) => T) {
  const built = new Map<AgentEngine, T>();
  return (engine: AgentEngine) => built.get(engine) ?? built.set(engine, build(engine)).get(engine)!;
}

const modelsOf = perEngine((engine): Choice<AgentModel>[] => modelsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, description: spec.description })));

const EFFORT_CHOICES: Record<AgentEffort, Omit<Choice<AgentEffort>, "value">> = {
  max: { label: "Max effort", description: "Everything the model has, slowest" },
  xhigh: { label: "Extra high effort", description: "Deeper than high, where the model offers it" },
  high: { label: "High effort", description: "Deep reasoning" },
  medium: { label: "Medium effort", description: "Moderate thinking" },
  low: { label: "Low effort", description: "Minimal thinking, fastest replies" },
};

const effortsOf = perEngine((engine): Choice<AgentEffort>[] => effortsFor(engine).map((value) => ({ value, ...EFFORT_CHOICES[value] })));

function Group<T extends string>({ heading, choices, value, onChange }: { heading: string; choices: Choice<T>[]; value: T; onChange: (value: T) => void }) {
  return (
    <section className="sheet-group" role="radiogroup" aria-label={heading}>
      <h3>{heading}</h3>
      {choices.map((choice) => (
        <button key={choice.value} type="button" role="radio" aria-checked={choice.value === value} className="sheet-option" onClick={() => onChange(choice.value)}>
          <span><strong>{choice.label}</strong><small>{choice.description}</small></span>
          <span className="sheet-check" aria-hidden="true">{choice.value === value && <Check size={20} />}</span>
        </button>
      ))}
    </section>
  );
}

export function ThreadSettings({ settings, onClose, onPolicy, onModel, onEffort }: {
  settings: MobileThreadSettings;
  onClose: () => void;
  onPolicy: (policy: ExecutionPolicy) => void;
  onModel: (engine: AgentEngine, model: AgentModel) => void;
  onEffort: (effort: AgentEffort) => void;
}) {
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Thread settings" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-body">
          <Group heading="Permission" choices={MODES} value={settings.policy} onChange={onPolicy} />
          <Group heading="Model" choices={modelsOf(settings.engine)} value={settings.model} onChange={(model) => onModel(settings.engine, model)} />
          <Group heading="Effort" choices={effortsOf(settings.engine)} value={settings.effort} onChange={onEffort} />
        </div>
        <button type="button" className="primary wide" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
