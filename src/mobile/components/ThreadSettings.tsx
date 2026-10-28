import { LuCheck as Check, LuSquarePen as SquarePen, LuZap as Zap } from "react-icons/lu";
import { Fragment, useEffect, useState, type KeyboardEvent } from "react";
import type { MobileThreadSettings } from "../../contracts/mobile";
import { Sheet } from "./Sheet";
import { AGENT_ENGINES, capabilitiesFor, byEngine, byModel, effortForModel, effortsFor, engineLabel, modelsFor, type AgentEngine, type AgentModel, type EffortSpec } from "../../domain/agent-engine";
import { POLICIES, POLICY_CHOICES, type AgentEffort, type ExecutionPolicy } from "../../domain/run";

type Choice<T extends string> = { value: T; label: string; description?: string };

const MODES: Choice<ExecutionPolicy>[] = POLICY_CHOICES.map((policy) => ({ value: policy, ...POLICIES[policy] }));

const modelsOf = byEngine((engine): Choice<AgentModel>[] => modelsFor(engine).map((spec) => ({ value: spec.id, label: spec.label, description: spec.description })));
const effortChoices = (efforts: readonly EffortSpec[]): Choice<AgentEffort>[] => efforts.map((spec) => ({ value: spec.id, ...spec }));
const effortsOf = byModel((model) => effortChoices(model.efforts));
const coordinatorEffortsOf = byModel((model) => effortChoices(effortsFor(model.id, "coordinator")));

/** One model list headed by engine, so choosing a model is how an engine is chosen. */
const modelGroups = AGENT_ENGINES.map((engine) => ({ engine, label: engineLabel(engine), choices: modelsOf[engine] }));

/** A group's one Tab stop is its chosen option, or its first when none is; the arrow keys move the choice, as the list switch's do. */
function OptionButton<T extends string>({ choice, selected, stop, onSelect }: { choice: Choice<T>; selected: boolean; stop: boolean; onSelect: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={selected} tabIndex={stop ? 0 : -1} className="sheet-option" onClick={onSelect}>
      <span><strong>{choice.label}</strong>{choice.description && <small>{choice.description}</small>}</span>
      <span className="sheet-check" aria-hidden="true">{selected && <Check size={16} strokeWidth={2.6} />}</span>
    </button>
  );
}

function moveChoice(event: KeyboardEvent<HTMLElement>) {
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
  if (!step) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const at = radios.indexOf(event.target as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length]!;
  next.focus();
  next.click();
}

function Group<T extends string>({ heading, choices, value, onChange }: { heading: string; choices: readonly Choice<T>[]; value: T; onChange: (value: T) => void }) {
  const known = choices.some((choice) => choice.value === value);
  return (
    <section className="sheet-group" role="radiogroup" aria-label={heading} onKeyDown={moveChoice}>
      <h3>{heading}</h3>
      {choices.map((choice, index) => <OptionButton key={choice.value} choice={choice} selected={choice.value === value} stop={known ? choice.value === value : index === 0} onSelect={() => onChange(choice.value)} />)}
    </section>
  );
}

/** A thread that already has an engine offers only that engine's models; the others start a thread on theirs. */
function ModelGroup({ engine, model, locked, onModel, onNewWith }: { engine: AgentEngine; model: AgentModel; locked: boolean; onModel: (engine: AgentEngine, model: AgentModel) => void; onNewWith?: (engine: AgentEngine) => void }) {
  const shown = modelGroups.filter((group) => !locked || group.engine === engine);
  const known = shown.some((group) => group.engine === engine && group.choices.some((choice) => choice.value === model));
  const others = locked && onNewWith ? modelGroups.filter((group) => group.engine !== engine) : [];
  return (
    <>
      <section className="sheet-group" role="radiogroup" aria-label="Model" onKeyDown={moveChoice}>
        <h3>Model</h3>
        {shown.map((group, groupIndex) => (
          <Fragment key={group.engine}>
            <h4 className="sheet-subheading">{group.label}</h4>
            {group.choices.map((choice, index) => {
              const selected = group.engine === engine && choice.value === model;
              return <OptionButton key={choice.value} choice={choice} selected={selected} stop={known ? selected : groupIndex === 0 && index === 0} onSelect={() => onModel(group.engine, choice.value)} />;
            })}
          </Fragment>
        ))}
      </section>
      {others.length > 0 && (
        <div className="menu-group sheet-actions">
          {others.map((group) => (
            <button key={group.engine} type="button" className="menu-row sheet-new-engine" onClick={() => onNewWith!(group.engine)}>
              <span className="menu-glyph" aria-hidden="true"><SquarePen size={18} strokeWidth={1.8} /></span>
              <span className="menu-copy"><strong>New thread with {group.label}</strong></span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** How long a tapped choice shows as made while the computer has yet to echo it back. */
const PENDING_MS = 4000;

type Pending = Partial<Pick<MobileThreadSettings, "policy" | "engine" | "model" | "effort" | "fastMode">>;

/**
 * The choice a tap made, shown at once and let go of when the computer's settings agree with it or
 * after a while, so one it turned down goes back to what it really is.
 */
function usePending(settings: MobileThreadSettings) {
  const [pending, setPending] = useState<Pending>({});
  const echoed = (Object.keys(pending) as (keyof Pending)[]).every((key) => settings[key] === pending[key]);
  useEffect(() => {
    if (!Object.keys(pending).length) return;
    if (echoed) { setPending({}); return; }
    const timer = setTimeout(() => setPending({}), PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending, echoed]);
  return [{ ...settings, ...pending }, (next: Pending) => setPending((current) => ({ ...current, ...next }))] as const;
}

export function ThreadSettings({ settings: given, locked, onNewWith, onClose, onPolicy, onModel, onEffort, onFastMode }: {
  settings: MobileThreadSettings;
  /** Set for a thread that exists, whose engine is settled; a draft may still pick either. */
  locked: boolean;
  onNewWith?: (engine: AgentEngine) => void;
  onClose: () => void;
  onPolicy: (policy: ExecutionPolicy) => void;
  onModel: (engine: AgentEngine, model: AgentModel) => void;
  onFastMode: (fastMode: boolean) => void;
  onEffort: (engine: AgentEngine, effort: AgentEffort) => void;
}) {
  const [settings, choose] = usePending(given);
  const efforts = (settings.coordinating ? coordinatorEffortsOf : effortsOf)[settings.model];
  return (
    <Sheet title="Settings" label="Thread settings" onClose={onClose}>
      <Group heading="Mode" choices={MODES} value={settings.policy} onChange={(policy) => { choose({ policy }); onPolicy(policy); }} />
      <ModelGroup engine={settings.engine} model={settings.model} locked={locked} onNewWith={onNewWith} onModel={(engine, model) => { choose({ engine, model }); onModel(engine, model); }} />
      {efforts.length > 0 && <Group heading="Effort" choices={efforts} value={effortForModel(settings.model, settings.effort, settings.coordinating ? "coordinator" : undefined)} onChange={(effort) => { choose({ effort }); onEffort(settings.engine, effort); }} />}
      {capabilitiesFor(settings.engine).fastMode && <button type="button" className="sheet-option fast-mode-switch" role="switch" aria-label="Fast mode" aria-checked={settings.fastMode ?? false} onClick={() => { const fastMode = !settings.fastMode; choose({ fastMode }); onFastMode(fastMode); }}>
        <Zap size={20} aria-hidden="true" />
        <span><strong>Fast mode</strong><small>Faster responses · uses more of your plan</small></span>
        <span className="switch-track" aria-hidden="true" />
      </button>}
    </Sheet>
  );
}
