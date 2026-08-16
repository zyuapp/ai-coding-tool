import { Bot, CheckCircle2, CircleDot, Wrench, X, XCircle } from "lucide-react";
import type { Subagent } from "../../domain/run";

function statusLabel(status: Subagent["status"]) {
  return status === "working" ? "Working" : status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Stopped";
}

function StatusIcon({ status }: { status: Subagent["status"] }) {
  if (status === "working") return <CircleDot className="agent-working-icon" size={16} />;
  if (status === "completed") return <CheckCircle2 size={16} />;
  return <XCircle size={16} />;
}

export function SubagentInspector({ subagent, onClose }: { subagent: Subagent; onClose: () => void }) {
  return (
    <aside className="subagent-inspector" aria-label={`${subagent.description} details`}>
      <header className="inspector-header">
        <span>Subagent</span>
        <button type="button" aria-label="Close subagent details" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="inspector-scroll">
        <div className="agent-detail-heading">
          <span className={`agent-orb ${subagent.status}`}><Bot size={17} /></span>
          <div>
            <h2>{subagent.description}</h2>
            <span className={`agent-status ${subagent.status}`}><StatusIcon status={subagent.status} />{statusLabel(subagent.status)}</span>
          </div>
        </div>
        {(subagent.summary || subagent.lastToolName || subagent.totalTokens !== undefined) && (
          <div className="agent-summary">
            {subagent.summary && <p>{subagent.summary}</p>}
            <div>
              {subagent.lastToolName && <span>Last tool: {subagent.lastToolName}</span>}
              {subagent.totalTokens !== undefined && <span>{subagent.totalTokens.toLocaleString()} tokens</span>}
            </div>
          </div>
        )}
        <div className="agent-activity" aria-live="polite">
          {subagent.activity.length === 0 ? (
            <p className="session-empty">Waiting for activity…</p>
          ) : subagent.activity.map((item) => item.kind === "tool" ? (
            <details className="agent-tool" key={item.id}>
              <summary><Wrench size={14} />{item.title ?? "Tool"}</summary>
              <pre>{item.text}</pre>
            </details>
          ) : (
            <p className="agent-text" key={item.id}>{item.text}</p>
          ))}
        </div>
      </div>
    </aside>
  );
}
