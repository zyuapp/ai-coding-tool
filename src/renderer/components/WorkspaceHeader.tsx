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
};

export function WorkspaceHeader({ currentTask, folder }: WorkspaceHeaderProps) {
  return (
    <header className="topbar">
      <div className="task-heading">
        <span className="heading-folder"><FolderIcon /></span>
        <div>
          <h1>{currentTask?.title ?? "New task"}</h1>
          <p title={folder}>{folder || "Choose a project folder to begin"}</p>
        </div>
      </div>
    </header>
  );
}
