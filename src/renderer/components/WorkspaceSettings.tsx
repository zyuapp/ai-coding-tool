import { SettingsPanel } from "./SettingsPanel";
import { useComputerUseReads } from "../task-workspace/computer-use-reads";
import type { useTaskWorkspace } from "../task-workspace/useTaskWorkspace";

type Workspace = ReturnType<typeof useTaskWorkspace>;

/** The settings sheet with every preference it reads and every command its controls dispatch. */
export function WorkspaceSettings({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  useComputerUseReads(workspace.computerUsePermissions, workspace.actions.readComputerUse);

  return (
    <SettingsPanel
      onClose={onClose}
      initialSection={workspace.settingsSection ?? "general"}
      initialSetting={workspace.settingsFocus}
      archivedThreads={workspace.archivedThreads}
      cli={workspace.cli}
      onReadCli={() => void workspace.actions.readCli()}
      onSetCliInstalled={(installed) => void workspace.actions.setCliInstalled(installed)}
      planUsage={workspace.planUsage}
      onReadPlanUsage={() => void workspace.actions.readPlanUsage()}
      computerUseAccess={workspace.computerUsePermissions}
      onEnableComputerUse={(permission) => void workspace.actions.enableComputerUse(permission)}
      onRestartForComputerUse={() => void workspace.actions.restartForComputerUse()}
      worktreeSettings={workspace.worktreeSettings} worktreeManagementError={workspace.worktreeManagementError} worktreeManagementNotice={workspace.worktreeManagementNotice}
      theme={workspace.theme}
      themeMode={workspace.themeMode}
      uiFont={workspace.uiFont}
      monoFont={workspace.monoFont}
      readingSize={workspace.readingSize}
      terminalSize={workspace.terminalSize}
      allowedOrigins={workspace.browserOrigins}
      chromeBrowser={workspace.chromeBrowser} conciseReplies={workspace.conciseReplies} computerUse={workspace.computerUse} browserTools={workspace.browserTools}
      notifications={workspace.notifications} remote={workspace.remote} remoteChecking={workspace.remoteChecking}
      agentSettingsReload={workspace.agentSettingsReload} onReloadAgentSettings={() => void workspace.actions.reloadAgentSettings()}
      engineAccess={workspace.engineAccess} engineChecking={workspace.engineChecking}
      shortcuts={workspace.shortcuts}
      capturingShortcut={workspace.capturingShortcut}
      desktopShortcutUnavailable={workspace.desktopShortcutUnavailable}
      onSetThemeFamily={(family) => void workspace.actions.setThemeFamily(family)}
      onSetThemeMode={(mode) => void workspace.actions.setThemeMode(mode)}
      onSetUiFont={(font) => void workspace.actions.setUiFont(font)}
      onSetMonoFont={(font) => void workspace.actions.setMonoFont(font)}
      onSetReadingSize={(size) => void workspace.actions.setReadingSize(size)}
      onSetTerminalSize={(size) => void workspace.actions.setTerminalSize(size)}
      onSetChromeBrowser={(enabled) => void workspace.actions.setChromeBrowser(enabled)} onSetConciseReplies={(enabled) => void workspace.actions.setConciseReplies(enabled)} onSetComputerUse={(enabled) => void workspace.actions.setComputerUse(enabled)} onSetBrowserTools={(enabled) => void workspace.actions.setBrowserTools(enabled)}
      onSetNotifications={(enabled) => void workspace.actions.setNotifications(enabled)}
      onCheckForUpdates={() => void workspace.actions.checkForUpdates()}
      onOpenSourceLicenses={() => void workspace.dispatch({ type: "app.open-source-licenses" })}
      onRestoreThread={workspace.actions.restoreThread}
      onClearArchive={workspace.actions.clearArchive}
      onRefreshEngines={() => void workspace.actions.refreshEngineStatus()} onSignInEngine={(engine) => void workspace.actions.signInEngine(engine)}
      onRefreshWorktrees={() => void workspace.actions.refreshWorktrees()} onWorktreeCommand={workspace.dispatch}
      onClearBrowserData={() => void workspace.actions.clearBrowserData()}
      onCaptureShortcut={(action) => void workspace.actions.captureShortcut(action)}
      onSetShortcut={(action, binding) => void workspace.actions.setShortcut(action, binding)}
      computers={{
        found: workspace.computersFound, searching: workspace.computersSearching, searchError: workspace.computersSearchError,
        links: workspace.computerLinks, pairing: workspace.computerPairing,
        onDiscover: () => void workspace.actions.discoverComputers(),
        onPair: (host, name, code) => void workspace.actions.pairComputer(host, name, code),
        onCancelPairing: () => void workspace.actions.cancelComputerPairing(),
        onForget: (id) => void workspace.actions.forgetComputer(id),
      }}
      onResetShortcuts={() => void workspace.actions.resetShortcuts()} onSetRemoteEnabled={(enabled) => void workspace.actions.setRemoteEnabled(enabled)} onCreateRemotePairingCode={() => void workspace.actions.createRemotePairingCode()} onRevokeRemoteDevice={(deviceId) => void workspace.actions.revokeRemoteDevice(deviceId)} onRefreshRemote={() => void workspace.actions.refreshRemote()}
    />
  );
}
