import { memo } from "react";
import { Radio, Square, Terminal } from "lucide-react";
import type { BackgroundProcess } from "../../domain/run";

export function processLabel(process: BackgroundProcess) {
  if (process.stopping) return "Stopping";
  return process.kind === "shell" ? "Shell" : "Monitor";
}

export const BackgroundProcessRow = memo(function BackgroundProcessRow({ process, onStop }: { process: BackgroundProcess; onStop: (processId: string) => void }) {
  return (
    <div className="process-row">
      <span className="agent-orb">{process.kind === "shell" ? <Terminal size={15} /> : <Radio size={15} />}</span>
      <span><strong>{process.description}</strong><small>{processLabel(process)}</small></span>
      <button
        className="process-stop"
        type="button"
        disabled={process.stopping}
        onClick={() => onStop(process.id)}
        aria-label={`Stop ${process.description}`}
      >
        <Square size={12} />
      </button>
    </div>
  );
});

/** The processes the live run left running. They end with the run, so nothing here outlives it. */
export function BackgroundProcessSection({ processes, onStop }: { processes: BackgroundProcess[]; onStop: (processId: string) => void }) {
  return (
    <div className="subagent-section">
      <div className="subagent-heading">
        <span>Processes</span>
        {processes.length > 0 && <span>{processes.length} running</span>}
      </div>
      {processes.length === 0 ? (
        <p className="session-empty">No background processes</p>
      ) : (
        <div className="subagent-list" aria-live="polite">
          {processes.map((process) => <BackgroundProcessRow key={process.id} process={process} onStop={onStop} />)}
        </div>
      )}
    </div>
  );
}
