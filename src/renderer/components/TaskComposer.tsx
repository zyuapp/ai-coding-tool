import { Brain, Check, Feather, FileCheck2, FileText, Gauge, Hand, Library, ListTodo, Sparkles, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type CSSProperties } from "react";
import type { AgentModel, ContextWindow, ExecutionPolicy } from "../../domain/run";
import type { ContextUsage } from "../../domain/task";

type Choice<T extends string> = { value: T; label: string; description: string; icon: LucideIcon; elevated?: boolean };

const modes: Choice<ExecutionPolicy>[] = [
  { value: "confirm", label: "Ask for approval", description: "Ask before using tools or changing files", icon: Hand },
  { value: "plan", label: "Plan mode", description: "Plan the work without making changes", icon: ListTodo },
  { value: "allow-edits", label: "Accept edits", description: "Apply file edits without asking", icon: FileCheck2 },
  { value: "autonomous", label: "Approve for me", description: "Only ask for potentially unsafe actions", icon: Zap, elevated: true },
];

const models: Choice<AgentModel>[] = [
  { value: "default", label: "Default model", description: "Use Claude's recommended model", icon: Sparkles },
  { value: "sonnet", label: "Sonnet", description: "Balanced speed and capability", icon: Gauge },
  { value: "opus", label: "Opus", description: "Best for complex reasoning", icon: Brain },
  { value: "haiku", label: "Haiku", description: "Fastest for lightweight work", icon: Feather },
];

const contextWindows: Choice<ContextWindow>[] = [
  { value: "default", label: "200K context", description: "Standard context window", icon: FileText },
  { value: "1m", label: "1M context", description: "Extended context for large tasks", icon: Library },
];

function ChoiceMenu<T extends string>({ label, heading, choices, value, onChange }: {
  label: string;
  heading: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const selected = choices.find((item) => item.value === value)!;
  const SelectedIcon = selected.icon;

  return <details className="setting-menu">
    <summary aria-label={label}>
      <span className="setting-summary-icon" aria-hidden="true"><SelectedIcon size={16} /></span>
      {selected.label}
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

export type TaskComposerProps = {
  prompt: string;
  folder: string;
  mode: ExecutionPolicy;
  model: AgentModel;
  contextWindow: ContextWindow;
  contextUsage?: ContextUsage;
  runActive: boolean;
  onPromptChange: (prompt: string) => void;
  onModeChange: (mode: ExecutionPolicy) => void;
  onModelChange: (model: AgentModel) => void;
  onContextWindowChange: (contextWindow: ContextWindow) => void;
  onSend: () => void;
  onCancel: () => void;
};

export function TaskComposer({
  prompt,
  folder,
  mode,
  model,
  contextWindow,
  contextUsage,
  runActive,
  onPromptChange,
  onModeChange,
  onModelChange,
  onContextWindowChange,
  onSend,
  onCancel,
}: TaskComposerProps) {
  const settingsRef = useRef<HTMLDivElement>(null);
  const contextPercent = contextUsage ? Math.round(contextUsage.tokens / contextUsage.limit * 100) : 0;

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
    <footer className="composer-wrap">
      <div className="composer">
        <textarea
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={folder ? "Ask Claude to work on anything" : "Ask Claude anything"}
          aria-label="Task prompt"
          rows={2}
        />
        <div className="composer-bar">
          <div className="composer-settings" ref={settingsRef}>
            <ChoiceMenu label="Permission mode" heading="How should Claude actions be approved?" choices={modes} value={mode} onChange={onModeChange} />
            <ChoiceMenu label="Model" heading="Choose a model" choices={models} value={model} onChange={onModelChange} />
            <ChoiceMenu label="Context window" heading="Choose a context window" choices={contextWindows} value={contextWindow} onChange={onContextWindowChange} />
          </div>
          <div className="composer-actions">
            {contextUsage && (
              <span className="context-usage" tabIndex={0} aria-label={`${contextPercent}% of context window used`} aria-describedby="context-usage-tooltip">
                <span className="context-usage-ring" aria-hidden="true" style={{ "--context-progress": `${Math.min(contextPercent, 100)}%` } as CSSProperties} />
                <span className="context-usage-tooltip" id="context-usage-tooltip" role="tooltip">
                  <span>Context window:</span>
                  <strong>{contextPercent}% used ({100 - contextPercent}% left)</strong>
                  <span className="context-usage-tokens">{contextUsage.tokens.toLocaleString("en-US", { notation: "compact" })} / {contextUsage.limit.toLocaleString("en-US", { notation: "compact" })} tokens used</span>
                </span>
              </span>
            )}
            <button
              className={`send-button ${runActive ? "running" : ""}`}
              disabled={!runActive && !prompt.trim()}
              onClick={runActive ? onCancel : onSend}
              aria-label={runActive ? "Stop task" : "Send task"}
            >
              {runActive ? <span className="stop-glyph" /> : "↑"}
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
