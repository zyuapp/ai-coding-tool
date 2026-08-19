import { AlarmClock, Bot, CheckCircle2, CircleDot, Ellipsis, FileDiff, GitBranch, House, XCircle } from "lucide-react";
import { useState } from "react";
import type { ChangedFilesResult } from "../../contracts/ipc";
import type { ThreadLocation } from "../../application/workspace-state";
import type { Subagent } from "../../domain/run";

export type SessionPanelProps = {
  environment: ChangedFilesResult | null;
  hasProject: boolean;
  /** Absent until a thread exists; a draft has nowhere to move yet. */
  location?: ThreadLocation;
  runActive: boolean;
  /** The thread's name, which its own menu can change. */
  title: string;
  openMenu: string | null;
  subagents: Subagent[];
  automationCount: number;
  onSelect: (id: string) => void;
  onOpenAutomations: () => void;
  onSetOpenMenu: (menu: string | null) => void;
  onRename: (title: string) => void;
  onSetWorktree: (worktree: boolean) => void;
  onDeleteWorktree: () => void;
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
  & Pick<SessionPanelProps, "runActive" | "title" | "openMenu" | "onSetOpenMenu" | "onRename" | "onSetWorktree" | "onDeleteWorktree">;

/** One entry: it says where the thread works, and its menu carries what can be done to the thread. */
function LocationRow({ location, runActive, title, openMenu, onSetOpenMenu, onRename, onSetWorktree, onDeleteWorktree }: LocationRowProps) {
  const [renaming, setRenaming] = useState(false);
  const inWorktree = location.kind === "worktree";
  /** A thread that has asked for a checkout has not moved yet; the next message is what moves it. */
  const leaving = location.kind === "pending";
  const open = openMenu === LOCATION_MENU;

  function commit(value: string) {
    if (value.trim()) onRename(value);
    setRenaming(false);
  }

  return (
    <div className="session-location">
      <div
        className={`session-row session-location-row ${open ? "open" : ""}`}
        data-popover-menu
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onSetOpenMenu(null);
        }}
      >
        <span className="session-row-icon">{inWorktree || leaving ? <GitBranch size={18} /> : <House size={18} />}</span>
        {renaming
          ? <input
              className="session-rename"
              aria-label="Rename thread"
              autoFocus
              defaultValue={title}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit(event.currentTarget.value);
                else if (event.key === "Escape") setRenaming(false);
              }}
              onBlur={(event) => commit(event.currentTarget.value)}
            />
          : <span title={inWorktree ? location.worktree.root : leaving ? "A checkout of its own is made when you send the next message" : "Runs in your project checkout"}>
              {inWorktree ? "Worktree" : leaving ? "Worktree on next message" : "Local"}
            </span>}
        <button
          className="menu-trigger"
          type="button"
          aria-label="Thread options"
          aria-expanded={open}
          onClick={() => onSetOpenMenu(open ? null : LOCATION_MENU)}
        >
          <Ellipsis size={16} />
        </button>
        {open && <div className="menu-popover session-menu-popover" role="menu">
          <button role="menuitem" disabled={runActive} onClick={() => {
            onSetOpenMenu(null);
            onSetWorktree(!(inWorktree || leaving));
          }}>{inWorktree ? "Return to local" : leaving ? "Stay local" : "Hand off to worktree"}</button>
          <button role="menuitem" onClick={() => {
            onSetOpenMenu(null);
            setRenaming(true);
          }}>Rename thread</button>
          {inWorktree && <button className="danger-menu-item" role="menuitem" disabled={runActive} onClick={() => {
            onSetOpenMenu(null);
            onDeleteWorktree();
          }}>Delete worktree</button>}
        </div>}
      </div>
    </div>
  );
}

export function SessionPanel({ environment, hasProject, location, runActive, title, openMenu, subagents, automationCount, onSelect, onOpenAutomations, onSetOpenMenu, onRename, onSetWorktree, onDeleteWorktree }: SessionPanelProps) {
  const available = environment?.status === "available" ? environment : null;
  const working = subagents.filter((subagent) => subagent.status === "working").length;

  return (
    <aside className="session-panel" aria-label="Session panel">
      <div className="session-card">
        <h2 className="session-title">Session</h2>
            <div className="session-environment">
              {location && hasProject && <LocationRow location={location} runActive={runActive} title={title} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onRename={onRename} onSetWorktree={onSetWorktree} onDeleteWorktree={onDeleteWorktree} />}
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
