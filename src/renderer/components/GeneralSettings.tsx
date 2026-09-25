import { useEffect } from "react";
import type { CliState } from "../../application/cli-installation";
import { CLI_COMMAND, CLI_INSTALL_PATH, type CliStatus } from "../../domain/cli";
import { SettingRow } from "./SettingRow";

function cliDescription(status: CliStatus | null) {
  if (!status) return "Looking for the command…";
  switch (status.state) {
    case "installed": return status.onPath === false
      ? `Installed at ${status.path}. Add its folder to PATH to run ${CLI_COMMAND} by name.`
      : `Installed at ${status.path}.`;
    case "conflict": return `Something else already answers to ${CLI_COMMAND} at ${status.path}.`;
    case "unsupported": return "The command can only be installed on macOS or Linux.";
    default: return status.path === CLI_INSTALL_PATH
      ? `Goes in ${status.path}, which asks for your password once.`
      : `Goes in ${status.path}, inside your user account.`;
  }
}

export type GeneralSettingsProps = {
  /** The terminal command: where it stands, whether it is being changed, and what stopped the last try. */
  cli: CliState;
  onReadCli: () => void;
  onSetCliInstalled: (installed: boolean) => void;
  /** Whether runs reach the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  onSetChromeBrowser: (enabled: boolean) => void;
  /** Whether Claude threads answer under the concise ruleset. */
  conciseReplies: boolean;
  onSetConciseReplies: (enabled: boolean) => void;
  /** Whether a thread that needs the user announces itself on the desktop. */
  notifications: boolean;
  onSetNotifications: (enabled: boolean) => void;
  onCheckForUpdates: () => void;
  onOpenSourceLicenses: () => void;
};

export function GeneralSettings({ cli: { status, busy, error }, onReadCli, onSetCliInstalled, chromeBrowser, onSetChromeBrowser, conciseReplies, onSetConciseReplies, notifications, onSetNotifications, onCheckForUpdates, onOpenSourceLicenses }: GeneralSettingsProps) {
  useEffect(() => { onReadCli(); }, []);

  return (
    <>
      <section className="settings-group" aria-labelledby="cli-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="cli-heading">Terminal command</h3>
            <p>Run <code>{CLI_COMMAND}</code> in a folder to open it here as a project, or <code>{CLI_COMMAND} ~/code/app</code> to open another one.</p>
          </div>
        </div>

        <SettingRow id="general.cli" status={status?.state === "installed"} description={cliDescription(status)}>
          {!status && !error && <em>Checking…</em>}
          {status?.state === "installed" && status.current === false && <button type="button" disabled={busy} onClick={() => onSetCliInstalled(true)}>{busy ? "Updating…" : "Update"}</button>}
          {status?.state === "installed" && <button type="button" disabled={busy} onClick={() => onSetCliInstalled(false)}>{busy ? "Removing…" : "Uninstall"}</button>}
          {(status?.state === "missing" || status?.state === "conflict") && (
            <button type="button" disabled={busy} onClick={() => onSetCliInstalled(true)}>
              {busy ? "Installing…" : status.state === "conflict" ? "Replace it" : "Install"}
            </button>
          )}
        </SettingRow>

        {error && <p className="settings-error" role="alert">{error}</p>}
      </section>

      <section className="settings-group" aria-labelledby="notifications-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="notifications-heading">Notifications</h3>
          </div>
        </div>

        <SettingRow id="general.notifications" status={notifications} description="When a run finishes, fails, or needs permission in a thread you are away from.">
          <button type="button" role="switch" aria-checked={notifications} onClick={() => onSetNotifications(!notifications)}>{notifications ? "Turn off" : "Turn on"}</button>
        </SettingRow>
      </section>

      <section className="settings-group" aria-labelledby="claude-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="claude-heading">Claude</h3>
            <p>Experimental settings that only Claude threads read. They can change or disappear.</p>
          </div>
        </div>

        <SettingRow id="general.chrome-browser" status={chromeBrowser} description="Claude drives the Chrome you already have open, instead of the browser panel, when you ask for your own browser. Needs the Claude in Chrome extension, and Chrome running.">
          <button type="button" role="switch" aria-checked={chromeBrowser} onClick={() => onSetChromeBrowser(!chromeBrowser)}>{chromeBrowser ? "Turn off" : "Turn on"}</button>
        </SettingRow>

        <SettingRow id="general.concise-replies" status={conciseReplies} description="Claude leads with the answer and keeps it short. Ask it to expand and it still will.">
          <button type="button" role="switch" aria-checked={conciseReplies} onClick={() => onSetConciseReplies(!conciseReplies)}>{conciseReplies ? "Turn off" : "Turn on"}</button>
        </SettingRow>
      </section>

      <section className="settings-group" aria-labelledby="app-heading">
        <div className="settings-group-heading">
          <h3 id="app-heading">AI Coding Tool</h3>
        </div>
        <SettingRow id="general.updates" description={null}>
          <button type="button" onClick={onCheckForUpdates}>Check for updates</button>
        </SettingRow>
        <SettingRow id="general.licenses" description={null}>
          <button type="button" onClick={onOpenSourceLicenses}>View licenses</button>
        </SettingRow>
      </section>
    </>
  );
}
