import { Brain, Check, ClipboardList, Feather, FileCheck2, Flame, Gauge, GitBranch, Hand, House, Signal, SignalHigh, SignalLow, SignalMedium, Sparkles, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { AgentEffort, AgentModel, ExecutionPolicy } from "../../domain/run";

type Choice<T extends string> = { value: T; label: string; description: string; icon: LucideIcon; elevated?: boolean };

const modes: Choice<ExecutionPolicy>[] = [
  { value: "autonomous", label: "Auto mode", description: "Only ask for potentially unsafe actions", icon: Zap, elevated: true },
  { value: "allow-edits", label: "Allow all edit", description: "Apply file edits without asking", icon: FileCheck2 },
  { value: "plan", label: "Plan mode", description: "Read and plan without changing files", icon: ClipboardList },
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

  return <details className="setting-menu">
    <summary aria-label={label}>
      <span className="setting-summary-icon" aria-hidden="true"><SelectedIcon size={16} /></span>
      <span className="setting-summary-label">{selected.label}</span>
    </summary>
    <div className="setting-popover">
      <div className="setting-heading">{heading}</div>
      {choices.map((item) => {
        const Icon = item.icon;
        return <button
          className={`setting-option ${item.elevated ? "elevated" : ""}`}
          key={item.value}
          onClick={(event) => {
            onChange(item.value);
            event.currentTarget.closest("details")?.removeAttribute("open");
          }}
        >
          <span className="setting-icon" aria-hidden="true"><Icon size={20} /></span>
          <span><strong>{item.label}</strong><small>{item.description}</small></span>
          <span className="setting-check" aria-hidden="true">{item.value === value && <Check size={20} />}</span>
        </button>;
      })}
    </div>
  </details>;
}

/** Absent where a checkout of its own makes no sense, as in a thread with no project folder. */
export type WorktreeChoice = { on: boolean; onChange: (worktree: boolean) => void };

export function ComposerSettings({ mode, model, effort, worktree, onModeChange, onModelChange, onEffortChange }: {
  mode: ExecutionPolicy;
  model: AgentModel;
  effort: AgentEffort;
  worktree?: WorktreeChoice;
  onModeChange: (mode: ExecutionPolicy) => void;
  onModelChange: (model: AgentModel) => void;
  onEffortChange: (effort: AgentEffort) => void;
}) {
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeOtherMenus = (event: PointerEvent) => {
      settingsRef.current?.querySelectorAll("details[open]").forEach((details) => {
        if (!details.contains(event.target as Node)) details.removeAttribute("open");
      });
    };
    document.addEventListener("pointerdown", closeOtherMenus);
    return () => document.removeEventListener("pointerdown", closeOtherMenus);
  }, []);

  return (
    <div className="composer-settings" ref={settingsRef}>
      <ChoiceMenu label="Permission mode" heading="How should Claude actions be approved?" choices={modes} value={mode} onChange={onModeChange} />
      <ChoiceMenu label="Model" heading="Choose a model" choices={models} value={model} onChange={onModelChange} />
      <ChoiceMenu label="Effort" heading="How hard should Claude think?" choices={efforts} value={effort} onChange={onEffortChange} />
      {worktree && (
        <button
          className={`setting-toggle ${worktree.on ? "on" : ""}`}
          type="button"
          role="switch"
          aria-checked={worktree.on}
          aria-label="Run in a worktree"
          title={worktree.on ? "Runs in a worktree of its own" : "Runs in the project checkout"}
          onClick={() => worktree.onChange(!worktree.on)}
        >
          <span className="setting-summary-icon" aria-hidden="true">{worktree.on ? <GitBranch size={16} /> : <House size={16} />}</span>
          <span className="setting-summary-label">{worktree.on ? "Worktree" : "Local"}</span>
        </button>
      )}
    </div>
  );
}
