import { Archive, ArrowLeft, Check, Gauge, Globe, Keyboard, MonitorCog, Palette, SlidersHorizontal, Type } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComputerUsePermission, ComputerUsePermissions } from "../../contracts/ipc";
import { CLI_COMMAND, type CliStatus } from "../../domain/cli";
import { displayShortcut, type ShortcutSetting } from "../../domain/shortcuts";
import type { CaptureOptions } from "../../domain/capture";
import { MAC } from "../platform";
import { ARCHIVE_RETENTION_MS, type Task } from "../../domain/task";
import type { ThemeMode } from "../../domain/theme";
import { TextSettings } from "./TextSettings";
import { ThemeSettings } from "./ThemeSettings";
import { UsageSettings } from "./UsageSettings";
import { useFocusReturn } from "../focus";

export type SettingsSection = "theme" | "text" | "general" | "computer-use" | "usage" | "shortcuts" | "browser" | "archive";

function cliDescription(status: CliStatus | null) {
  if (!status) return "Looking for the command…";
  switch (status.state) {
    case "installed": return `Installed at ${status.path}.`;
    case "conflict": return `Something else already answers to ${CLI_COMMAND} at ${status.path}.`;
    case "unsupported": return "The command can only be installed on macOS.";
    default: return `Goes in ${status.path}, which asks for your password once.`;
  }
}

function daysLeft(archivedAt: number) {
  const remaining = Math.ceil((archivedAt + ARCHIVE_RETENTION_MS - Date.now()) / 86_400_000);
  if (remaining <= 0) return "Deletes on next launch";
  return remaining === 1 ? "Deletes in 1 day" : `Deletes in ${remaining} days`;
}

export type SettingsPanelProps = {
  onClose: () => void;
  /** The page settings opens on, which computer-use setup asks for by name. */
  initialSection?: SettingsSection;
  archivedTasks: Task[];
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
  shortcuts: ShortcutSetting[];
  /** Whether grabbing a window plays the shutter, and whether it brings the window forward. */
  captureSound: boolean;
  captureFocus: boolean;
  /** The action waiting for a keystroke, while the window hands every one of them over. */
  capturingShortcut: string | null;
  onSetThemeFamily: (family: string) => void;
  onSetThemeMode: (mode: ThemeMode) => void;
  onSetUiFont: (font: string) => void;
  onSetMonoFont: (font: string) => void;
  onSetReadingSize: (size: number) => void;
  onSetTerminalSize: (size: number) => void;
  onRestoreTask: (taskId: string) => void;
  onClearArchive: () => void;
  onClearBrowserData: () => void;
  onSetCaptureOptions: (options: CaptureOptions) => void;
  onCaptureShortcut: (action: string | null) => void;
  onSetShortcut: (action: string, binding: string | null) => void;
  onResetShortcuts: () => void;
};

