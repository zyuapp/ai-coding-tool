import { Archive, ArrowLeft, Check, FolderGit2, Gauge, Globe, Keyboard, MonitorCog, Palette, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComputerUsePermission, ComputerUsePermissions } from "../../contracts/ipc";
import { shortcutKeys, type ShortcutSetting } from "../../domain/shortcuts";
import { MAC } from "../platform";
import { ARCHIVE_RETENTION_MS, type Task } from "../../domain/task";
import type { ThemeMode } from "../../domain/theme";
import { AppearanceSettings } from "./AppearanceSettings";
import { GeneralSettings } from "./GeneralSettings";
import { UsageSettings } from "./UsageSettings";
import { useFocusReturn } from "../focus";
import type { WorktreeSettingsView } from "../../application/workspace-state";
import { WorktreeSettings } from "./WorktreeSettings";

export type SettingsSection = "appearance" | "general" | "computer-use" | "usage" | "worktrees" | "shortcuts" | "browser" | "archive";

function daysLeft(archivedAt: number) {
  const remaining = Math.ceil((archivedAt + ARCHIVE_RETENTION_MS - Date.now()) / 86_400_000);
  if (remaining <= 0) return "Deletes on next launch";
  return remaining === 1 ? "Deletes in 1 day" : `Deletes in ${remaining} days`;
}

