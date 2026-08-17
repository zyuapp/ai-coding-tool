import { ArrowLeft, Check, MonitorCog } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComputerUsePermissions } from "../../contracts/ipc";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [permissions, setPermissions] = useState<ComputerUsePermissions | null>(null);
  const [busy, setBusy] = useState(false);
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

  async function enable() {
    setBusy(true);
    setError(null);
    requested.current = true;
    try {
      const next = await window.desktop.enableComputerUse();
      setPermissions(next);
      if (next.accessibility && next.screenRecording) setRestartRequired(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(permissions?.accessibility && permissions.screenRecording);
  const action = permissions?.accessibility ? "Open System Settings" : "Enable Accessibility";

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
          <button className="active" type="button" aria-current="page">
            <MonitorCog size={17} aria-hidden="true" />
            <span>Computer use</span>
          </button>
        </nav>
      </aside>

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
            <span className={ready ? "ready" : ""}>{ready ? "Ready" : "Setup required"}</span>
          </div>

          <div className="setting-row">
            <span className={`setting-status ${permissions?.accessibility ? "granted" : ""}`}>{permissions?.accessibility && <Check size={13} />}</span>
            <div>
              <strong>Accessibility</strong>
              <p>Allows Claudex to click, type, and navigate apps.</p>
            </div>
            <div className="setting-row-action">
              <em className={permissions?.accessibility ? "granted" : ""}>{permissions ? (permissions.accessibility ? "Enabled" : "Required") : "Checking…"}</em>
              {permissions && !permissions.accessibility && <button type="button" disabled={busy} onClick={() => void enable()}>{busy ? "Opening…" : action}</button>}
            </div>
          </div>

          <div className="setting-row">
            <span className={`setting-status ${permissions?.screenRecording ? "granted" : ""}`}>{permissions?.screenRecording && <Check size={13} />}</span>
            <div>
              <strong>Screen &amp; System Audio Recording</strong>
              <p>Allows Claudex to see app windows. System audio is not recorded.</p>
            </div>
            <div className="setting-row-action">
              <em className={permissions?.screenRecording ? "granted" : ""}>{permissions ? (permissions.screenRecording ? "Enabled" : "Required") : "Checking…"}</em>
              {permissions?.accessibility && !permissions.screenRecording && <button type="button" disabled={busy} onClick={() => void enable()}>{busy ? "Opening…" : action}</button>}
            </div>
          </div>

          {error && <p className="settings-error" role="alert">{error}</p>}
          {restartRequired && <div className="settings-restart"><p>Restart Claudex to finish enabling computer use.</p><button type="button" onClick={() => window.desktop.restartForComputerUse()}>Restart Claudex</button></div>}
        </section>

        <p className="settings-privacy">Permission checks capture one frame and discard it immediately.</p>
      </main>
    </section>
  );
}
