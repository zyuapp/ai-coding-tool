import { AlarmClock, Bot, CheckCircle2, CircleDot, FileDiff, GitBranch, House, Trash2, XCircle } from "lucide-react";
import type { ChangedFilesResult } from "../../contracts/ipc";
import type { ThreadLocation } from "../../application/workspace-state";
import type { Subagent } from "../../domain/run";

export type SessionPanelProps = {
  environment: ChangedFilesResult | null;
  hasProject: boolean;
  /** Absent until a thread exists; a draft has nowhere to move yet. */
  location?: ThreadLocation;
  runActive: boolean;
  subagents: Subagent[];
  automationCount: number;
  onSelect: (id: string) => void;
  onOpenAutomations: () => void;
  onSetWorktree: (worktree: boolean) => void;
  onDeleteWorktree: () => void;
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

/** One entry, like the rows around it: it says where the thread works, and clicking it moves it. */
function LocationRow({ location, runActive, onSetWorktree, onDeleteWorktree }: Required<Pick<SessionPanelProps, "location">> & Pick<SessionPanelProps, "runActive" | "onSetWorktree" | "onDeleteWorktree">) {
  const inWorktree = location.kind === "worktree";
  return (
    <div className="session-location">
      <button
        className="session-row session-row-action"
        type="button"
        disabled={runActive}
        title={inWorktree ? location.worktree.root : "Runs in your project checkout"}
        aria-label={inWorktree ? "Return this thread to the project checkout" : "Give this thread a worktree"}
        onClick={() => onSetWorktree(!inWorktree)}
      >
        <span className="session-row-icon">{inWorktree ? <GitBranch size={18} /> : <House size={18} />}</span>
        <span>{inWorktree ? "Worktree" : "Local"}</span>
        {inWorktree && (
          <span
            className="session-worktree-delete"
            role="button"
            tabIndex={0}
            aria-label="Delete worktree"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteWorktree();
            }}
          >
            <Trash2 size={14} />
          </span>
        )}
      </button>
    </div>
  );
}

export function SessionPanel({ environment, hasProject, location, runActive, subagents, automationCount, onSelect, onOpenAutomations, onSetWorktree, onDeleteWorktree }: SessionPanelProps) {
  const available = environment?.status === "available" ? environment : null;
  const working = subagents.filter((subagent) => subagent.status === "working").length;

  return (
    <aside className="session-panel" aria-label="Session panel">
      <div className="session-card">
        <h2 className="session-title">Session</h2>
            <div className="session-environment">
              {location && hasProject && <LocationRow location={location} runActive={runActive} onSetWorktree={onSetWorktree} onDeleteWorktree={onDeleteWorktree} />}
              <div className="session-row">
                <span className="session-row-icon"><FileDiff size={18} /></span>
                <span>Changes</span>
                {available && <span className="change-counts"><strong>+{available.additions}</strong><em>−{available.deletions}</em></span>}
              </div>
              <div className="session-row">
                <span className="session-row-icon"><GitBranch size={18} /></span>
                <span>Branch</span>
                {available?.branch && <code title={available.branch}>{available.branch}</code>}
              </div>
              {environmentMessage(environment, hasProject) && <p className="session-note">{environmentMessage(environment, hasProject)}</p>}
              <button className="session-row session-row-action" type="button" onClick={onOpenAutomations} aria-label="Open Automation panel">
                <span className="session-row-icon"><AlarmClock size={18} /></span>
                <span>Automations</span>
                <span className="session-count">{automationCount}</span>
              </button>
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

export function AgentsPanel({ subagents, onSelect }: Pick<SessionPanelProps, "subagents" | "onSelect">) {
  const working = subagents.filter((subagent) => subagent.status === "working").length;

  return (
    <section className="agents-panel" aria-label="Agents">
      <header className="agents-panel-heading">
        <div><h2>Subagents</h2><p>Work delegated from this task</p></div>
        {working > 0 && <span>{working} working</span>}
      </header>
      {subagents.length === 0 ? (
        <div className="agents-panel-empty">
          <span className="agent-orb"><Bot size={17} /></span>
          <h2>No subagents yet</h2>
          <p>Subagents created by the main task will appear here.</p>
        </div>
      ) : (
        <div className="subagent-list agents-panel-list" aria-live="polite">
          {subagents.map((subagent) => (
            <button key={subagent.id} onClick={() => onSelect(subagent.id)} aria-label={`Open ${subagent.description} details`}>
              <span className={`agent-orb ${subagent.status}`}><Bot size={15} /></span>
              <span><strong>{subagent.description}</strong><small>{subagent.lastToolName ? `Using ${subagent.lastToolName}` : statusLabel(subagent.status)}</small></span>
              <StatusIcon status={subagent.status} />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