/** One switch that turns a whole capability on or off, above the settings that only matter while it is on. */
function AvailabilitySection({ id, label, description, enabled, onChange }: { id: string; label: string; description: string; enabled: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <section className="settings-group" aria-labelledby={`${id}-heading`}>
      <div className="settings-group-heading">
        <div><h3 id={`${id}-heading`}>Availability</h3></div>
      </div>

      <div className="setting-row">
        <span className={`setting-status ${enabled ? "granted" : ""}`}>{enabled && <Check size={13} />}</span>
        <div>
          <strong>{label}</strong>
          <p>{description}</p>
        </div>
        <div className="setting-row-action">
          <button type="button" role="switch" aria-checked={enabled} onClick={() => onChange(!enabled)}>{enabled ? "Turn off" : "Turn on"}</button>
        </div>
      </div>
    </section>
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
}: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [permissions, setPermissions] = useState<ComputerUsePermissions | null>(null);
  const [busy, setBusy] = useState<ComputerUsePermission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const requested = useRef(false);
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

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await window.desktop.computerUsePermissions();
        if (cancelled) return;
        setPermissions(next);
        if (requested.current && next.accessibility && next.screenRecording) setRestartRequired(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_000);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  async function enable(permission: ComputerUsePermission) {
    setBusy(permission);
    setError(null);
    requested.current = true;
    try {
      const next = await window.desktop.enableComputerUse(permission);
      setPermissions(next);
      if (next.accessibility && next.screenRecording) setRestartRequired(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const ready = Boolean(permissions?.accessibility && permissions.screenRecording);
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
      <aside className="settings-sidebar">
        <div className="settings-traffic-space" aria-hidden="true" />
        <button ref={back} className="settings-back" type="button" onClick={onClose}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>Back to AI Coding Tool</span>
        </button>
        <h1>Settings</h1>
        <nav aria-label="Settings sections">
          <button className={section === "general" ? "active" : ""} type="button" aria-current={section === "general" ? "page" : undefined} onClick={() => setSection("general")}>
            <SlidersHorizontal size={17} aria-hidden="true" />
            <span>General</span>
          </button>
          <button className={section === "appearance" ? "active" : ""} type="button" aria-current={section === "appearance" ? "page" : undefined} onClick={() => setSection("appearance")}>
            <Palette size={17} aria-hidden="true" />
            <span>Appearance</span>
          </button>
          <button className={section === "usage" ? "active" : ""} type="button" aria-current={section === "usage" ? "page" : undefined} onClick={() => setSection("usage")}>
            <Gauge size={17} aria-hidden="true" />
            <span>Usage</span>
          </button>
          <button className={section === "worktrees" ? "active" : ""} type="button" aria-current={section === "worktrees" ? "page" : undefined} onClick={() => {
            setSection("worktrees");
            onRefreshWorktrees();
          }}>
            <FolderGit2 size={17} aria-hidden="true" />
            <span>Worktrees</span>
          </button>
          <button className={section === "shortcuts" ? "active" : ""} type="button" aria-current={section === "shortcuts" ? "page" : undefined} onClick={() => setSection("shortcuts")}>
            <Keyboard size={17} aria-hidden="true" />
            <span>Shortcuts</span>
          </button>
          <button className={section === "computer-use" ? "active" : ""} type="button" aria-current={section === "computer-use" ? "page" : undefined} onClick={() => setSection("computer-use")}>
            <MonitorCog size={17} aria-hidden="true" />
            <span>Computer use</span>
          </button>
          <button className={section === "browser" ? "active" : ""} type="button" aria-current={section === "browser" ? "page" : undefined} onClick={() => setSection("browser")}>
            <Globe size={17} aria-hidden="true" />
            <span>Browser</span>
          </button>
          <button className={section === "archive" ? "active" : ""} type="button" aria-current={section === "archive" ? "page" : undefined} onClick={() => setSection("archive")}>
            <Archive size={17} aria-hidden="true" />
            <span>Archived threads</span>
          </button>
        </nav>
      </aside>

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

      {section === "shortcuts" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>Shortcuts</h2>
          <p>The rest of the keyboard is fixed, so only the keystrokes worth choosing yourself are here.</p>
        </div>

        {[...new Set(shortcuts.map((shortcut) => shortcut.group))].map((group, index) => (
          <section className="settings-group" key={group} aria-label={group}>
            <div className="settings-group-heading">
              <div><h3>{group}</h3></div>
              {index === 0 && (
                <div className="settings-group-action">
                  <button type="button" disabled={shortcuts.every((shortcut) => !shortcut.changed)} onClick={onResetShortcuts}>Restore defaults</button>
                </div>
              )}
            </div>

            {shortcuts.filter((shortcut) => shortcut.group === group).map((shortcut) => (
              <div className="setting-row shortcut-row" key={shortcut.id}>
                <span className="setting-status blank" aria-hidden="true" />
                <div>
                  <strong>{shortcut.label}</strong>
                  <p>{shortcut.description}</p>
                </div>
                <div className="setting-row-action">
                  {capturingShortcut === shortcut.id
                    ? <>
                        <em className="shortcut-capture">Press a keystroke…</em>
                        <button type="button" onClick={() => onCaptureShortcut(null)}>Cancel</button>
                      </>
                    : <>
                        {shortcut.binding
                          ? <kbd className="shortcut-keys">{shortcutKeys(shortcut.binding, MAC).map((key, index) => <span className="shortcut-key" key={index}>{key}</span>)}</kbd>
                          : <em>Not set</em>}
                        <button type="button" onClick={() => onCaptureShortcut(shortcut.id)}>Change</button>
                        {shortcut.changed
                          ? <button type="button" onClick={() => onSetShortcut(shortcut.id, shortcut.defaultBinding)}>Reset</button>
                          : <button type="button" disabled={!shortcut.binding} onClick={() => onSetShortcut(shortcut.id, null)}>Clear</button>}
                      </>}
                </div>
              </div>
            ))}
          </section>
        ))}
      </main>
      )}

      {section === "browser" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>Browser</h2>
          <p>The browser panel keeps one session for the whole app, so a site you sign into stays signed in everywhere AI Coding Tool works.</p>
        </div>

        <AvailabilitySection id="browser-tools" label="Browser use" enabled={browserTools} onChange={onSetBrowserTools}
          description="Claude can open and read pages in the browser panel. Off leaves the panel to you alone." />

        <section className="settings-group" aria-labelledby="browser-session-heading">
          <div className="settings-group-heading">
            <div>
              <h3 id="browser-session-heading">Session</h3>
              <p>Signing out clears every cookie, cache, and stored login, and takes back the sites Claude may open on its own.</p>
            </div>
            <div className="settings-group-action">
              <span>{allowedOrigins.length} {allowedOrigins.length === 1 ? "site allowed" : "sites allowed"}</span>
              {confirmingSignOut
                ? <>
                    <button ref={confirmation} className="danger" type="button" onClick={() => {
                      onClearBrowserData();
                      cancelConfirmation(true);
                    }}>Sign out of everything</button>
                    <button type="button" onClick={() => cancelConfirmation(true)}>Cancel</button>
                  </>
                : <button ref={clearBrowser} type="button" onClick={() => setConfirmingSignOut(true)}>Clear browser data</button>}
            </div>
          </div>

          {allowedOrigins.length === 0
            ? <p className="settings-empty">Claude has to ask before it opens any site.</p>
            : allowedOrigins.map((origin) => (
              <div className="setting-row" key={origin}>
                <span className="setting-status granted"><Check size={13} /></span>
                <div>
                  <strong>{origin}</strong>
                  <p>Claude can open this site without asking.</p>
                </div>
              </div>
            ))}
        </section>
      </main>
      )}

      {section === "archive" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>Archived threads</h2>
          <p>Archived threads stay here for 5 days, then AI Coding Tool deletes them on the next launch.</p>
        </div>

        <section className="settings-group" aria-labelledby="archive-heading">
          <div className="settings-group-heading">
            <div>
              <h3 id="archive-heading">Archive</h3>
              <p>Restore a thread to put it back in the sidebar. Its automation stays off.</p>
            </div>
            <div className="settings-group-action">
              <span>{archivedTasks.length} archived</span>
              {archivedTasks.length > 0 && (confirmingClear
                ? <>
                    <button ref={confirmation} className="danger" type="button" onClick={() => {
                      onClearArchive();
                      cancelConfirmation(false);
                    }}>Delete all</button>
                    <button type="button" onClick={() => cancelConfirmation(false)}>Cancel</button>
                  </>
                : <button ref={clearArchive} type="button" onClick={() => setConfirmingClear(true)}>Clear all</button>)}
            </div>
          </div>

          {archivedTasks.length === 0
            ? <p className="settings-empty">Nothing archived.</p>
            : archivedTasks.map((task) => (
              <div className="setting-row" key={task.id}>
                <span className="setting-status archived"><Archive size={13} /></span>
                <div>
                  <strong>{task.title}</strong>
                  <p>{daysLeft(task.archivedAt!)}</p>
                </div>
                <div className="setting-row-action">
                  <button type="button" onClick={() => onRestoreTask(task.id)}>Restore</button>
                </div>
              </div>
            ))}
        </section>
      </main>
      )}

      {section === "computer-use" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>Computer use</h2>
          <p>Let AI Coding Tool see and control other applications when you ask it to.</p>
        </div>

        <AvailabilitySection id="computer-use" label="Computer use" enabled={computerUse} onChange={onSetComputerUse}
          description="Claude can see and operate other applications. Off leaves it no way to reach them, whatever the permissions below say." />

        <section className="settings-group" aria-labelledby="permissions-heading" aria-live="polite">
          <div className="settings-group-heading">
            <div>
              <h3 id="permissions-heading">Permissions</h3>
              <p>AI Coding Tool needs both macOS permissions to operate other apps.</p>
            </div>
            <span className={ready ? "ready" : ""}>{ready ? "Setup complete" : "Setup required"}</span>
          </div>

          <div className="setting-row">
            <span className={`setting-status ${permissions?.accessibility ? "granted" : ""}`}>{permissions?.accessibility && <Check size={13} />}</span>
            <div>
              <strong>Accessibility</strong>
              <p>Allows AI Coding Tool to click, type, and navigate apps.</p>
            </div>
            <div className="setting-row-action">
              {permissions?.accessibility ? <em className="granted">Done</em> : !permissions && <em>Checking…</em>}
              {permissions && !permissions.accessibility && <button type="button" disabled={busy !== null} onClick={() => void enable("accessibility")}>{busy === "accessibility" ? "Opening…" : "Enable Accessibility"}</button>}
            </div>
          </div>

          <div className="setting-row">
            <span className={`setting-status ${permissions?.screenRecording ? "granted" : ""}`}>{permissions?.screenRecording && <Check size={13} />}</span>
            <div>
              <strong>Screen &amp; System Audio Recording</strong>
              <p>Allows AI Coding Tool to see app windows. System audio is not recorded.</p>
            </div>
            <div className="setting-row-action">
              {permissions?.screenRecording ? <em className="granted">Done</em> : !permissions && <em>Checking…</em>}
              {permissions && !permissions.screenRecording && <button type="button" disabled={busy !== null} onClick={() => void enable("screenRecording")}>{busy === "screenRecording" ? "Opening…" : "Enable Screen Recording"}</button>}
            </div>
          </div>

          {error && <p className="settings-error" role="alert">{error}</p>}
          {restartRequired && <div className="settings-restart"><p>Restart AI Coding Tool to finish enabling computer use.</p><button type="button" onClick={() => window.desktop.restartForComputerUse()}>Restart AI Coding Tool</button></div>}
        </section>

        <p className="settings-privacy">Permission checks capture one frame and discard it immediately.</p>
      </main>
      )}
    </section>
  );
}
