import { Archive, ArrowLeft, Check, Gauge, Globe, MonitorCog } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComputerUsePermission, ComputerUsePermissions } from "../../contracts/ipc";
import { ARCHIVE_RETENTION_MS, type Task } from "../../domain/task";
import { UsageSettings } from "./UsageSettings";

type SettingsSection = "computer-use" | "usage" | "browser" | "archive";

function daysLeft(archivedAt: number) {
  const remaining = Math.ceil((archivedAt + ARCHIVE_RETENTION_MS - Date.now()) / 86_400_000);
  if (remaining <= 0) return "Deletes on next launch";
  return remaining === 1 ? "Deletes in 1 day" : `Deletes in ${remaining} days`;
}

export type SettingsPanelProps = {
  onClose: () => void;
  archivedTasks: Task[];
  /** How many sites a run may open without asking, which clearing the session takes back. */
  allowedOrigins: string[];
  onRestoreTask: (taskId: string) => void;
  onClearArchive: () => void;
  onClearBrowserData: () => void;
};

export function SettingsPanel({ onClose, archivedTasks, allowedOrigins, onRestoreTask, onClearArchive, onClearBrowserData }: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>("computer-use");
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);
  const [permissions, setPermissions] = useState<ComputerUsePermissions | null>(null);
  const [busy, setBusy] = useState<ComputerUsePermission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const requested = useRef(false);

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
    <section className="settings-view" aria-label="Settings">
      <aside className="settings-sidebar">
        <div className="settings-traffic-space" aria-hidden="true" />
        <button className="settings-back" type="button" autoFocus onClick={onClose}>
          <ArrowLeft size={17} aria-hidden="true" />
          <span>Back to Claudex</span>
        </button>
        <h1>Settings</h1>
        <nav aria-label="Settings sections">
          <button className={section === "computer-use" ? "active" : ""} type="button" aria-current={section === "computer-use" ? "page" : undefined} onClick={() => setSection("computer-use")}>
            <MonitorCog size={17} aria-hidden="true" />
            <span>Computer use</span>
          </button>
          <button className={section === "usage" ? "active" : ""} type="button" aria-current={section === "usage" ? "page" : undefined} onClick={() => setSection("usage")}>
            <Gauge size={17} aria-hidden="true" />
            <span>Usage</span>
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

      {section === "usage" && (
      <main className="settings-main">
        <div className="settings-page-heading">
          <h2>Usage</h2>
          <p>What Claude has spent of the limits your plan resets on a clock.</p>
        </div>

        <UsageSettings />
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
                    <button className="danger" type="button" onClick={() => {
                      onClearBrowserData();
                      setConfirmingSignOut(false);
                    }}>Sign out of everything</button>
                    <button type="button" onClick={() => setConfirmingSignOut(false)}>Cancel</button>
                  </>
                : <button type="button" onClick={() => setConfirmingSignOut(true)}>Clear browser data</button>}
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
                    <button className="danger" type="button" onClick={() => {
                      onClearArchive();
                      setConfirmingClear(false);
                    }}>Delete all</button>
                    <button type="button" onClick={() => setConfirmingClear(false)}>Cancel</button>
                  </>
                : <button type="button" onClick={() => setConfirmingClear(true)}>Clear all</button>)}
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
