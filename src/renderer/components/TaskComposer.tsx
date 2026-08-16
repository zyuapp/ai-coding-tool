import type { ExecutionPolicy } from "../../domain/run";

function modeLabel(mode: ExecutionPolicy) {
  return {
    confirm: "Manual",
    plan: "Plan",
    "allow-edits": "Accept edits",
    autonomous: "Auto",
  }[mode];
}

export type TaskComposerProps = {
  prompt: string;
  folder: string;
  mode: ExecutionPolicy;
  status: "idle" | "running" | "stopped";
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
  status,
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
          <select value={mode} onChange={(event) => onModeChange(event.target.value as ExecutionPolicy)} aria-label="Permission mode">
            {(["confirm", "plan", "allow-edits", "autonomous"] as ExecutionPolicy[]).map((item) => (
              <option value={item} key={item}>{modeLabel(item)}</option>
            ))}
          </select>
          <div className="composer-actions">
            {status === "running" && runActive && (
              <button className="stop-button" onClick={onCancel}>Stop</button>
            )}
            <button className="send-button" disabled={!prompt.trim() || runActive} onClick={onSend} aria-label="Send task">
              ↑
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
