import { AlarmClock, Bot, CheckCircle2, CircleDot, FileDiff, GitBranch, House, XCircle } from "lucide-react";
import type { ChangedFilesResult } from "../../contracts/ipc";
import type { ThreadLocation } from "../../application/workspace-state";
import type { Subagent } from "../../domain/run";
import { PopoverMenu } from "./PopoverMenu";

export type SessionPanelProps = {
  environment: ChangedFilesResult | null;
  hasProject: boolean;
  /** Absent until a thread exists; a draft has nowhere to move yet. */
  location?: ThreadLocation;
  runActive: boolean;
  openMenu: string | null;
  subagents: Subagent[];
  automationCount: number;
  onSelect: (id: string) => void;
  onOpenAutomations: () => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSetWorktree: (worktree: boolean) => void;
};

export const LOCATION_MENU = "session:location";

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

type LocationRowProps = Required<Pick<SessionPanelProps, "location">>
  & Pick<SessionPanelProps, "runActive" | "openMenu" | "onSetOpenMenu" | "onSetWorktree">;

/** One entry: it says where the thread works, and its menu carries the only move it has. */
function LocationRow({ location, runActive, openMenu, onSetOpenMenu, onSetWorktree }: LocationRowProps) {
  const inWorktree = location.kind === "worktree";

  return (
    <div className="session-location">
      <PopoverMenu
        id={LOCATION_MENU}
        openMenu={openMenu}
        onSetOpenMenu={onSetOpenMenu}
        label="Thread options"
        className="session-row session-location-row"
        popoverClassName="session-menu-popover"
        items={[{
          label: inWorktree ? "Return to local" : "Hand off to worktree",
          disabled: runActive,
          onSelect: () => onSetWorktree(!inWorktree),
        }]}
      >
        <span className="session-row-icon">{inWorktree ? <GitBranch size={18} /> : <House size={18} />}</span>
        <span title={inWorktree ? location.worktree.root : "Runs in your project checkout"}>{inWorktree ? "Worktree" : "Local"}</span>
      </PopoverMenu>
    </div>
  );
}

export function SessionPanel({ environment, hasProject, location, runActive, openMenu, subagents, automationCount, onSelect, onOpenAutomations, onSetOpenMenu, onSetWorktree }: SessionPanelProps) {
  const available = environment?.status === "available" ? environment : null;
  const working = subagents.filter((subagent) => subagent.status === "working").length;

  return (
    <aside className="session-panel" aria-label="Session panel">
      <div className="session-card">
        <h2 className="session-title">Session</h2>
            <div className="session-environment">
              {location && hasProject && <LocationRow location={location} runActive={runActive} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onSetWorktree={onSetWorktree} />}
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
