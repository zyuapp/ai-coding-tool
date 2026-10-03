import { useEffect, useRef, useState } from "react";
import type { ShortcutSetting } from "../../domain/shortcuts";
import type { Thread } from "../../domain/thread";
import type { ThemeMode } from "../../domain/theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { BrowserSettings } from "./BrowserSettings";
import { NO_BROWSER_IMPORT_SETTINGS, type BrowserImportSettings } from "./BrowserImportSection";
import { ComputerUseSettings } from "./ComputerUseSettings";
import { EngineSettings, type EngineSettingsProps } from "./EngineSettings";
import { GeneralSettings } from "./GeneralSettings";
import type { AgentEngine, EngineReadiness } from "../../domain/agent-engine";
import type { SettingsSection } from "../../domain/settings-section";
import { MobileSettings } from "./MobileSettings";
import type { ComputerSettingsProps } from "./ComputerSettings";
import type { MobileServerState } from "../../domain/mobile";
import { SettingFocus } from "./SettingRow";
import type { SettingMark } from "../../domain/settings-catalog";
import { SettingsSidebar } from "./SettingsSidebar";
import { ShortcutSettings } from "./ShortcutSettings";
import { UsageSettings } from "./UsageSettings";
import { useFocusReturn } from "../focus";
import type { CliState } from "../../application/cli-installation";
import type { ComputerUseAccessState } from "../../application/computer-use-access";
import type { PlanUsageState } from "../../application/plan-limits";
import type { DesktopShortcutUnavailable } from "../../application/workspace-state";
import type { ComputerUsePermission } from "../../contracts/ipc";
import type { WorktreeSettingsPage } from "../../application/worktree-settings";
import type { WorktreeCommand } from "../../contracts/commands";
import { WorktreeSettings } from "./WorktreeSettings";

/** The two destructive asks the sheet confirms, each taking the focus and handing it back to the button that asked. */
function useConfirmations() {
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const clearArchive = useRef<HTMLButtonElement>(null);
  const clearBrowser = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmingClear || confirmingSignOut) confirmation.current?.focus();
  }, [confirmingClear, confirmingSignOut]);
  function cancelConfirmation(browser: boolean) {
    if (browser) setConfirmingSignOut(false);
    else setConfirmingClear(false);
    requestAnimationFrame(() => (browser ? clearBrowser : clearArchive).current?.focus());
  }
  return { confirmingClear, setConfirmingClear, confirmingSignOut, setConfirmingSignOut, clearArchive, clearBrowser, confirmation, cancelConfirmation };
}