export function SettingsPanel({
  onClose,
  initialSection = "general",
  archivedTasks,
  theme,
  themeMode,
  uiFont,
  monoFont,
  readingSize,
  terminalSize,
  allowedOrigins,
  shortcuts,
  captureSound,
  captureFocus,
  capturingShortcut,
  onSetThemeFamily,
  onSetThemeMode,
  onSetUiFont,
  onSetMonoFont,
  onSetReadingSize,
  onSetTerminalSize,
  onRestoreTask,
  onClearArchive,
  onClearBrowserData,
  onSetCaptureOptions,
  onCaptureShortcut,
  onSetShortcut,
  onResetShortcuts,
}: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [cliError, setCliError] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    window.desktop.cliStatus()
      .then((status) => { if (!cancelled) setCli(status); })
      .catch((cause) => { if (!cancelled) setCliError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, []);

  async function changeCli(install: boolean) {
    setCliBusy(true);
    setCliError(null);
    try {
      setCli(await (install ? window.desktop.installCli() : window.desktop.uninstallCli()));
    } catch (cause) {
      setCliError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCliBusy(false);
    }
  }

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
          <span>Back to Claudex</span>
        </button>
        <h1>Settings</h1>
        <nav aria-label="Settings sections">
          <button className={section === "theme" ? "active" : ""} type="button" aria-current={section === "theme" ? "page" : undefined} onClick={() => setSection("theme")}>
            <Palette size={17} aria-hidden="true" />
            <span>Theme</span>
          </button>
          <button className={section === "text" ? "active" : ""} type="button" aria-current={section === "text" ? "page" : undefined} onClick={() => setSection("text")}>
            <Type size={17} aria-hidden="true" />
            <span>Text</span>
          </button>
          <button className={section === "general" ? "active" : ""} type="button" aria-current={section === "general" ? "page" : undefined} onClick={() => setSection("general")}>
            <SlidersHorizontal size={17} aria-hidden="true" />
            <span>General</span>
          </button>
          <button className={section === "computer-use" ? "active" : ""} type="button" aria-current={section === "computer-use" ? "page" : undefined} onClick={() => setSection("computer-use")}>
            <MonitorCog size={17} aria-hidden="true" />
            <span>Computer use</span>
          </button>
          <button className={section === "usage" ? "active" : ""} type="button" aria-current={section === "usage" ? "page" : undefined} onClick={() => setSection("usage")}>
            <Gauge size={17} aria-hidden="true" />
            <span>Usage</span>
          </button>
          <button className={section === "shortcuts" ? "active" : ""} type="button" aria-current={section === "shortcuts" ? "page" : undefined} onClick={() => setSection("shortcuts")}>
            <Keyboard size={17} aria-hidden="true" />
            <span>Shortcuts</span>
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

      {section === "theme" && (
      <main className="settings-main">
        <ThemeSettings theme={theme} themeMode={themeMode} onSetFamily={onSetThemeFamily} onSetMode={onSetThemeMode} />
      </main>
      )}

      {section === "text" && (
      <main className="settings-main">
        <TextSettings
          uiFont={uiFont}
          monoFont={monoFont}
          readingSize={readingSize}
          terminalSize={terminalSize}
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
          <p>How Claudex answers from outside its own window.</p>
        </div>

        <section className="settings-group" aria-labelledby="cli-heading">
          <div className="settings-group-heading">
            <div>
              <h3 id="cli-heading">Terminal command</h3>
              <p>Run <code>{CLI_COMMAND}</code> in a folder to open it here as a project, or <code>{CLI_COMMAND} ~/code/app</code> to open another one.</p>
            </div>
          </div>

          <div className="setting-row">
            <span className={`setting-status ${cli?.state === "installed" ? "granted" : ""}`}>{cli?.state === "installed" && <Check size={13} />}</span>
            <div>
              <strong>{CLI_COMMAND}</strong>
              <p>{cliDescription(cli)}</p>
            </div>
            <div className="setting-row-action">
              {!cli && !cliError && <em>Checking…</em>}
              {cli?.state === "installed" && <button type="button" disabled={cliBusy} onClick={() => void changeCli(false)}>{cliBusy ? "Removing…" : "Uninstall"}</button>}
              {(cli?.state === "missing" || cli?.state === "conflict") && (
                <button type="button" disabled={cliBusy} onClick={() => void changeCli(true)}>
                  {cliBusy ? "Installing…" : cli.state === "conflict" ? "Replace it" : "Install"}
                </button>
              )}
            </div>
          </div>

          {cliError && <p className="settings-error" role="alert">{cliError}</p>}
        </section>

        <section className="settings-group" aria-labelledby="capture-heading">
          <div className="settings-group-heading">
            <div>
              <h3 id="capture-heading">Grabbing a window</h3>
              <p>The shortcut attaches the window you are in without taking you out of it.</p>
            </div>
          </div>

          <div className="setting-row">
            <span className={`setting-status ${captureSound ? "granted" : ""}`}>{captureSound && <Check size={13} />}</span>
            <div>
              <strong>Shutter sound</strong>
              <p>The only feedback that lands as the shot is taken, rather than a moment after it.</p>
            </div>
            <div className="setting-row-action">
              <button type="button" aria-pressed={captureSound} onClick={() => onSetCaptureOptions({ sound: !captureSound, focus: captureFocus })}>
                {captureSound ? "Turn off" : "Turn on"}
              </button>
            </div>
          </div>

          <div className="setting-row">
            <span className={`setting-status ${captureFocus ? "granted" : ""}`}>{captureFocus && <Check size={13} />}</span>
            <div>
              <strong>Come forward with the shot</strong>
              <p>Claudex takes the screen once the window is grabbed, with the caret already in the composer. Off leaves you where you were.</p>
            </div>
            <div className="setting-row-action">
              <button type="button" aria-pressed={captureFocus} onClick={() => onSetCaptureOptions({ sound: captureSound, focus: !captureFocus })}>
                {captureFocus ? "Turn off" : "Turn on"}
              </button>
            </div>
          </div>
        </section>
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

      {section === "shortcuts" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>Shortcuts</h2>
          <p>Every shortcut works wherever you are, including inside a page the browser panel is showing.</p>
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
                          ? <kbd>{displayShortcut(shortcut.binding, MAC)}</kbd>
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
          <p>The browser panel keeps one session for the whole app, so a site you sign into stays signed in everywhere Claudex works.</p>
        </div>

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
          <p>Archived threads stay here for 5 days, then Claudex deletes them on the next launch.</p>
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
          <p>Let Claudex see and control other applications when you ask it to.</p>
        </div>

        <section className="settings-group" aria-labelledby="permissions-heading" aria-live="polite">
          <div className="settings-group-heading">
            <div>
              <h3 id="permissions-heading">Permissions</h3>
              <p>Claudex needs both macOS permissions to operate other apps.</p>
            </div>
            <span className={ready ? "ready" : ""}>{ready ? "Setup complete" : "Setup required"}</span>
          </div>

          <div className="setting-row">
            <span className={`setting-status ${permissions?.accessibility ? "granted" : ""}`}>{permissions?.accessibility && <Check size={13} />}</span>
            <div>
              <strong>Accessibility</strong>
              <p>Allows Claudex to click, type, and navigate apps.</p>
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
              <p>Allows Claudex to see app windows. System audio is not recorded.</p>
            </div>
            <div className="setting-row-action">
              {permissions?.screenRecording ? <em className="granted">Done</em> : !permissions && <em>Checking…</em>}
              {permissions && !permissions.screenRecording && <button type="button" disabled={busy !== null} onClick={() => void enable("screenRecording")}>{busy === "screenRecording" ? "Opening…" : "Enable Screen Recording"}</button>}
            </div>
          </div>

          {error && <p className="settings-error" role="alert">{error}</p>}
          {restartRequired && <div className="settings-restart"><p>Restart Claudex to finish enabling computer use.</p><button type="button" onClick={() => window.desktop.restartForComputerUse()}>Restart Claudex</button></div>}
        </section>

        <p className="settings-privacy">Permission checks capture one frame and discard it immediately.</p>
      </main>
      )}
    </section>
  );
}
