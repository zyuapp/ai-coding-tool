import { Archive, ArrowLeft, FolderGit2, Gauge, Globe, Keyboard, MonitorCog, Palette, SlidersHorizontal, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ShortcutSetting } from "../../domain/shortcuts";
import type { Task } from "../../domain/task";
import type { ThemeMode } from "../../domain/theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { BrowserSettings } from "./BrowserSettings";
import { ComputerUseSettings, useComputerUsePermissions } from "./ComputerUseSettings";
import { GeneralSettings } from "./GeneralSettings";
import { MobileSettings } from "./MobileSettings";
import type { MobileServerState } from "../../domain/mobile";
import { ShortcutSettings } from "./ShortcutSettings";
import { UsageSettings } from "./UsageSettings";
import { useFocusReturn } from "../focus";
import type { WorktreeSettingsView } from "../../application/workspace-state";
import { WorktreeSettings } from "./WorktreeSettings";

export type SettingsSection = "appearance" | "general" | "computer-use" | "usage" | "worktrees" | "shortcuts" | "browser" | "phone" | "archive";

/** The list of pages. Two of them ask for a fresh read as they are opened. */
function SettingsNav({ section, onSelect, onRefreshWorktrees, onRefreshRemote }: { section: SettingsSection; onSelect: (section: SettingsSection) => void; onRefreshWorktrees: () => void; onRefreshRemote: () => void }) {
  return (
    <nav aria-label="Settings sections">
      <button className={section === "general" ? "active" : ""} type="button" aria-current={section === "general" ? "page" : undefined} onClick={() => onSelect("general")}>
        <SlidersHorizontal size={17} aria-hidden="true" />
        <span>General</span>
      </button>
      <button className={section === "appearance" ? "active" : ""} type="button" aria-current={section === "appearance" ? "page" : undefined} onClick={() => onSelect("appearance")}>
        <Palette size={17} aria-hidden="true" />
        <span>Appearance</span>
      </button>
      <button className={section === "usage" ? "active" : ""} type="button" aria-current={section === "usage" ? "page" : undefined} onClick={() => onSelect("usage")}>
        <Gauge size={17} aria-hidden="true" />
        <span>Usage</span>
      </button>
      <button className={section === "worktrees" ? "active" : ""} type="button" aria-current={section === "worktrees" ? "page" : undefined} onClick={() => {
        onSelect("worktrees");
        onRefreshWorktrees();
      }}>
        <FolderGit2 size={17} aria-hidden="true" />
        <span>Worktrees</span>
      </button>
      <button className={section === "shortcuts" ? "active" : ""} type="button" aria-current={section === "shortcuts" ? "page" : undefined} onClick={() => onSelect("shortcuts")}>
        <Keyboard size={17} aria-hidden="true" />
        <span>Shortcuts</span>
      </button>
      <button className={section === "computer-use" ? "active" : ""} type="button" aria-current={section === "computer-use" ? "page" : undefined} onClick={() => onSelect("computer-use")}>
        <MonitorCog size={17} aria-hidden="true" />
        <span>Computer use</span>
      </button>
      <button className={section === "browser" ? "active" : ""} type="button" aria-current={section === "browser" ? "page" : undefined} onClick={() => onSelect("browser")}>
        <Globe size={17} aria-hidden="true" />
        <span>Browser</span>
      </button>
      <button className={section === "phone" ? "active" : ""} type="button" aria-current={section === "phone" ? "page" : undefined} onClick={() => {
        onSelect("phone");
        onRefreshRemote();
      }}>
        <Smartphone size={17} aria-hidden="true" />
        <span>Phone</span>
      </button>
      <button className={section === "archive" ? "active" : ""} type="button" aria-current={section === "archive" ? "page" : undefined} onClick={() => onSelect("archive")}>
        <Archive size={17} aria-hidden="true" />
        <span>Archived threads</span>
      </button>
    </nav>
  );
}

