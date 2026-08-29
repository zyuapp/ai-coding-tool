import { useEffect, useState } from "react";
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
  /** Whether runs reach the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  onSetChromeBrowser: (enabled: boolean) => void;
  /** Whether a thread that needs the user announces itself on the desktop. */
  notifications: boolean;
  onSetNotifications: (enabled: boolean) => void;
};

export function GeneralSettings({ chromeBrowser, onSetChromeBrowser, notifications, onSetNotifications }: GeneralSettingsProps) {
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [cliError, setCliError] = useState<string | null>(null);

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

  return (
    <>
      <section className="settings-group" aria-labelledby="cli-heading">
        <div className="settings-group-heading">
          <div>
            <h3 id="cli-heading">Terminal command</h3>
            <p>Run <code>{CLI_COMMAND}</code> in a folder to open it here as a project, or <code>{CLI_COMMAND} ~/code/app</code> to open another one.</p>
          </div>
        </div>

        <SettingRow id="general.cli" status={cli?.state === "installed"} description={cliDescription(cli)}>
          {!cli && !cliError && <em>Checking…</em>}
          {cli?.state === "installed" && <button type="button" disabled={cliBusy} onClick={() => void changeCli(false)}>{cliBusy ? "Removing…" : "Uninstall"}</button>}
          {(cli?.state === "missing" || cli?.state === "conflict") && (
            <button type="button" disabled={cliBusy} onClick={() => void changeCli(true)}>
              {cliBusy ? "Installing…" : cli.state === "conflict" ? "Replace it" : "Install"}
            </button>
          )}
        </SettingRow>

        {cliError && <p className="settings-error" role="alert">{cliError}</p>}
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
      </section>
    </>
  );
}