export type SettingsPanelProps = {
  onClose: () => void;
  /** The page settings shows. Computer-use setup and the engine error each ask for their own. */
  section: SettingsSection;
  /** The control on that page to scroll to and mark, when something named one. */
  settingMark: SettingMark | null;
  /** Opens a page, marking the control on it a search named. */
  onLand: (section: SettingsSection, settingId: string | null) => void;
  archivedThreads: Thread[];
  worktreeSettings: WorktreeSettingsPage;
  worktreeManagementError: string | null;
  worktreeManagementNotice: string | null;
  /** The terminal command the app installs, and the two things settings can do about it. */
  cli: CliState;
  onReadCli: () => void;
  onSetCliInstalled: (installed: boolean) => void;
  /** The plan limits each provider reports, and the ask that reads them again. */
  planUsage: PlanUsageState;
  onReadPlanUsage: () => void;
  /** What the platform lets the app see and operate, and the two things settings can do about it. */
  computerUseAccess: ComputerUseAccessState;
  onEnableComputerUse: (permission: ComputerUsePermission) => void;
  onRestartForComputerUse: () => void;
  /** The theme in effect, by id, and the ground the user asked for. */
  theme: string;
  themeMode: ThemeMode;
  /** The families in effect, and the two sizes in px that follow the user. */
  uiFont: string;
  monoFont: string;
  readingSize: number;
  terminalSize: number;
  /** How many sites a run may open without asking, which clearing the session takes back. */
  allowedOrigins: string[];
  /** Whether runs answer in the Simplified Technical English style the app installs. */
  /** Whether runs reach the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  conciseReplies: boolean;
  /** Whether a run may see and operate other applications. */
  computerUse: boolean;
  /** Whether a run may drive the browser panel. The user's own tabs stay usable either way. */
  browserTools: boolean;
  notifications: boolean;
  /** The phone bridge, as the main process last reported it. */
  remote: MobileServerState;
  remoteChecking: boolean;
  /** Where each engine stands on this machine, and whether the app is asking about them now. */
  engineAccess: Record<AgentEngine, EngineReadiness>;
  engineChecking: boolean;
  engineUpdating: AgentEngine | null;
  agentSettingsReload: EngineSettingsProps["reloadStatus"];
  onReloadAgentSettings: () => void;
  shortcuts: ShortcutSetting[];
  /** The action waiting for a keystroke, while the window hands every one of them over. */
  capturingShortcut: string | null;
  desktopShortcutUnavailable: DesktopShortcutUnavailable | null;
  onSetThemeFamily: (family: string) => void;
  onSetThemeMode: (mode: ThemeMode) => void;
  onSetUiFont: (font: string) => void;
  onSetMonoFont: (font: string) => void;
  onSetReadingSize: (size: number) => void;
  onSetTerminalSize: (size: number) => void;
  onSetChromeBrowser: (enabled: boolean) => void;
  onSetConciseReplies: (enabled: boolean) => void;
  onSetComputerUse: (enabled: boolean) => void;
  onSetBrowserTools: (enabled: boolean) => void;
  onSetNotifications: (enabled: boolean) => void;
  onCheckForUpdates: () => void;
  onOpenSourceLicenses: () => void;
  onRestoreThread: (threadId: string) => void;
  onClearArchive: () => void;
  onRefreshEngines: () => void;
  onSignInEngine: (engine: AgentEngine) => void;
  onUpdateEngine: (engine: AgentEngine) => void;
  onRefreshWorktrees: () => void;
  onWorktreeCommand: (command: WorktreeCommand) => void;
  onClearBrowserData: () => void;
  browserImport?: BrowserImportSettings;
  onCaptureShortcut: (action: string | null) => void;
  onSetShortcut: (action: string, binding: string | null) => void;
  onResetShortcuts: () => void;
  onSetRemoteEnabled: (enabled: boolean) => void;
  onCreateRemotePairingCode: () => void;
  onRevokeRemoteDevice: (deviceId: string) => void;
  onRefreshRemote: () => void;
  /** The other computers, as the Devices page draws them. Absent where a test has none. */
  computers?: ComputerSettingsProps;
};

/** A Devices page with no computers to speak of, for a caller with nothing to say about them. */
const NO_COMPUTER_SETTINGS: ComputerSettingsProps = { found: [], searching: false, searchError: null, name: "", links: [], pairing: null, onDiscover() {}, onPair() {}, onCancelPairing() {}, onForget() {}, onRename() {}, onLabel() {} };

