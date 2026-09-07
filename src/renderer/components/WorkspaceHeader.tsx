import { LuPanelLeft as PanelLeft, LuPanelRight as PanelRight, LuSlidersHorizontal as SlidersHorizontal } from "react-icons/lu";
import type { Thread } from "../../domain/thread";
import { OpenInMenu } from "./OpenInMenu";
import { PopoverMenu } from "./PopoverMenu";
import { RenameInput, useRenaming } from "./SidebarRename";
import { threadMenuEntries } from "./thread-menu";

export type WorkspaceHeaderProps = {
  currentThread?: Thread;
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
  onRenameThread: (threadId: string, title: string) => void;
  onForkThread: (threadId: string, worktree: boolean) => void;
  onArchiveThread: (threadId: string) => void;
  onToggleSidebar: () => void;
  onToggleSessionPanel: () => void;
  onToggleRightDock: () => void;
};

function ThreadHeading({ currentThread, folder, folderLabel, openMenu, onSetOpenMenu, onRenameThread, onForkThread, onArchiveThread }: Pick<WorkspaceHeaderProps, "currentThread" | "folder" | "folderLabel" | "openMenu" | "onSetOpenMenu" | "onRenameThread" | "onForkThread" | "onArchiveThread">) {
  const name = useRenaming((threadId, value) => { if (value.trim()) onRenameThread(threadId, value); });
  return (
    <div className="thread-heading-line">
      <h1 title={folder || undefined}>
        {folder && <>
          <span className="heading-project">{folderLabel}</span>
          <span className="heading-separator" aria-hidden="true">/</span>
        </>}
        {currentThread && name.editing === currentThread.id
          ? <RenameInput
              inputRef={name.input}
              className="task-rename heading-rename"
              label={`Rename ${currentThread.title}`}
              value={currentThread.title}
              onCommit={(value) => name.commit(currentThread.id, value)}
              onCancel={name.cancel}
            />
          : <span className="heading-thread">{currentThread?.title ?? "New task"}</span>}
      </h1>
      {currentThread && <PopoverMenu
        id={`thread-heading:${currentThread.id}`}
        openMenu={openMenu}
        onSetOpenMenu={onSetOpenMenu}
        label="Thread actions"
        className="thread-heading-menu"
        anchored
        items={threadMenuEntries(currentThread, {
          onRename: () => name.start(currentThread.id),
          onFork: (worktree) => onForkThread(currentThread.id, worktree),
          onArchive: () => onArchiveThread(currentThread.id),
        })}
      />}
    </div>
  );
}

export function WorkspaceHeader({ currentThread, folder, folderLabel, sidebarOpen, sessionPanelOpen, rightDockOpen, workingSubagents, openMenu, canOpenFolder, onSetOpenMenu, onOpenInApp, onRenameThread, onForkThread, onArchiveThread, onToggleSidebar, onToggleSessionPanel, onToggleRightDock }: WorkspaceHeaderProps) {
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
          <ThreadHeading
            key={currentThread?.id ?? "draft"}
            currentThread={currentThread}
            folder={folder}
            folderLabel={folderLabel}
            openMenu={openMenu}
            onSetOpenMenu={onSetOpenMenu}
            onRenameThread={onRenameThread}
            onForkThread={onForkThread}
            onArchiveThread={onArchiveThread}
          />
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
