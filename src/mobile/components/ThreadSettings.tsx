import { LuCheck as Check, LuChevronRight as ChevronRight, LuSquarePen as SquarePen, LuZap as Zap } from "react-icons/lu";
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
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

/** A group's one Tab stop is its chosen option, or its first when none is; the arrow keys move focus, and Space or Enter makes the choice. */
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
}

function Refused({ shown }: { shown: boolean }) {
  return shown ? <p className="sheet-refused" role="alert">Couldn't change. Try again.</p> : null;
}

function Group<T extends string>({ heading, choices, value, refused, onChange }: { heading: string; choices: readonly Choice<T>[]; value: T; refused: boolean; onChange: (value: T) => void }) {
  const known = choices.some((choice) => choice.value === value);
  return (
    <section className="sheet-group" role="radiogroup" aria-label={heading} onKeyDown={moveChoice}>
      <h3>{heading}</h3>
      {choices.map((choice, index) => <OptionButton key={choice.value} choice={choice} selected={choice.value === value} stop={known ? choice.value === value : index === 0} onSelect={() => onChange(choice.value)} />)}
      <Refused shown={refused} />
    </section>
  );
}

/**
 * A thread that already has an engine offers only that engine's models. Each other engine keeps its
 * heading in the same list, with the one way to reach its models: a new thread on it.
 */
function ModelGroup({ engine, model, locked, refused, onModel, onNewWith }: { engine: AgentEngine; model: AgentModel; locked: boolean; refused: boolean; onModel: (engine: AgentEngine, model: AgentModel) => void; onNewWith?: (engine: AgentEngine) => void }) {
  const shown = modelGroups.filter((group) => !locked || group.engine === engine);
  const known = shown.some((group) => group.engine === engine && group.choices.some((choice) => choice.value === model));
  const others = locked && onNewWith ? modelGroups.filter((group) => group.engine !== engine) : [];
  const heading = useId();
  return (
    <section className="sheet-group">
      <h3 id={heading}>Model</h3>
      <div role="radiogroup" aria-labelledby={heading} onKeyDown={moveChoice}>
        {shown.map((group, groupIndex) => (
          <Fragment key={group.engine}>
            <h4 className="sheet-subheading">{group.label}</h4>
            {group.choices.map((choice, index) => {
              const selected = group.engine === engine && choice.value === model;
              return <OptionButton key={choice.value} choice={choice} selected={selected} stop={known ? selected : groupIndex === 0 && index === 0} onSelect={() => onModel(group.engine, choice.value)} />;
            })}
          </Fragment>
        ))}
      </div>
      <Refused shown={refused} />
      {others.map((group) => (
        <Fragment key={group.engine}>
          <h4 className="sheet-subheading">{group.label}</h4>
          <button type="button" className="menu-row sheet-new-engine" onClick={() => onNewWith!(group.engine)}>
            <span className="menu-glyph" aria-hidden="true"><SquarePen size={18} strokeWidth={1.8} /></span>
            <span className="menu-copy"><strong>New thread with {group.label}</strong><small>{group.choices.map((choice) => choice.label).join(" · ")}</small></span>
            <ChevronRight className="menu-chevron" size={16} aria-hidden="true" />
          </button>
        </Fragment>
      ))}
    </section>
  );
}

/** How long a tapped choice shows as made while a live line has yet to echo it back. */
const PENDING_MS = 4000;

type Pending = Partial<Pick<MobileThreadSettings, "policy" | "engine" | "model" | "effort" | "fastMode">>;

/**
 * The choice a tap made, shown at once and let go of when the computer's settings agree with it. One
 * a live line leaves unechoed goes back to what it really is, and its keys are returned as refused
 * until the next tap. While the line is down the choice waits with the command that carries it.
 */
function usePending(settings: MobileThreadSettings, live: boolean) {
  const [pending, setPending] = useState<Pending>({});
  const [refused, setRefused] = useState<ReadonlySet<keyof Pending>>(new Set());
  const latest = useRef(settings);
  latest.current = settings;
  const echoed = (Object.keys(pending) as (keyof Pending)[]).every((key) => settings[key] === pending[key]);
  useEffect(() => {
    const keys = Object.keys(pending) as (keyof Pending)[];
    if (!keys.length) return;
    if (echoed) { setPending({}); return; }
    if (!live) return;
    const timer = setTimeout(() => {
      setRefused(new Set(keys.filter((key) => latest.current[key] !== pending[key])));
      setPending({});
    }, PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending, echoed, live]);
  const choose = (next: Pending) => {
    setRefused(new Set());
    setPending((current) => ({ ...current, ...next }));
  };
  return [{ ...settings, ...pending }, choose, refused] as const;
}

export function ThreadSettings({ settings: given, live, locked, onNewWith, onClose, onPolicy, onModel, onEffort, onFastMode }: {
  settings: MobileThreadSettings;
  /** Whether the line to the computer is up, so a choice it has yet to echo can be told from one it turned down. */
  live: boolean;
  /** Set for a thread that exists, whose engine is settled; a draft may still pick either. */
  locked: boolean;
  onNewWith?: (engine: AgentEngine) => void;
  onClose: () => void;
  onPolicy: (policy: ExecutionPolicy) => void;
  onModel: (engine: AgentEngine, model: AgentModel) => void;
  onFastMode: (fastMode: boolean) => void;
  onEffort: (engine: AgentEngine, effort: AgentEffort) => void;
}) {
  const [settings, choose, refused] = usePending(given, live);
  const fastNote = useId();
  const efforts = (settings.coordinating ? coordinatorEffortsOf : effortsOf)[settings.model];
  return (
    <Sheet title="Settings" label="Thread settings" onClose={onClose}>
      <Group heading="Mode" choices={MODES} value={settings.policy} refused={refused.has("policy")} onChange={(policy) => { choose({ policy }); onPolicy(policy); }} />
      <ModelGroup engine={settings.engine} model={settings.model} locked={locked} refused={refused.has("model") || refused.has("engine")} onNewWith={onNewWith} onModel={(engine, model) => { choose({ engine, model }); onModel(engine, model); }} />
      {efforts.length > 0 && <Group heading="Effort" choices={efforts} value={effortForModel(settings.model, settings.effort, settings.coordinating ? "coordinator" : undefined)} refused={refused.has("effort")} onChange={(effort) => { choose({ effort }); onEffort(settings.engine, effort); }} />}
      {capabilitiesFor(settings.engine).fastMode && <button type="button" className="sheet-option fast-mode-switch" role="switch" aria-label="Fast mode" aria-describedby={fastNote} aria-checked={settings.fastMode ?? false} onClick={() => { const fastMode = !settings.fastMode; choose({ fastMode }); onFastMode(fastMode); }}>
        <Zap size={20} aria-hidden="true" />
        <span><strong>Fast mode</strong><small id={fastNote}>Faster responses · uses more of your plan</small></span>
        <span className="switch-track" aria-hidden="true" />
      </button>}
      {capabilitiesFor(settings.engine).fastMode && <Refused shown={refused.has("fastMode")} />}
    </Sheet>
  );
}
