import { Bot, CheckCircle2, CircleDot, FileDiff, GitBranch, XCircle } from "lucide-react";
import type { ChangedFilesResult } from "../../contracts/ipc";
import type { Subagent } from "../../domain/run";

export type SessionPanelProps = {
  environment: ChangedFilesResult | null;
  hasProject: boolean;
  subagents: Subagent[];
  onSelect: (id: string) => void;
};

function statusLabel(status: Subagent["status"]) {
  return status === "working" ? "Working" : status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Stopped";
}

function StatusIcon({ status }: { status: Subagent["status"] }) {
  if (status === "working") return <CircleDot className="agent-working-icon" size={16} />;
  if (status === "completed") return <CheckCircle2 size={16} />;
  return <XCircle size={16} />;
}

function environmentMessage(environment: ChangedFilesResult | null, hasProject: boolean) {
  if (!hasProject) return "Open a project to inspect Git";
  if (!environment) return "Reopen the project to inspect Git";
  if (environment.status === "error") return environment.message;
  if (environment.status === "unknown") return "Workspace is no longer registered";
  if (environment.status === "unavailable") return `Workspace is ${environment.reason}`;
  return null;
}

export function SessionPanel({ environment, hasProject, subagents, onSelect }: SessionPanelProps) {
  const available = environment?.status === "available" ? environment : null;
  const working = subagents.filter((subagent) => subagent.status === "working").length;

  return (
    <aside className="session-panel" aria-label="Session panel">
      <div className="session-card">
        <h2 className="session-title">Session</h2>
            <div className="session-environment">
              <div className="session-row">
                <span className="session-row-icon"><FileDiff size={18} /></span>
                <span>Changes</span>
                <span className="change-counts">
                  {available ? <><strong>+{available.additions}</strong><em>−{available.deletions}</em></> : "—"}
                </span>
              </div>
              <div className="session-row">
                <span className="session-row-icon"><GitBranch size={18} /></span>
                <span>Branch</span>
                <code title={available?.branch ?? undefined}>{available?.branch ?? "—"}</code>
              </div>
              {environmentMessage(environment, hasProject) && <p className="session-note">{environmentMessage(environment, hasProject)}</p>}
            </div>

            <div className="subagent-section">
              <div className="subagent-heading">
                <span>Subagents</span>
                {working > 0 && <span>{working} working</span>}
              </div>
              {subagents.length === 0 ? (
                <p className="session-empty">No subagents this session</p>
              ) : (
                <div className="subagent-list" aria-live="polite">
                  {subagents.map((subagent) => (
                    <button key={subagent.id} onClick={() => onSelect(subagent.id)} aria-label={`Open ${subagent.description} details`}>
                      <span className={`agent-orb ${subagent.status}`}><Bot size={15} /></span>
                      <span><strong>{subagent.description}</strong><small>{subagent.lastToolName ? `Using ${subagent.lastToolName}` : statusLabel(subagent.status)}</small></span>
                      <StatusIcon status={subagent.status} />
                    </button>
                  ))}
                </div>
              )}
            </div>
      </div>
    </aside>
  );
}
