import { PanelLeft, PanelRight, SlidersHorizontal } from "lucide-react";
import { projectName } from "../../domain/task";
import type { Task } from "../../domain/task";

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5h6l2-2h3.8c1.8 0 2.7 0 3.4.35.62.32 1.13.83 1.45 1.45.35.7.35 1.6.35 3.4v4.4c0 1.8 0 2.7-.35 3.4a3.25 3.25 0 0 1-1.45 1.45c-.7.35-1.6.35-3.4.35H7.5c-1.8 0-2.7 0-3.4-.35a3.25 3.25 0 0 1-1.45-1.45c-.35-.7-.35-1.6-.35-3.4V9.2c0-.95 0-1.42.18-1.78.16-.32.42-.58.74-.74.36-.18.83-.18 1.78-.18Z" />
    </svg>
  );
}

export type WorkspaceHeaderProps = {
  currentTask?: Task;
  folder: string;
  sidebarOpen: boolean;
  sessionPanelOpen: boolean;
  rightDockOpen: boolean;
  workingSubagents: number;
  onToggleSidebar: () => void;
  onToggleSessionPanel: () => void;
  onToggleRightDock: () => void;
};

export function WorkspaceHeader({ currentTask, folder, sidebarOpen, sessionPanelOpen, rightDockOpen, workingSubagents, onToggleSidebar, onToggleSessionPanel, onToggleRightDock }: WorkspaceHeaderProps) {
  return (
    <header className={`topbar ${sidebarOpen ? "" : "traffic-inset"}`.trimEnd()}>
      <div className="task-heading">
        <button
          className={`session-toggle sidebar-toggle ${sidebarOpen ? "active" : ""}`}
          type="button"
          aria-label={`${sidebarOpen ? "Hide" : "Show"} sidebar`}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <PanelLeft size={19} aria-hidden="true" />
        </button>
        <span className="heading-folder"><FolderIcon /></span>
        <div>
          <h1 title={folder || undefined}>
            {folder && <>
              <span className="heading-project">{projectName(folder)}</span>
              <span className="heading-separator" aria-hidden="true">/</span>
            </>}
            <span className="heading-thread">{currentTask?.title ?? "New task"}</span>
          </h1>
          {!folder && <p>Choose a project folder to begin</p>}
        </div>
      </div>
      <div className="workspace-controls">
        <button
          className={`session-toggle ${sessionPanelOpen ? "active" : ""}`}
          type="button"
          aria-label={`${sessionPanelOpen ? "Hide" : "Show"} session summary`}
          aria-pressed={sessionPanelOpen}
          onClick={onToggleSessionPanel}
        >
          <SlidersHorizontal size={19} aria-hidden="true" />
          {workingSubagents > 0 && <span>{workingSubagents}</span>}
        </button>
        <button
          className={`session-toggle ${rightDockOpen ? "active" : ""}`}
          type="button"
          aria-label={`${rightDockOpen ? "Hide" : "Show"} right panel`}
          aria-pressed={rightDockOpen}
          onClick={onToggleRightDock}
        >
          <PanelRight size={19} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
