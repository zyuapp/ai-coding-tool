import { SettingsPanel } from "./SettingsPanel";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The settings sheet with every preference it reads and every command its controls dispatch. */
export function WorkspaceSettings({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  return (
    <SettingsPanel
      onClose={onClose}
      initialSection={workspace.settingsSection ?? "general"}
      archivedTasks={workspace.archivedTasks}
      managedWorktrees={workspace.managedWorktrees} worktreeManagementError={workspace.worktreeManagementError} worktreeManagementNotice={workspace.worktreeManagementNotice}
      theme={workspace.theme}
      themeMode={workspace.themeMode}
      uiFont={workspace.uiFont}
      monoFont={workspace.monoFont}
      readingSize={workspace.readingSize}
      terminalSize={workspace.terminalSize}
      allowedOrigins={workspace.browserOrigins}
      plainEnglish={workspace.plainEnglish} chromeBrowser={workspace.chromeBrowser} computerUse={workspace.computerUse} browserTools={workspace.browserTools}
      notifications={workspace.notifications} remote={workspace.remote}
      engineAccess={workspace.engineAccess} engineChecking={workspace.engineChecking}
      shortcuts={workspace.shortcuts}
      capturingShortcut={workspace.capturingShortcut}
      onSetThemeFamily={(family) => void workspace.actions.setThemeFamily(family)}
      onSetThemeMode={(mode) => void workspace.actions.setThemeMode(mode)}
      onSetUiFont={(font) => void workspace.actions.setUiFont(font)}
      onSetMonoFont={(font) => void workspace.actions.setMonoFont(font)}
      onSetReadingSize={(size) => void workspace.actions.setReadingSize(size)}
      onSetTerminalSize={(size) => void workspace.actions.setTerminalSize(size)}
      onSetPlainEnglish={(enabled) => void workspace.actions.setPlainEnglish(enabled)} onSetChromeBrowser={(enabled) => void workspace.actions.setChromeBrowser(enabled)} onSetComputerUse={(enabled) => void workspace.actions.setComputerUse(enabled)} onSetBrowserTools={(enabled) => void workspace.actions.setBrowserTools(enabled)}
      onSetNotifications={(enabled) => void workspace.actions.setNotifications(enabled)}
      onRestoreTask={workspace.actions.restoreTask}
      onClearArchive={workspace.actions.clearArchive}
      onRefreshEngines={() => void workspace.actions.refreshEngineStatus()} onSignInEngine={(engine) => void workspace.actions.signInEngine(engine)}
      onRefreshWorktrees={() => void workspace.actions.refreshWorktrees()} onRevealWorktree={(root) => void workspace.actions.revealWorktree(root)} onDeleteWorktree={(root) => void workspace.actions.deleteManagedWorktree(root)}
      onClearBrowserData={() => void workspace.actions.clearBrowserData()}
      onCaptureShortcut={(action) => void workspace.actions.captureShortcut(action)}
      onSetShortcut={(action, binding) => void workspace.actions.setShortcut(action, binding)}
      onResetShortcuts={() => void workspace.actions.resetShortcuts()} onSetRemoteEnabled={(enabled) => void workspace.actions.setRemoteEnabled(enabled)} onSetRemoteLanExposed={(exposed) => void workspace.actions.setRemoteLanExposed(exposed)} onCreateRemotePairingCode={() => void workspace.actions.createRemotePairingCode()} onRevokeRemoteDevice={(deviceId) => void workspace.actions.revokeRemoteDevice(deviceId)} onSetTailscaleServe={(enabled) => void workspace.actions.setTailscaleServe(enabled)} onRefreshRemote={() => void workspace.actions.refreshRemote()}
    />
  );
}
