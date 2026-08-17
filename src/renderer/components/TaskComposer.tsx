import { Brain, Check, Command, Feather, FileCheck2, FileText, Gauge, Hand, Library, ListTodo, Sparkles, Zap, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AvailableCommand } from "../../contracts/ipc";
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

export type TaskComposerProps = {
  prompt: string;
  folder: string;
  workspaceId?: string;
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
  workspaceId,
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandMenuRef = useRef<HTMLDivElement>(null);
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(true);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const [inputFocused, setInputFocused] = useState(false);
  const [dismissedPrompt, setDismissedPrompt] = useState<string | null>(null);
  const contextPercent = contextUsage ? Math.round(contextUsage.tokens / contextUsage.limit * 100) : 0;
  const slashQuery = prompt.match(/^\/([^\s]*)$/)?.[1].toLowerCase();
  const appCommand = { name: "side", description: "Open a focused side chat.", argumentHint: "", aliases: [] as string[], kind: "app" as const };
  const matchingCommands = slashQuery === undefined ? [] : [
    appCommand,
    ...commands.filter((command) => command.name !== "side").map((command) => ({ ...command, kind: "skill" as const })),
  ].filter((command) => command.name.toLowerCase().startsWith(slashQuery) || command.aliases?.some((alias) => alias.toLowerCase().startsWith(slashQuery)));
  const commandMenuOpen = inputFocused && slashQuery !== undefined && dismissedPrompt !== prompt;

  function shortDescription(description: string) {
    const firstSentence = description.split(/(?<=[.!?])\s/, 1)[0].replace(/\s+\([^)]*\)$/, "");
    return firstSentence.length > 110 ? `${firstSentence.slice(0, 107).trimEnd()}…` : firstSentence;
  }

  function chooseCommand(command: (typeof matchingCommands)[number]) {
    const nextPrompt = `/${command.name}${command.argumentHint ? " " : ""}`;
    onPromptChange(nextPrompt);
    setDismissedPrompt(nextPrompt);
    setInputFocused(true);
    textareaRef.current?.focus();
  }

  useEffect(() => {
    const closeOtherMenus = (event: PointerEvent) => {
      settingsRef.current?.querySelectorAll("details[open]").forEach((details) => {
        if (!details.contains(event.target as Node)) details.removeAttribute("open");
      });
    };
    document.addEventListener("pointerdown", closeOtherMenus);
    return () => document.removeEventListener("pointerdown", closeOtherMenus);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCommandsLoading(true);
    void (async () => {
      try {
        const id = workspaceId ?? (await window.desktop.projectlessWorkspace()).id;
        const result = await window.desktop.commands(id);
        if (!cancelled) setCommands(result.status === "available" ? result.commands : []);
      } catch {
        if (!cancelled) setCommands([]);
      } finally {
        if (!cancelled) setCommandsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => setSelectedCommand(0), [prompt, commands]);

  useEffect(() => {
    if (!commandMenuOpen) return;
    commandMenuRef.current?.querySelector(`#slash-command-${selectedCommand}`)?.scrollIntoView?.({ block: "nearest" });
  }, [commandMenuOpen, selectedCommand]);

  return (
    <footer className="composer-wrap">
      <div className="composer">
        {commandMenuOpen && (
          <div className="command-menu" ref={commandMenuRef} id="slash-command-menu" role="listbox" aria-label="Slash commands">
            <div className="command-menu-heading"><Command size={14} aria-hidden="true" /><span>Commands</span><kbd>↑↓</kbd></div>
            <div className="command-menu-list">
              {matchingCommands.map((command, index) => (
                <button
                  type="button"
                  id={`slash-command-${index}`}
                  key={`${command.kind}:${command.name}`}
                  className={`command-option ${index === selectedCommand ? "selected" : ""}`}
                  role="option"
                  aria-selected={index === selectedCommand}
                  onMouseEnter={() => setSelectedCommand(index)}
                  onClick={() => chooseCommand(command)}
                >
                  <span className={`command-mark ${command.kind}`} aria-hidden="true">{command.kind === "app" ? <Command size={16} /> : <Sparkles size={15} />}</span>
                  <span className="command-copy"><strong>/{command.name}{command.argumentHint && <em> {command.argumentHint}</em>}</strong><small>{shortDescription(command.description)}</small></span>
                  <span className="command-source">{command.kind === "app" ? "Claudex" : "Skill"}</span>
                </button>
              ))}
              {matchingCommands.length === 0 && <p className="command-empty">No matching commands</p>}
            </div>
            {commandsLoading && <div className="command-menu-status">Loading installed skills…</div>}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={prompt}
          onInput={(event) => {
            onPromptChange(event.currentTarget.value);
            setDismissedPrompt(null);
          }}
          onFocus={() => setInputFocused(true)}
          onBlur={(event) => {
            if (!commandMenuRef.current?.contains(event.relatedTarget as Node)) setInputFocused(false);
          }}
          onKeyDown={(event) => {
            if (commandMenuOpen && matchingCommands.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setSelectedCommand((current) => (current + (event.key === "ArrowDown" ? 1 : matchingCommands.length - 1)) % matchingCommands.length);
              return;
            }
            if (commandMenuOpen && event.key === "Escape") {
              event.preventDefault();
              setDismissedPrompt(prompt);
              return;
            }
            if (commandMenuOpen && matchingCommands[selectedCommand] && (event.key === "Enter" || event.key === "Tab")) {
              event.preventDefault();
              chooseCommand(matchingCommands[selectedCommand]);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={folder ? "Ask Claude to work on anything" : "Ask Claude anything"}
          aria-label="Task prompt"
          aria-autocomplete="list"
          aria-controls={commandMenuOpen ? "slash-command-menu" : undefined}
          aria-expanded={commandMenuOpen}
          aria-activedescendant={commandMenuOpen && matchingCommands[selectedCommand] ? `slash-command-${selectedCommand}` : undefined}
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
