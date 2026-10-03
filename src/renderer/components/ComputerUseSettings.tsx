import type { ComputerUseAccessState } from "../../application/computer-use-access";
import type { ComputerUsePermission } from "../../contracts/ipc";
import { AvailabilitySection } from "./AvailabilitySection";
import { SettingRow } from "./SettingRow";

export type ComputerUseSettingsProps = {
  /** Whether a run may see and operate other applications. */
  computerUse: boolean;
  onSetComputerUse: (enabled: boolean) => void;
  /** What the platform allows, and what the page is waiting on. */
  access: ComputerUseAccessState;
  onEnable: (permission: ComputerUsePermission) => void;
  onRestart: () => void;
};

export function ComputerUseSettings({ computerUse, onSetComputerUse, access: { permissions, busy, error, restartRequired }, onEnable, onRestart }: ComputerUseSettingsProps) {
  const linux = permissions?.linuxRuntime;
  const mac = window.desktop.platform === "macos";
  const ready = linux ? linux.status !== "unavailable" : Boolean(permissions?.accessibility && permissions.screenRecording);
  return (
    <main className="settings-main">
      <div className="settings-page-heading">
        <h2>Computer use</h2>
        <p>Let AI Coding Tool see and control other applications when you ask it to.</p>
      </div>

      <AvailabilitySection id="computer-use.availability" enabled={computerUse} onChange={onSetComputerUse}
        description={mac
          ? "The agent can see and operate other applications. Off leaves it no way to reach them, whatever the permissions below say."
          : "The agent can see and operate other applications. Off leaves it no way to reach them, whatever the platform setup below says."} />

      {!permissions && !mac ? (
      <section className="settings-group" aria-labelledby="runtime-heading" aria-live="polite">
        <div className="settings-group-heading">
          <div>
            <h3 id="runtime-heading">Platform setup</h3>
            <p>Checking what this computer can use…</p>
          </div>
          <span>Checking…</span>
        </div>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </section>
      ) : linux ? (
      <section className="settings-group" aria-labelledby="runtime-heading" aria-live="polite">
        <div className="settings-group-heading">
          <div>
            <h3 id="runtime-heading">Linux runtime</h3>
            <p>{linux.message}</p>
          </div>
          <span className={ready ? "ready" : ""}>{linux.status === "available" ? "Ready" : linux.status === "limited" ? "Compositor-dependent" : "Unavailable"}</span>
        </div>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </section>
      ) : mac ? (
      <section className="settings-group" aria-labelledby="permissions-heading" aria-live="polite">
        <div className="settings-group-heading">
          <div>
            <h3 id="permissions-heading">Permissions</h3>
            <p>AI Coding Tool needs both macOS permissions to operate other apps.</p>
          </div>
          <span className={ready ? "ready" : ""}>{ready ? "Setup complete" : "Setup required"}</span>
        </div>

        <SettingRow id="computer-use.accessibility" status={Boolean(permissions?.accessibility)} description="Allows AI Coding Tool to click, type, and navigate apps.">
          {permissions?.accessibility ? <em className="granted">Done</em> : !permissions && <em>Checking…</em>}
          {permissions && !permissions.accessibility && <button type="button" disabled={busy !== null} onClick={() => onEnable("accessibility")}>{busy === "accessibility" ? "Opening…" : "Enable Accessibility"}</button>}
        </SettingRow>

        <SettingRow id="computer-use.screen-recording" status={Boolean(permissions?.screenRecording)} description="Allows AI Coding Tool to see app windows. System audio is not recorded.">
          {permissions?.screenRecording ? <em className="granted">Done</em> : !permissions && <em>Checking…</em>}
          {permissions && !permissions.screenRecording && <button type="button" disabled={busy !== null} onClick={() => onEnable("screenRecording")}>{busy === "screenRecording" ? "Opening…" : "Enable Screen Recording"}</button>}
        </SettingRow>

        {error && <p className="settings-error" role="alert">{error}</p>}
        {restartRequired && <div className="settings-restart"><p>Restart AI Coding Tool to finish enabling computer use.</p><button type="button" onClick={onRestart}>Restart AI Coding Tool</button></div>}
      </section>
      ) : (
      <section className="settings-group" aria-labelledby="runtime-heading" aria-live="polite">
        <div className="settings-group-heading">
          <div>
            <h3 id="runtime-heading">Platform setup</h3>
            <p>Computer use is not available on this platform.</p>
          </div>
          <span>Unavailable</span>
        </div>
        {error && <p className="settings-error" role="alert">{error}</p>}
      </section>
      )}

      {mac && <p className="settings-privacy">Permission checks capture one frame and discard it immediately.</p>}
    </main>
  );
}
