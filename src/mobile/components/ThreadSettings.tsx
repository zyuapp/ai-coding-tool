import { Check } from "lucide-react";
import { Fragment } from "react";
import type { MobileThreadSettings } from "../../contracts/mobile";
import { AGENT_ENGINES, byEngine, effortsFor, engineLabel, modelsFor, type AgentEngine, type AgentModel } from "../../domain/agent-engine";
import type { AgentEffort, ExecutionPolicy } from "../../domain/run";

type Choice<T extends string> = { value: T; label: string; description: string };

/** The same wording the desktop composer uses, so a setting means one thing across both screens. */
const MODES: Choice<ExecutionPolicy>[] = [
  { value: "autonomous", label: "Auto mode", description: "Only ask for potentially unsafe actions" },
  { value: "allow-edits", label: "Allow all edit", description: "Apply file edits without asking" },
  { value: "confirm", label: "Let me decide", description: "Ask before using tools or changing files" },
];

const modelsOf = byEngine((engine): Choice<AgentModel>[] => modelsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, description: spec.description })));
const effortsOf = byEngine((engine): Choice<AgentEffort>[] => effortsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, description: spec.description })));

/** One model list headed by engine, so choosing a model is how an engine is chosen. */
const modelGroups = AGENT_ENGINES.map((engine) => ({ engine, label: engineLabel(engine), choices: modelsOf[engine] }));

function OptionButton<T extends string>({ choice, selected, onSelect }: { choice: Choice<T>; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} className="sheet-option" onClick={onSelect}>
      <span><strong>{choice.label}</strong><small>{choice.description}</small></span>
      <span className="sheet-check" aria-hidden="true">{selected && <Check size={20} />}</span>
    </button>
  );
}

function Group<T extends string>({ heading, choices, value, onChange }: { heading: string; choices: Choice<T>[]; value: T; onChange: (value: T) => void }) {
  return (
    <section className="sheet-group" role="radiogroup" aria-label={heading}>
      <h3>{heading}</h3>
      {choices.map((choice) => <OptionButton key={choice.value} choice={choice} selected={choice.value === value} onSelect={() => onChange(choice.value)} />)}
    </section>
  );
}

/** A thread that already has an engine offers only that engine's models; the others say how to get them. */
function ModelGroup({ engine, model, locked, onModel }: { engine: AgentEngine; model: AgentModel; locked: boolean; onModel: (engine: AgentEngine, model: AgentModel) => void }) {
  return (
    <section className="sheet-group" role="radiogroup" aria-label="Model">
      <h3>Model</h3>
      {modelGroups.filter((group) => !locked || group.engine === engine).map((group) => (
        <Fragment key={group.engine}>
          <h4 className="sheet-subheading">{group.label}</h4>
          {group.choices.map((choice) => <OptionButton key={choice.value} choice={choice} selected={group.engine === engine && choice.value === model} onSelect={() => onModel(group.engine, choice.value)} />)}
        </Fragment>
      ))}
      {locked && modelGroups.filter((group) => group.engine !== engine).map((group) => (
        <div key={group.engine} className="sheet-option sheet-locked" aria-disabled="true"><span><strong>Start a new thread to use {group.label}</strong></span></div>
      ))}
    </section>
  );
}

export function ThreadSettings({ settings, locked, onClose, onPolicy, onModel, onEffort }: {
  settings: MobileThreadSettings;
  /** Set for a thread that exists, whose engine is settled; a draft may still pick either. */
  locked: boolean;
  onClose: () => void;
  onPolicy: (policy: ExecutionPolicy) => void;
  onModel: (engine: AgentEngine, model: AgentModel) => void;
  onEffort: (engine: AgentEngine, effort: AgentEffort) => void;
}) {
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Thread settings" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-body">
          <Group heading="Permission" choices={MODES} value={settings.policy} onChange={onPolicy} />
          <ModelGroup engine={settings.engine} model={settings.model} locked={locked} onModel={onModel} />
          <Group heading="Effort" choices={effortsOf[settings.engine]} value={settings.effort} onChange={(effort) => onEffort(settings.engine, effort)} />
        </div>
        <button type="button" className="primary wide" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
