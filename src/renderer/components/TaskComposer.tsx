import type { ExecutionPolicy } from "../../domain/run";

const modes: { value: ExecutionPolicy; label: string; description: string; glyph: string }[] = [
  { value: "confirm", label: "Ask for approval", description: "Ask before using tools or changing files", glyph: "✋" },
  { value: "plan", label: "Plan mode", description: "Plan the work without making changes", glyph: "◇" },
  { value: "allow-edits", label: "Accept edits", description: "Apply file edits without asking", glyph: "✓" },
  { value: "autonomous", label: "Approve for me", description: "Only ask for potentially unsafe actions", glyph: "⌁" },
];

export type TaskComposerProps = {
  prompt: string;
  folder: string;
  mode: ExecutionPolicy;
  runActive: boolean;
  onPromptChange: (prompt: string) => void;
  onModeChange: (mode: ExecutionPolicy) => void;
  onSend: () => void;
  onCancel: () => void;
};

export function TaskComposer({
  prompt,
  folder,
  mode,
  runActive,
  onPromptChange,
  onModeChange,
  onSend,
  onCancel,
}: TaskComposerProps) {
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
          <details className="permission-menu">
            <summary aria-label="Permission mode">
              <span className="permission-summary-icon" aria-hidden="true">{modes.find((item) => item.value === mode)?.glyph}</span>
              {modes.find((item) => item.value === mode)?.label}
            </summary>
            <div className="permission-popover">
              <div className="permission-heading">How should Claude actions be approved?</div>
              {modes.map((item) => (
                <button
                  className={`permission-option ${item.value === "autonomous" ? "elevated" : ""}`}
                  key={item.value}
                  onClick={(event) => {
                    onModeChange(item.value);
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}
                >
                  <span className="permission-icon" aria-hidden="true">{item.glyph}</span>
                  <span><strong>{item.label}</strong><small>{item.description}</small></span>
                  <span className="permission-check" aria-hidden="true">{item.value === mode ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          </details>
          <div className="composer-actions">
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
