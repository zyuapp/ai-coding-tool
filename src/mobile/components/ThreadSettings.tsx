import { LuCheck as Check, LuZap as Zap } from "react-icons/lu";
import { Fragment } from "react";
import type { MobileThreadSettings } from "../../contracts/mobile";
import { Sheet } from "./Sheet";
import { AGENT_ENGINES, capabilitiesFor, byEngine, byModel, effortForModel, engineLabel, modelsFor, type AgentEngine, type AgentModel } from "../../domain/agent-engine";
import { POLICIES, POLICY_CHOICES, type AgentEffort, type ExecutionPolicy } from "../../domain/run";

type Choice<T extends string> = { value: T; label: string; description?: string };

const MODES: Choice<ExecutionPolicy>[] = POLICY_CHOICES.map((policy) => ({ value: policy, ...POLICIES[policy] }));

const modelsOf = byEngine((engine): Choice<AgentModel>[] => modelsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, description: spec.description })));
const effortsOf = byModel((model): Choice<AgentEffort>[] => model.efforts.map((spec) => ({ value: spec.id, ...spec })));

/** One model list headed by engine, so choosing a model is how an engine is chosen. */
const modelGroups = AGENT_ENGINES.map((engine) => ({ engine, label: engineLabel(engine), choices: modelsOf[engine] }));

function OptionButton<T extends string>({ choice, selected, onSelect }: { choice: Choice<T>; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} className="sheet-option" onClick={onSelect}>
      <span><strong>{choice.label}</strong>{choice.description && <small>{choice.description}</small>}</span>
      <span className="sheet-check" aria-hidden="true">{selected && <Check size={16} />}</span>
    </button>
  );
}

function Group<T extends string>({ heading, choices, value, onChange }: { heading: string; choices: readonly Choice<T>[]; value: T; onChange: (value: T) => void }) {
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

export function ThreadSettings({ settings, locked, onClose, onPolicy, onModel, onEffort, onFastMode }: {
  settings: MobileThreadSettings;
  /** Set for a thread that exists, whose engine is settled; a draft may still pick either. */
  locked: boolean;
  onClose: () => void;
  onPolicy: (policy: ExecutionPolicy) => void;
  onModel: (engine: AgentEngine, model: AgentModel) => void;
  onFastMode: (fastMode: boolean) => void;
  onEffort: (engine: AgentEngine, effort: AgentEffort) => void;
}) {
  return (
    <Sheet title="Settings" label="Thread settings" onClose={onClose}>
      <Group heading="Mode" choices={MODES} value={settings.policy} onChange={onPolicy} />
      <ModelGroup engine={settings.engine} model={settings.model} locked={locked} onModel={onModel} />
      {effortsOf[settings.model].length > 0 && <Group heading="Effort" choices={effortsOf[settings.model]} value={effortForModel(settings.model, settings.effort)} onChange={(effort) => onEffort(settings.engine, effort)} />}
      {capabilitiesFor(settings.engine).fastMode && <button type="button" className="sheet-option fast-mode-switch" role="switch" aria-label="Fast mode" aria-checked={settings.fastMode ?? false} onClick={() => onFastMode(!settings.fastMode)}>
        <Zap size={20} aria-hidden="true" />
        <span><strong>Fast mode</strong><small>Faster responses · uses more of your plan</small></span>
        <span className="switch-track" aria-hidden="true" />
      </button>}
    </Sheet>
  );
}
