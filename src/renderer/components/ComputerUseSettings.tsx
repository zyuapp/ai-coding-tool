import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComputerUsePermission, ComputerUsePermissions } from "../../contracts/ipc";
import { AvailabilitySection } from "./AvailabilitySection";

/** What macOS has granted, watched while settings is open because it is granted in another app. */
export function useComputerUsePermissions() {
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

  return { permissions, busy, error, restartRequired, enable };
}

export type ComputerUseSettingsProps = {
  /** Whether a run may see and operate other applications. */
  computerUse: boolean;
  onSetComputerUse: (enabled: boolean) => void;
} & ReturnType<typeof useComputerUsePermissions>;

export function ComputerUseSettings({ computerUse, onSetComputerUse, permissions, busy, error, restartRequired, enable }: ComputerUseSettingsProps) {
  const ready = Boolean(permissions?.accessibility && permissions.screenRecording);
  return (
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
  );
}
