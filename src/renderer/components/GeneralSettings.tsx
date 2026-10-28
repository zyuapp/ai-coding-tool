import { useEffect } from "react";
import { LuLoaderCircle as LoaderCircle } from "react-icons/lu";
import type { CliState } from "../../application/cli-installation";
import { CLI_COMMAND, CLI_INSTALL_PATH, type CliStatus } from "../../domain/cli";
import { NO_APP_UPDATE, type AppUpdate } from "../../domain/app-update";
import { ConfirmAction, SettingRow, SettingSwitch } from "./SettingRow";
import { SpinningIcon } from "./SpinningIcon";

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

/** A newer build as the updater last reported it, and the steps that take it. `version` is the build running now. */
export type AppUpdateSettings = { state: AppUpdate; version?: string | null; onDownload: () => void; onInstall: () => void };

export const NO_APP_UPDATE_SETTINGS: AppUpdateSettings = { state: NO_APP_UPDATE, onDownload() {}, onInstall() {} };

function updateDescription(update: AppUpdate, current: string | null | undefined) {
  switch (update.status) {
    case "available": return `Version ${update.version} is available.`;
    case "downloading": return `Downloading version ${update.version}.`;
    case "ready": return `Version ${update.version} is downloaded. Restart to install it.`;
    default: return current ? `Version ${current}.` : null;
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
  /** Whether a thread that needs the user announces itself on the desktop. */
  notifications: boolean;
  onSetNotifications: (enabled: boolean) => void;
  onCheckForUpdates: () => void;
  update?: AppUpdateSettings;
  onOpenSourceLicenses: () => void;
};

export function GeneralSettings({ cli: { status, busy, error }, onReadCli, onSetCliInstalled, chromeBrowser, onSetChromeBrowser, notifications, onSetNotifications, onCheckForUpdates, update = NO_APP_UPDATE_SETTINGS, onOpenSourceLicenses }: GeneralSettingsProps) {
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
          {!status && !error && <em><SpinningIcon icon={LoaderCircle} spinning size={12} aria-hidden="true" />Checking…</em>}
          {status?.state === "installed" && status.current === false && <button type="button" disabled={busy} onClick={() => onSetCliInstalled(true)}>{busy ? "Updating…" : "Update"}</button>}
          {status?.state === "installed" && <ConfirmAction disabled={busy} confirm={`Uninstall ${CLI_COMMAND}`} onConfirm={() => onSetCliInstalled(false)}>{busy ? "Removing…" : "Uninstall"}</ConfirmAction>}
          {status?.state === "missing" && <button type="button" disabled={busy} onClick={() => onSetCliInstalled(true)}>{busy ? "Installing…" : "Install"}</button>}
          {status?.state === "conflict" && <ConfirmAction disabled={busy} confirm={`Replace ${status.path}`} onConfirm={() => onSetCliInstalled(true)}>{busy ? "Installing…" : "Replace it"}</ConfirmAction>}
        </SettingRow>

        {error && <p className="settings-error" role="alert">{error}</p>}
      </section>

      <section className="settings-group" aria-labelledby="notifications-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="notifications-heading">Notifications</h3>
          </div>
        </div>

        <SettingRow id="general.notifications" description="When a run finishes, fails, or needs permission in a thread you are away from.">
          <SettingSwitch id="general.notifications" on={notifications} onChange={onSetNotifications} />
        </SettingRow>
      </section>

      <section className="settings-group" aria-labelledby="claude-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="claude-heading">Claude</h3>
            <p>Experimental settings that only Claude threads read. They can change or disappear.</p>
          </div>
        </div>

        <SettingRow id="general.chrome-browser" description="Claude drives the Chrome you already have open, instead of the browser panel, when you ask for your own browser. Needs the Claude in Chrome extension, and Chrome running.">
          <SettingSwitch id="general.chrome-browser" on={chromeBrowser} onChange={onSetChromeBrowser} />
        </SettingRow>
      </section>

      <section className="settings-group" aria-labelledby="app-heading">
        <div className="settings-group-heading">
          <h3 id="app-heading">AI Coding Tool</h3>
        </div>
        <SettingRow id="general.updates" description={updateDescription(update.state, update.version)}>
          {update.state.status === "idle" && <button type="button" onClick={onCheckForUpdates}>Check for updates</button>}
          {update.state.status === "available" && <button type="button" onClick={update.onDownload}>Download</button>}
          {update.state.status === "downloading" && <em role="status"><SpinningIcon icon={LoaderCircle} spinning size={12} aria-hidden="true" />{update.state.percent}%</em>}
          {update.state.status === "ready" && <button type="button" onClick={update.onInstall}>Restart to update</button>}
        </SettingRow>
        <SettingRow id="general.licenses" description={null}>
          <button type="button" onClick={onOpenSourceLicenses}>View licenses</button>
        </SettingRow>
      </section>
    </>
  );
}
