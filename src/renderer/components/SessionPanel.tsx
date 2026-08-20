import { AlarmClock, FileDiff, GitBranch, House } from "lucide-react";
import type { ChangedFilesResult } from "../../contracts/ipc";
import type { ThreadLocation } from "../../application/workspace-state";
import type { BackgroundProcess, Subagent } from "../../domain/run";
import type { Workflow } from "../../domain/workflow";
import { BackgroundProcessSection } from "./BackgroundProcessList";
import { PopoverMenu } from "./PopoverMenu";
import { orderSubagents, SubagentRow } from "./SubagentList";

export type SessionPanelProps = {
  environment: ChangedFilesResult | null;
  hasProject: boolean;
  /** Absent until a thread exists; a draft has nowhere to move yet. */
  location?: ThreadLocation;
  runActive: boolean;
  openMenu: string | null;
  subagents: Subagent[];
  backgroundProcesses: BackgroundProcess[];
  workflows: Workflow[];
  automationCount: number;
  onSelect: (id: string) => void;
  onOpenAgents: () => void;
  onOpenAutomations: () => void;
  onOpenWorkflow: (id: string) => void;
  onStopProcess: (processId: string) => void;
  onSetOpenMenu: (menu: string | null) => void;
  onSetWorktree: (worktree: boolean) => void;
};

export const LOCATION_MENU = "session:location";

/** The sidebar carries the few that want reading; the whole roster lives in the Subagents panel. */
const SIDEBAR_LIMIT = 6;

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

export function SessionPanel({ environment, hasProject, location, runActive, openMenu, subagents, backgroundProcesses, workflows, automationCount, onSelect, onOpenAgents, onOpenAutomations, onOpenWorkflow, onSetOpenMenu, onSetWorktree, onStopProcess }: SessionPanelProps) {
  const available = environment?.status === "available" ? environment : null;
  const working = subagents.filter((subagent) => subagent.status === "working").length;
  const shown = orderSubagents(subagents).slice(0, SIDEBAR_LIMIT);

  return (
    <aside className="session-panel" aria-label="Session panel">
      <div className="session-card">
        <h2 className="session-title">Session</h2>
            <div className="session-environment">
              {location && hasProject && <LocationRow location={location} runActive={runActive} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} onSetWorktree={onSetWorktree} />}
              <div className="session-row">
                <span className="session-row-icon"><FileDiff size={18} /></span>
                <span>Changes</span>
                {available && (
                  <span className="change-counts" title={available.baseline ? `Since ${available.baseline}` : "Uncommitted work"}>
                    <strong>+{available.additions}</strong><em>−{available.deletions}</em>
                  </span>
                )}
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
                  {shown.map((subagent) => <SubagentRow key={subagent.id} subagent={subagent} onSelect={onSelect} />)}
                  {subagents.length > shown.length && (
                    <button className="subagent-view-all" type="button" onClick={onOpenAgents}>View All</button>
                  )}
                </div>
              )}
            </div>

            <BackgroundProcessSection processes={backgroundProcesses} workflows={workflows} onOpenWorkflow={onOpenWorkflow} onStop={onStopProcess} />
      </div>
    </aside>
  );
}