/** The way out of settings, above the pages themselves. */
function SettingsSidebar({ section, backRef, onClose, onSelect, onRefreshWorktrees, onRefreshRemote }: {
  section: SettingsSection;
  backRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSelect: (section: SettingsSection) => void;
  onRefreshWorktrees: () => void;
  onRefreshRemote: () => void;
}) {
  return (
    <aside className="settings-sidebar">
      <div className="settings-traffic-space" aria-hidden="true" />
      <button ref={backRef} className="settings-back" type="button" onClick={onClose}>
        <ArrowLeft size={17} aria-hidden="true" />
        <span>Back to AI Coding Tool</span>
      </button>
      <h1>Settings</h1>
      <SettingsNav section={section} onSelect={onSelect} onRefreshWorktrees={onRefreshWorktrees} onRefreshRemote={onRefreshRemote} />
    </aside>
  );
}

export type SettingsPanelProps = {
  onClose: () => void;
  /** The page settings opens on, which computer-use setup asks for by name. */
  initialSection?: SettingsSection;
  archivedTasks: Task[];
  managedWorktrees: WorktreeSettingsView[] | null;
  worktreeManagementError: string | null;
  worktreeManagementNotice: string | null;
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
  plainEnglish: boolean;
  /** Whether runs reach the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  /** Whether a run may see and operate other applications. */
  computerUse: boolean;
  /** Whether a run may drive the browser panel. The user's own tabs stay usable either way. */
  browserTools: boolean;
  notifications: boolean;
  /** The phone bridge, as the main process last reported it. */
  remote: MobileServerState;
  shortcuts: ShortcutSetting[];
  /** The action waiting for a keystroke, while the window hands every one of them over. */
  capturingShortcut: string | null;
  onSetThemeFamily: (family: string) => void;
  onSetThemeMode: (mode: ThemeMode) => void;
  onSetUiFont: (font: string) => void;
  onSetMonoFont: (font: string) => void;
  onSetReadingSize: (size: number) => void;
  onSetTerminalSize: (size: number) => void;
  onSetPlainEnglish: (enabled: boolean) => void;
  onSetChromeBrowser: (enabled: boolean) => void;
  onSetComputerUse: (enabled: boolean) => void;
  onSetBrowserTools: (enabled: boolean) => void;
  onSetNotifications: (enabled: boolean) => void;
  onRestoreTask: (taskId: string) => void;
  onClearArchive: () => void;
  onRefreshWorktrees: () => void;
  onRevealWorktree: (root: string) => void;
  onDeleteWorktree: (root: string) => void;
  onClearBrowserData: () => void;
  onCaptureShortcut: (action: string | null) => void;
  onSetShortcut: (action: string, binding: string | null) => void;
  onResetShortcuts: () => void;
  onSetRemoteEnabled: (enabled: boolean) => void;
  onSetRemoteLanExposed: (exposed: boolean) => void;
  onCreateRemotePairingCode: () => void;
  onRevokeRemoteDevice: (deviceId: string) => void;
  onSetTailscaleServe: (enabled: boolean) => void;
  onRefreshRemote: () => void;
};

