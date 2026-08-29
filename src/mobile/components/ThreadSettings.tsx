import { LuCheck as Check } from "react-icons/lu";
import { Fragment, useEffect, useRef, useState } from "react";
import type { MobileThreadSettings } from "../../contracts/mobile";
import { AGENT_ENGINES, byEngine, byModel, effortForModel, engineLabel, modelsFor, type AgentEngine, type AgentModel } from "../../domain/agent-engine";
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
  const sheet = useRef<HTMLDivElement>(null);
  /** Set once close is asked for; the sheet leaves when its exit animation ends. */
  const [closing, setClosing] = useState(false);

  /** Focus lands on the chosen option and goes back to where it came from once the sheet is gone. */
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = sheet.current;
    const chosen = node?.querySelector<HTMLElement>('[aria-checked="true"]');
    (chosen ?? node)?.focus({ preventScroll: true });
    return () => opener?.focus({ preventScroll: true });
  }, []);

  function close() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) onClose();
    else setClosing(true);
  }

  return (
    <div
      className={closing ? "scrim closing" : "scrim"}
      role="dialog"
      aria-modal="true"
      aria-label="Thread settings"
      onClick={close}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <div ref={sheet} className="sheet" tabIndex={-1} onClick={(event) => event.stopPropagation()} onAnimationEnd={() => closing && onClose()}>
        <div className="sheet-head">
          <h2>Settings</h2>
          <button type="button" className="sheet-done" onClick={close}>Done</button>
        </div>
        <div className="sheet-body">
          <Group heading="Mode" choices={MODES} value={settings.policy} onChange={onPolicy} />
          <ModelGroup engine={settings.engine} model={settings.model} locked={locked} onModel={onModel} />
          {effortsOf[settings.model].length > 0 && <Group heading="Effort" choices={effortsOf[settings.model]} value={effortForModel(settings.model, settings.effort)} onChange={(effort) => onEffort(settings.engine, effort)} />}
        </div>
      </div>
    </div>
  );
}
