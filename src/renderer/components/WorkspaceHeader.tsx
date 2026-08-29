import { LuPanelLeft as PanelLeft, LuPanelRight as PanelRight, LuSlidersHorizontal as SlidersHorizontal } from "react-icons/lu";
import type { Thread } from "../../domain/thread";
import { OpenInMenu } from "./OpenInMenu";

export type WorkspaceHeaderProps = {
  currentTask?: Thread;
  folder: string;
  /** What the folder is called, which is the project's name rather than the directory's. */
  folderLabel: string;
  sidebarOpen: boolean;
  sessionPanelOpen: boolean;
  rightDockOpen: boolean;
  workingSubagents: number;
  openMenu: string | null;
  /** False while the thread has no checkout to hand over, such as a worktree still being made. */
  canOpenFolder: boolean;
  onSetOpenMenu: (menu: string | null) => void;
  onOpenInApp: (appId: string) => void;
  onToggleSidebar: () => void;
  onToggleSessionPanel: () => void;
  onToggleRightDock: () => void;
};

export function WorkspaceHeader({ currentTask, folder, folderLabel, sidebarOpen, sessionPanelOpen, rightDockOpen, workingSubagents, openMenu, canOpenFolder, onSetOpenMenu, onOpenInApp, onToggleSidebar, onToggleSessionPanel, onToggleRightDock }: WorkspaceHeaderProps) {
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
        <div>
          <h1 title={folder || undefined}>
            {folder && <>
              <span className="heading-project">{folderLabel}</span>
              <span className="heading-separator" aria-hidden="true">/</span>
            </>}
            <span className="heading-thread">{currentTask?.title ?? "New task"}</span>
          </h1>
          {!folder && <p>Choose a project folder to begin</p>}
        </div>
      </div>
      <div className="workspace-controls">
        <OpenInMenu openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} enabled={canOpenFolder} onOpenInApp={onOpenInApp} />
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