export function SettingsPanel({
  onClose,
  section,
  settingMark,
  onLand,
  archivedThreads,
  cli, onReadCli, onSetCliInstalled, planUsage, onReadPlanUsage,
  computerUseAccess, onEnableComputerUse, onRestartForComputerUse,
  worktreeSettings,
  worktreeManagementError,
  worktreeManagementNotice,
  theme,
  themeMode,
  uiFont,
  monoFont,
  readingSize,
  terminalSize,
  allowedOrigins,
  chromeBrowser,
  conciseReplies,
  computerUse,
  browserTools,
  notifications,
  remote,
  remoteChecking,
  engineAccess,
  engineChecking,
  engineUpdating,
  agentSettingsReload, onReloadAgentSettings,
  shortcuts, capturingShortcut, desktopShortcutUnavailable,
  onSetThemeFamily,
  onSetThemeMode,
  onSetUiFont,
  onSetMonoFont,
  onSetReadingSize,
  onSetTerminalSize,
  onSetChromeBrowser,
  onSetConciseReplies,
  onSetComputerUse,
  onSetBrowserTools,
  onSetNotifications,
  onCheckForUpdates,
  onOpenSourceLicenses,
  onRestoreThread,
  onClearArchive,
  onRefreshEngines,
  onSignInEngine,
  onUpdateEngine,
  onRefreshWorktrees,
  onWorktreeCommand,
  onClearBrowserData,
  browserImport = NO_BROWSER_IMPORT_SETTINGS,
  onCaptureShortcut,
  onSetShortcut,
  onResetShortcuts,
  onSetRemoteEnabled,
  onCreateRemotePairingCode,
  onRevokeRemoteDevice,
  onRefreshRemote,
  computers = NO_COMPUTER_SETTINGS,
}: SettingsPanelProps) {
  const { confirmingClear, setConfirmingClear, confirmingSignOut, setConfirmingSignOut, clearArchive, clearBrowser, confirmation, cancelConfirmation } = useConfirmations();
  const back = useRef<HTMLButtonElement>(null);
  useFocusReturn(back);

  return (
    <SettingFocus value={settingMark}>
    <section
      className="settings-view"
      aria-label="Settings"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || (!confirmingClear && !confirmingSignOut)) return;
        event.preventDefault();
        event.stopPropagation();
        cancelConfirmation(confirmingSignOut);
      }}
    >
      <SettingsSidebar section={section} backRef={back} onClose={onClose} onLand={onLand} onRefreshEngines={onRefreshEngines} onRefreshWorktrees={onRefreshWorktrees} onRefreshRemote={onRefreshRemote} />

      {section === "appearance" && (
      <main className="settings-main">
        <AppearanceSettings
          theme={theme}
          themeMode={themeMode}
          uiFont={uiFont}
          monoFont={monoFont}
          readingSize={readingSize}
          terminalSize={terminalSize}
          onSetThemeFamily={onSetThemeFamily}
          onSetThemeMode={onSetThemeMode}
          onSetUiFont={onSetUiFont}
          onSetMonoFont={onSetMonoFont}
          onSetReadingSize={onSetReadingSize}
          onSetTerminalSize={onSetTerminalSize}
        />
      </main>
      )}

      {section === "general" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>General</h2>
          <p>How AI Coding Tool answers from outside its own window.</p>
        </div>

        <GeneralSettings cli={cli} onReadCli={onReadCli} onSetCliInstalled={onSetCliInstalled} chromeBrowser={chromeBrowser} onSetChromeBrowser={onSetChromeBrowser} conciseReplies={conciseReplies} onSetConciseReplies={onSetConciseReplies} notifications={notifications} onSetNotifications={onSetNotifications} onCheckForUpdates={onCheckForUpdates} onOpenSourceLicenses={onOpenSourceLicenses} />
      </main>
      )}

      {section === "usage" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>Usage</h2>
          <p>Plan limits across your signed-in accounts.</p>
        </div>

        <UsageSettings usage={planUsage} onRefresh={onReadPlanUsage} />
      </main>
      )}

      {section === "engines" && <EngineSettings reloadStatus={agentSettingsReload} onReload={onReloadAgentSettings} engineAccess={engineAccess} checking={engineChecking} updating={engineUpdating} onRefresh={onRefreshEngines} onSignIn={onSignInEngine} onUpdate={onUpdateEngine} />}

      {section === "worktrees" && (
        <WorktreeSettings
          page={worktreeSettings}
          error={worktreeManagementError}
          notice={worktreeManagementNotice}
          dispatch={onWorktreeCommand}
        />
      )}

      {section === "shortcuts" && <ShortcutSettings shortcuts={shortcuts} capturingShortcut={capturingShortcut} desktopShortcutUnavailable={desktopShortcutUnavailable} onCaptureShortcut={onCaptureShortcut} onSetShortcut={onSetShortcut} onResetShortcuts={onResetShortcuts} />}

      {section === "browser" && <BrowserSettings browserTools={browserTools} allowedOrigins={allowedOrigins} confirming={confirmingSignOut} confirmationRef={confirmation} clearRef={clearBrowser}
        onSetBrowserTools={onSetBrowserTools} onClearBrowserData={onClearBrowserData} onStartConfirm={() => setConfirmingSignOut(true)} onCancelConfirm={() => cancelConfirmation(true)}
        browserImport={browserImport} />}

      {section === "phone" && (
        <MobileSettings
          remote={remote}
          remoteChecking={remoteChecking}
          onSetEnabled={onSetRemoteEnabled}
          onCreatePairingCode={onCreateRemotePairingCode}
          onRevokeDevice={onRevokeRemoteDevice}
          onRefreshTailscale={onRefreshRemote}
          computers={computers}
        />
      )}

      {section === "archive" && <ArchiveSettings archivedThreads={archivedThreads} confirming={confirmingClear} confirmationRef={confirmation} clearRef={clearArchive}
        onRestoreThread={onRestoreThread} onClearArchive={onClearArchive} onStartConfirm={() => setConfirmingClear(true)} onCancelConfirm={() => cancelConfirmation(false)} />}

      {section === "computer-use" && <ComputerUseSettings computerUse={computerUse} onSetComputerUse={onSetComputerUse} access={computerUseAccess} onEnable={onEnableComputerUse} onRestart={onRestartForComputerUse} />}
    </section>
    </SettingFocus>
  );
}