export function SettingsPanel({
  onClose,
  initialSection = "general",
  archivedTasks,
  managedWorktrees,
  worktreeManagementError,
  worktreeManagementNotice,
  theme,
  themeMode,
  uiFont,
  monoFont,
  readingSize,
  terminalSize,
  allowedOrigins,
  plainEnglish,
  chromeBrowser,
  computerUse,
  browserTools,
  notifications,
  remote,
  shortcuts,
  capturingShortcut,
  onSetThemeFamily,
  onSetThemeMode,
  onSetUiFont,
  onSetMonoFont,
  onSetReadingSize,
  onSetTerminalSize,
  onSetPlainEnglish,
  onSetChromeBrowser,
  onSetComputerUse,
  onSetBrowserTools,
  onSetNotifications,
  onRestoreTask,
  onClearArchive,
  onRefreshWorktrees,
  onRevealWorktree,
  onDeleteWorktree,
  onClearBrowserData,
  onCaptureShortcut,
  onSetShortcut,
  onResetShortcuts,
  onSetRemoteEnabled,
  onSetRemoteLanExposed,
  onCreateRemotePairingCode,
  onRevokeRemoteDevice,
  onSetTailscaleServe,
  onRefreshRemote,
}: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const clearArchive = useRef<HTMLButtonElement>(null);
  const clearBrowser = useRef<HTMLButtonElement>(null);
  const confirmation = useRef<HTMLButtonElement>(null);
  useFocusReturn(back);

  useEffect(() => {
    if (confirmingClear || confirmingSignOut) confirmation.current?.focus();
  }, [confirmingClear, confirmingSignOut]);

  function cancelConfirmation(browser: boolean) {
    if (browser) setConfirmingSignOut(false);
    else setConfirmingClear(false);
    requestAnimationFrame(() => (browser ? clearBrowser : clearArchive).current?.focus());
  }

  const computerUsePermissions = useComputerUsePermissions();
  return (
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
      <SettingsSidebar section={section} backRef={back} onClose={onClose} onSelect={setSection} onRefreshWorktrees={onRefreshWorktrees} onRefreshRemote={onRefreshRemote} />

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

        <GeneralSettings plainEnglish={plainEnglish} onSetPlainEnglish={onSetPlainEnglish} chromeBrowser={chromeBrowser} onSetChromeBrowser={onSetChromeBrowser} notifications={notifications} onSetNotifications={onSetNotifications} />
      </main>
      )}

      {section === "usage" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>Usage</h2>
          <p>What Claude has spent of the limits your plan resets on a clock.</p>
        </div>

        <UsageSettings />
      </main>
      )}

      {section === "worktrees" && (
        <WorktreeSettings
          worktrees={managedWorktrees}
          error={worktreeManagementError}
          notice={worktreeManagementNotice}
          onRefresh={onRefreshWorktrees}
          onReveal={onRevealWorktree}
          onDelete={onDeleteWorktree}
        />
      )}

      {section === "shortcuts" && <ShortcutSettings shortcuts={shortcuts} capturingShortcut={capturingShortcut} onCaptureShortcut={onCaptureShortcut} onSetShortcut={onSetShortcut} onResetShortcuts={onResetShortcuts} />}

      {section === "browser" && <BrowserSettings browserTools={browserTools} allowedOrigins={allowedOrigins} confirming={confirmingSignOut} confirmationRef={confirmation} clearRef={clearBrowser}
        onSetBrowserTools={onSetBrowserTools} onClearBrowserData={onClearBrowserData} onStartConfirm={() => setConfirmingSignOut(true)} onCancelConfirm={() => cancelConfirmation(true)} />}

      {section === "phone" && (
        <MobileSettings
          remote={remote}
          onSetEnabled={onSetRemoteEnabled}
          onSetLanExposed={onSetRemoteLanExposed}
          onCreatePairingCode={onCreateRemotePairingCode}
          onRevokeDevice={onRevokeRemoteDevice}
          onSetTailscaleServe={onSetTailscaleServe}
          onRefreshTailscale={onRefreshRemote}
        />
      )}

      {section === "archive" && <ArchiveSettings archivedTasks={archivedTasks} confirming={confirmingClear} confirmationRef={confirmation} clearRef={clearArchive}
        onRestoreTask={onRestoreTask} onClearArchive={onClearArchive} onStartConfirm={() => setConfirmingClear(true)} onCancelConfirm={() => cancelConfirmation(false)} />}

      {section === "computer-use" && <ComputerUseSettings computerUse={computerUse} onSetComputerUse={onSetComputerUse} {...computerUsePermissions} />}
    </section>
  );
}
