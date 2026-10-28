import { LuClipboardList as ClipboardList, LuFocus as Focus, LuFolderOpen as FolderOpen, LuPanelLeft as PanelLeft, LuPanelRight as PanelRight, LuPencil as Pencil } from "react-icons/lu";
import type { InstalledApp } from "../../contracts/ipc";
import type { Thread } from "../../domain/thread";
import { CommandButton } from "./CommandControl";
import { HostMark } from "./HostMark";
import { OpenInMenu, type OpenInMenuProps } from "./OpenInMenu";
import { PopoverMenu } from "./PopoverMenu";
import { RenameInput, useRenaming } from "./SidebarRename";
import { threadMenuEntries } from "./thread-menu";
import { shortcutTip } from "./TooltipLayer";
import type { ThreadRole } from "../../domain/thread-role";

export type WorkspaceHeaderProps = {
  currentThread?: Thread;
  folder: string;
  /** What the folder is called, which is the project's name rather than the directory's. */
  folderLabel: string;
  /** The paired computer the thread lives on, for one that is not this computer's own. */
  host?: { id: string; name: string; offline: boolean; reconnecting?: boolean } | null;
  sidebarOpen: boolean;
  sessionPanelOpen: boolean;
  rightDockOpen: boolean;
  /** Zen mode, offered only on a thread with messages; `tip` names its keystroke. */
  zen: { available: boolean; tip: string; onEnter: () => void };
  workingSubagents: number;
  openMenu: string | null;
  /** False while the thread has no checkout to hand over, such as a worktree still being made. */
  canOpenFolder: boolean;
  onSetOpenMenu: (menu: string | null) => void;
  /** The applications this machine has, for the menu that hands the checkout to one. */
  apps: InstalledApp[] | null;
  onListApps: () => void;
  onOpenInApp: (appId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onForkThread: (threadId: string, worktree: boolean) => void;
  onArchiveThread: (threadId: string) => void;
  onSetThreadRole: (threadId: string, role: ThreadRole | null) => void;
  /** The coordinators on the computer holding the thread, which are the only ones that can take it. */
  coordinators: readonly Thread[];
  onSetCoordinator: (threadId: string, coordinatorId: string | null) => void;
  /** Whether desktop notices are on at all, which a coordinator's mute only narrows. */
  notifications: boolean;
  onSetMuted: (threadId: string, muted: boolean) => void;
  /** Whether Stop all has anything under the thread to stop. */
  stoppable: boolean;
  onStopAll: (threadId: string) => void;
  onToggleSidebar: () => void;
  onToggleSessionPanel: () => void;
  onToggleRightDock: () => void;
  onChooseFolder: () => void;
};

function ThreadHeading({ currentThread, folder, folderLabel, host, openMenu, onSetOpenMenu, openIn, onRenameThread, onForkThread, onArchiveThread, onSetThreadRole, coordinators, onSetCoordinator, notifications, onSetMuted, stoppable, onStopAll }: Pick<WorkspaceHeaderProps, "currentThread" | "folder" | "folderLabel" | "host" | "openMenu" | "onSetOpenMenu" | "onRenameThread" | "onForkThread" | "onArchiveThread" | "onSetThreadRole" | "coordinators" | "onSetCoordinator" | "notifications" | "onSetMuted" | "stoppable" | "onStopAll"> & { openIn: Pick<OpenInMenuProps, "blocked" | "apps" | "onListApps" | "onOpenInApp"> }) {
  const name = useRenaming((threadId, value) => { if (value.trim()) onRenameThread(threadId, value); });
  return (
    <div className="thread-heading-line">
      <h1>
        {host && <>
          <HostMark name={host.name} offline={host.offline} reconnecting={host.reconnecting} className="heading-host" />
          {host.offline && (host.reconnecting
            ? <span className="heading-host-state" role="status"><span className="text-sweep">Reconnecting…</span></span>
            : <CommandButton type="button" className="heading-host-state" command={{ type: "computers.reconnect", id: host.id }} data-tip={`Reconnect to ${host.name}`}>Reconnect</CommandButton>)}
          <span className="heading-separator" aria-hidden="true">/</span>
        </>}
        {folder && <>
          <OpenInMenu {...openIn} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} crumb={{ label: folderLabel, tip: host ? `${folder} on ${host.name}` : folder }} />
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
          : currentThread
            ? <button type="button" className="heading-thread renamable" data-tip="Rename" onClick={(event) => name.start(currentThread.id, event.currentTarget)}>
                <span>{currentThread.title}</span>
                <Pencil size={14} aria-hidden="true" />
              </button>
            : <span className="heading-thread">New task</span>}
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
          onSetRole: (role) => onSetThreadRole(currentThread.id, role),
          coordinators,
          onSetCoordinator: (coordinatorId) => onSetCoordinator(currentThread.id, coordinatorId),
          notifications,
          onSetMuted: (muted) => onSetMuted(currentThread.id, muted),
          stoppable,
          onStopAll: () => onStopAll(currentThread.id),
        })}
      />}
    </div>
  );
}

