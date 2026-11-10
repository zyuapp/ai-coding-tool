import type { ComputerUseAccessState } from "../../application/computer-use-access";
import type { ComputerUsePermission } from "../../contracts/ipc";
import { AvailabilitySection } from "./AvailabilitySection";
import { SettingRow } from "./SettingRow";
import { SettingsPage, SettingsSection } from "./SettingsLayout";
import { Button } from "../ui/Button";

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
  const failure = error && <p className="settings-error" role="alert">{error}</p>;
  return (
    <SettingsPage title="Computer use" description="Let AI Coding Tool see and control other applications when you ask it to.">
      <AvailabilitySection id="computer-use.availability" enabled={computerUse} onChange={onSetComputerUse}
        description={mac
          ? "The agent can see and operate other applications. Off leaves it no way to reach them, whatever the permissions below say."
          : "The agent can see and operate other applications. Off leaves it no way to reach them, whatever the platform setup below says."} />

      {!permissions && !mac ? (
      <SettingsSection title="Platform setup" description="Checking what this computer can use…" aria-live="polite" badge={<span className="neutral">Checking…</span>}>
        {failure}
      </SettingsSection>
      ) : linux ? (
      <SettingsSection title="Linux runtime" description={linux.message} aria-live="polite" badge={<span className={ready ? "ready" : ""}>{linux.status === "available" ? "Ready" : linux.status === "limited" ? "Compositor-dependent" : "Unavailable"}</span>}>
        {failure}
      </SettingsSection>
      ) : mac ? (
      <SettingsSection title="Permissions" description="AI Coding Tool needs both macOS permissions to operate other apps." aria-live="polite" badge={<span className={ready ? "ready" : ""}>{ready ? "Setup complete" : "Setup required"}</span>}>
        <SettingRow id="computer-use.accessibility" status={Boolean(permissions?.accessibility)} description="Allows AI Coding Tool to click, type, and navigate apps.">
          {permissions?.accessibility ? <em className="granted">Done</em> : !permissions && <em>Checking…</em>}
          {permissions && !permissions.accessibility && <Button disabled={busy !== null} aria-busy={busy === "accessibility"} onClick={() => onEnable("accessibility")}>{busy === "accessibility" ? "Opening…" : "Enable Accessibility"}</Button>}
        </SettingRow>

        <SettingRow id="computer-use.screen-recording" status={Boolean(permissions?.screenRecording)} description="Allows AI Coding Tool to see app windows. System audio is not recorded.">
          {permissions?.screenRecording ? <em className="granted">Done</em> : !permissions && <em>Checking…</em>}
          {permissions && !permissions.screenRecording && <Button disabled={busy !== null} aria-busy={busy === "screenRecording"} onClick={() => onEnable("screenRecording")}>{busy === "screenRecording" ? "Opening…" : "Enable Screen Recording"}</Button>}
        </SettingRow>

        {failure}
        {restartRequired && <div className="settings-restart"><p>Restart AI Coding Tool to finish enabling computer use.</p><Button onClick={onRestart}>Restart AI Coding Tool</Button></div>}
      </SettingsSection>
      ) : (
      <SettingsSection title="Platform setup" description="Computer use is not available on this platform." aria-live="polite" badge={<span className="neutral">Unavailable</span>}>
        {failure}
      </SettingsSection>
      )}

      {mac && <p className="settings-privacy">Permission checks capture one frame and discard it immediately.</p>}
    </SettingsPage>
  );
}