export function WorkspaceHeader({ currentThread, folder, folderLabel, host, sidebarOpen, sessionPanelOpen, rightDockOpen, zen, workingSubagents, openMenu, canOpenFolder, apps, onListApps, onSetOpenMenu, onOpenInApp, onRenameThread, onForkThread, onArchiveThread, onSetThreadRole, coordinators, onSetCoordinator, notifications, onSetMuted, stoppable, onStopAll, onToggleSidebar, onToggleSessionPanel, onToggleRightDock, onChooseFolder }: WorkspaceHeaderProps) {
  const working = workingSubagents > 0 ? `${workingSubagents} ${workingSubagents === 1 ? "agent" : "agents"} working` : "";
  const openIn = { blocked: canOpenFolder ? null : "Worktree is still being created", apps, onListApps, onOpenInApp };
  const summaryTip = ["Session summary", working, rightDockOpen && !sessionPanelOpen && "Replaces right panel"].filter(Boolean).join(" · ");
  return (
    <header className={`topbar ${sidebarOpen ? "" : "traffic-inset"}`.trimEnd()}>
      <div className="task-heading">
        <button
          className={`session-toggle sidebar-toggle ${sidebarOpen ? "active" : ""}`}
          type="button"
          aria-label={`${sidebarOpen ? "Hide" : "Show"} sidebar`}
          aria-pressed={sidebarOpen}
          data-tip={shortcutTip("Sidebar", "Mod+B")}
          onClick={onToggleSidebar}
        >
          <PanelLeft size={18} aria-hidden="true" />
        </button>
        <div>
          <ThreadHeading
            key={currentThread?.id ?? "draft"}
            currentThread={currentThread}
            folder={folder}
            folderLabel={folderLabel}
            host={host}
            openMenu={openMenu}
            onSetOpenMenu={onSetOpenMenu}
            openIn={openIn}
            onRenameThread={onRenameThread}
            onForkThread={onForkThread}
            onArchiveThread={onArchiveThread}
            onSetThreadRole={onSetThreadRole}
            coordinators={coordinators}
            onSetCoordinator={onSetCoordinator}
            notifications={notifications}
            onSetMuted={onSetMuted}
            stoppable={stoppable}
            onStopAll={onStopAll}
          />
          {!folder && <button type="button" className="heading-choose-folder" onClick={onChooseFolder}><FolderOpen size={14} aria-hidden="true" />Choose a project folder</button>}
        </div>
      </div>
      <div className="workspace-controls">
        {folder && <OpenInMenu {...openIn} openMenu={openMenu} onSetOpenMenu={onSetOpenMenu} />}
        {folder && zen.available && (
          <button className="session-toggle" type="button" aria-label="Enter zen mode" data-tip={zen.tip} onClick={zen.onEnter}>
            <Focus size={18} aria-hidden="true" />
          </button>
        )}
        <button
          className={`session-toggle ${sessionPanelOpen ? "active" : ""}`}
          type="button"
          aria-label={`${sessionPanelOpen ? "Hide" : "Show"} session summary${working ? `, ${working}` : ""}`}
          aria-pressed={sessionPanelOpen}
          data-tip={summaryTip}
          onClick={onToggleSessionPanel}
        >
          <ClipboardList size={18} aria-hidden="true" />
          {workingSubagents > 0 && <span>{workingSubagents}</span>}
        </button>
        <button
          className={`session-toggle ${rightDockOpen ? "active" : ""}`}
          type="button"
          aria-label={`${rightDockOpen ? "Hide" : "Show"} right panel`}
          aria-pressed={rightDockOpen}
          data-tip={shortcutTip("Right panel", "Mod+\\")}
          onClick={onToggleRightDock}
        >
          <PanelRight size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
